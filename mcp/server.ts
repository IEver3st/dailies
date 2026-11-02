import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const REPO = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Dailies");
const DAEMON_FILE = join(APP_DIR, "daemon.json");
const T3_CLI = process.env.T3CODE_CLI_PATH ?? join(homedir(), ".t3", "bin", "t3.cmd");
const IN_T3 = !!process.env.T3CODE_THREAD_ID;

function ownerName(): string | undefined {
  try {
    const name = JSON.parse(readFileSync(join(APP_DIR, "settings.json"), "utf8")).owner;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

const OWNER = ownerName();
const WHO = OWNER ?? "the user";
const WHOSE = OWNER ? `${OWNER}'s` : "the user's";

type DaemonInfo = { port: number; token: string };

class DailiesError extends Error {}

function readInfo(): DaemonInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(DAEMON_FILE, "utf8"));
    return info.port && info.token ? { port: info.port, token: info.token } : undefined;
  } catch {
    return undefined;
  }
}

async function healthy(info: DaemonInfo | undefined): Promise<boolean> {
  if (!info) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { "x-dailies-token": info.token }, signal: AbortSignal.timeout(1500) });
    const j: any = await r.json();
    return j.app === "dailies" && j.authed === true;
  } catch {
    return false;
  }
}

function launchCommand(): { commandLine: string; cwd: string } {
  const packaged = [
    process.env.DAILIES_APP,
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Dailies", "Dailies.exe"),
    join(REPO, "dist", "win-unpacked", "Dailies.exe"),
  ].find((p): p is string => !!p && existsSync(p));
  if (packaged) return { commandLine: `"${packaged}" --background`, cwd: dirname(packaged) };
  const electron = join(REPO, "node_modules", "electron", "dist", "electron.exe");
  if (existsSync(electron) && existsSync(join(REPO, "out", "main", "index.js"))) return { commandLine: `"${electron}" "${REPO}" --background`, cwd: REPO };
  return { commandLine: `"${process.execPath}" "${join(REPO, "daemon", "main.ts")}"`, cwd: REPO };
}

async function launchOutsideJob() {
  const { commandLine, cwd } = launchCommand();
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${cwd.replace(/'/g, "''")}' }; $r.ReturnValue`;
  const p = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (out.trim() !== "0") throw new DailiesError(`could not start Dailies (${commandLine}): ${(err || out).trim()}`);
}

let starting: Promise<DaemonInfo> | undefined;
async function daemon(): Promise<DaemonInfo> {
  const info = readInfo();
  if (await healthy(info)) return info!;
  starting ??= (async () => {
    await launchOutsideJob();
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      await Bun.sleep(400);
      const next = readInfo();
      if (await healthy(next)) return next!;
    }
    throw new DailiesError("Dailies did not come up within 45 s. Start it from the Start menu or run `bun daemon/main.ts` in the Dailies repo.");
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

let clientId = "";
function clientHeader() {
  if (clientId) return clientId;
  const c = server.server.getClientVersion();
  return c?.name ? `${c.name}/${c.version ?? ""}` : "";
}

async function call(path: string, body?: Record<string, unknown>): Promise<any> {
  const info = await daemon();
  const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-dailies-token": info.token, "content-type": "application/json", "x-dailies-client": clientHeader(), "x-dailies-t3": IN_T3 ? "1" : "0" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(70_000),
  });
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  if (!r.ok) throw new DailiesError(data?.error ?? `Dailies returned ${r.status}`);
  return data;
}

type Thread = { id?: string; title?: string; link?: string };
let threadInfo: Promise<Thread> | undefined;
function thread(): Promise<Thread> {
  threadInfo ??= (async () => {
    const id = process.env.T3CODE_THREAD_ID;
    if (!id || !existsSync(T3_CLI)) return { id };
    try {
      const m = /^\s*"([^"]+\.exe)"\s+"([^"]+\.m?js)"\s+%\*/im.exec(readFileSync(T3_CLI, "utf8"));
      if (!m) return { id };
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3CODE_CLI_PATH: T3_CLI, T3CODE_HOME: process.env.T3CODE_HOME ?? join(homedir(), ".t3"), T3CODE_DESKTOP_CLI_LAUNCHER: "1" };
      const p = Bun.spawn([m[1], m[2], "thread", "show", id, "--json"], { stdout: "pipe", stderr: "ignore", env, windowsHide: true });
      const timer = setTimeout(() => p.kill(), 8000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      const t = JSON.parse(out).thread;
      return { id, title: t?.title, link: t?.link };
    } catch {
      return { id };
    }
  })();
  return threadInfo;
}

async function agentName(explicit?: string) {
  if (explicit?.trim()) return explicit.trim().slice(0, 60);
  if (process.env.DAILIES_AGENT) return process.env.DAILIES_AGENT;
  const t = await thread();
  if (t.title) return t.title.length > 48 ? `${t.title.slice(0, 47).trimEnd()}...` : t.title;
  return "Agent";
}

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...text({ error: msg }), isError: true };
  }
}

const cut = z.string().describe("The cut: its .tsrct path or the id returned by dailies_open.");
const agent = z.string().optional().describe("Your display name in Dailies. Defaults to your T3 thread's title.");

const wake = IN_T3
  ? `When you end your turn, Dailies messages your T3 thread when ${WHO} sends notes or approves; dailies_wait is only for staying in the loop within a turn.`
  : `Dailies cannot wake this session. When you hand a revision over, end your turn and ask ${WHO} to message you after sending notes, or stay in the loop with dailies_wait while you iterate together.`;

const server = new McpServer(
  { name: "dailies", version: "0.1.0" },
  {
    instructions: [
      `Dailies is ${WHOSE} review room for Tesseract (.tsrct) videos. It renders every saved revision of a cut with hardware playback, and ${WHO} leaves timestamped notes, frame drawings and direct edits there. Use it whenever you make or revise a .tsrct video ${WHO} will watch, instead of exporting drafts.`,
      `Loop: dailies_open the .tsrct when you start (${WHO} sees it live; read any open notes first), dailies_status while you work, edit and save the project with the tsrct CLI as usual, then dailies_publish with a one-line summary and the ids of the notes you addressed. Read feedback with dailies_feedback, look at its frame and markedFrame PNGs, and answer notes with dailies_reply.`,
      `Edits ${WHO} made in Dailies are already in the .tsrct: if the project is built from a generator script or config, fold them into it before rebuilding, or the rebuild reverts them. Never edit the .dailies folder next to a cut. Use dailies_frame instead of \`tsrct preview\`: it returns the frame exactly as Dailies rendered it. dailies_check reports what Dailies can see on this PC.`,
      wake,
    ].join("\n\n"),
  },
);

server.registerTool(
  "dailies_open",
  {
    title: "Open a cut in Dailies",
    description: `Register a .tsrct with Dailies${IN_T3 ? `, link it to your T3 thread so ${WHOSE} notes reach you` : ""}, show it in the app and start rendering. Call this when you begin work on a video.`,
    inputSchema: { path: z.string().describe("Absolute path to the .tsrct file."), message: z.string().optional().describe("What you are about to do, shown in the activity feed."), agent },
  },
  ({ path, message, agent: name }) =>
    guarded(async () => {
      const t = await thread();
      const r = await call("/api/agent/open", { path: resolve(path), message, agent: await agentName(name), thread: t.id, threadLink: t.link });
      return text({
        ...r,
        next: r.openNotes
          ? `There are ${r.openNotes} open notes. Read them with dailies_feedback before editing.`
          : "Work on the cut, then call dailies_publish with a summary when the .tsrct is saved.",
        threadLinked: !!t.id,
      });
    }),
);

server.registerTool(
  "dailies_status",
  {
    title: "Post your status",
    description: `Tell ${WHO} what you are doing on a cut. state working queues their direct edits instead of writing the file under you; ready means a revision is worth watching; blocked means you need them.`,
    inputSchema: { cut, state: z.enum(["working", "ready", "blocked", "idle"]), message: z.string().describe("One short line, e.g. 'retiming the hook to the beat'."), agent },
  },
  ({ cut, state, message, agent: name }) =>
    guarded(async () => {
      const t = await thread();
      return text(await call("/api/agent/status", { cut, state, message, agent: await agentName(name), thread: t.id, threadLink: t.link }));
    }),
);

server.registerTool(
  "dailies_publish",
  {
    title: "Publish a revision",
    description: "Call after you saved or committed the .tsrct, even if Dailies already picked the save up. It credits the newest unpublished revision to you with your summary, renders only the changed seconds, and marks the listed notes addressed. A warning means nothing new was on disk.",
    inputSchema: {
      cut,
      summary: z.string().describe("One line on what changed, e.g. 'Hook caption shortened, music -3 dB'."),
      addresses: z.array(z.string()).optional().describe("Ids of the notes this revision addresses."),
      agent,
    },
  },
  ({ cut, summary, addresses, agent: name }) =>
    guarded(async () => {
      const t = await thread();
      return text(await call("/api/agent/publish", { cut, summary, addresses, agent: await agentName(name), thread: t.id, threadLink: t.link }));
    }),
);

server.registerTool(
  "dailies_feedback",
  {
    title: `Read ${WHOSE} feedback`,
    description:
      `Notes and direct edits on a cut: time, text, the layers visible at that moment, the frame ${WHO} looked at and their drawing on it (PNG paths you can read), structured suggestions and exact engine actions. Default is what still needs action.`,
    inputSchema: {
      cut,
      status: z.enum(["actionable", "all", "open", "claimed", "addressed", "resolved", "wontfix"]).optional(),
      since: z.string().optional().describe("ISO time; only notes updated after it."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ cut, status, since }) => guarded(async () => text(await call("/api/agent/feedback", { cut, status, since }))),
);

server.registerTool(
  "dailies_wait",
  {
    title: "Wait for feedback",
    description: `Block up to 50 s until ${WHO} sends notes, replies or approves. Use it only while you are actively iterating together; otherwise end your turn.`,
    inputSchema: { cut, since: z.string().optional().describe("ISO time from your last wait or feedback call."), timeoutSec: z.number().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  },
  ({ cut, since, timeoutSec }) => guarded(async () => text(await call("/api/agent/wait", { cut, since, timeoutSec: timeoutSec ?? 45 }))),
);

server.registerTool(
  "dailies_reply",
  {
    title: "Reply to a note",
    description: "Answer a note in its thread. status claimed = you are on it; addressed = done (prefer dailies_publish addresses for changes); wontfix = explain why not.",
    inputSchema: { cut, note: z.string(), text: z.string(), status: z.enum(["claimed", "addressed", "wontfix"]).optional(), agent },
  },
  ({ cut, note, text: body, status, agent: name }) => guarded(async () => text(await call("/api/agent/reply", { cut, note, text: body, status, agent: await agentName(name) }))),
);

server.registerTool(
  "dailies_frame",
  {
    title: "Get a rendered frame",
    description: "PNG path of a frame of the cut as Dailies rendered it. Fast from the render cache; exact=true renders that single frame with the CLI at full quality. Use this instead of `tsrct preview`.",
    inputSchema: { cut, t: z.number().describe("Time in ms."), revision: z.number().int().optional(), exact: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  ({ cut, t, revision, exact }) => guarded(async () => text(await call("/api/agent/frame", { cut, t, revision, exact }))),
);

server.registerTool(
  "dailies_revisions",
  {
    title: "List revisions",
    description: `Every revision of a cut with author, summary, changed layers and changed seconds, plus the revision ${WHO} approved.`,
    inputSchema: { cut },
    annotations: { readOnlyHint: true },
  },
  ({ cut }) => guarded(async () => text(await call("/api/agent/revisions", { cut }))),
);

type Setup = {
  owner?: string;
  tsrct: { found: boolean; path?: string; version?: string; wanted: string };
  ffmpeg: { found: boolean; path?: string; version?: string; encoder: string };
  mcp: { entry: string; exists: boolean };
  release?: { short: string; subject: string };
  t3: boolean;
};
type CheckItem = { item: string; state: "ok" | "missing" | "warn" | "info"; detail: string; fix?: string };

const older = (a: string, b: string) => {
  const x = a.split(/[.-]/).map(Number);
  const y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

function checkItems(s: Setup, port: number): CheckItem[] {
  const v = s.tsrct.wanted;
  const tesseractFix = `Install Tesseract CLI ${v}: download tesseract-${v}-windows-x86_64.zip and its .sha256 from https://github.com/mirage-hq/tesseract/releases/tag/v${v}, compare the first word of the .sha256 file with (Get-FileHash <zip> -Algorithm SHA256).Hash, Expand-Archive the zip and run its install.ps1 with powershell -ExecutionPolicy Bypass -File. Dailies picks it up within a few seconds.`;
  return [
    { item: "Dailies", state: "ok", detail: `running on 127.0.0.1:${port}${s.release ? `, release ${s.release.short}` : ", development build"}` },
    !s.tsrct.found
      ? { item: "Tesseract CLI", state: "missing", detail: "not found", fix: tesseractFix }
      : s.tsrct.version && older(s.tsrct.version, v)
        ? { item: "Tesseract CLI", state: "warn", detail: `${s.tsrct.version} is older than ${v}, the version Dailies is tested with`, fix: tesseractFix }
        : { item: "Tesseract CLI", state: "ok", detail: `${s.tsrct.version ?? "found"} at ${s.tsrct.path}` },
    s.ffmpeg.found
      ? { item: "ffmpeg", state: "ok", detail: `${s.ffmpeg.version ?? "found"}, encoder ${s.ffmpeg.encoder}` }
      : { item: "ffmpeg", state: "missing", detail: "not found", fix: "winget install --id Gyan.FFmpeg -e. Dailies picks it up within a few seconds." },
    s.mcp.exists
      ? { item: "MCP entry", state: "ok", detail: s.mcp.entry }
      : { item: "MCP entry", state: "missing", detail: `${s.mcp.entry} does not exist`, fix: "Install the production app: run bun scripts/install-windows.ts in the Dailies clone." },
    s.owner
      ? { item: "Your name", state: "ok", detail: `agents call you ${s.owner}` }
      : { item: "Your name", state: "missing", detail: "not set", fix: 'Run this check again with --owner "<first name>", or type it in Dailies.' },
    {
      item: "Note delivery",
      state: "info",
      detail: s.t3 ? "T3 Code found: Dailies messages the agent's T3 thread when notes are sent" : "T3 Code not found: agents pick up notes when you tell them, or while they wait with dailies_wait",
    },
  ];
}

async function check() {
  const info = await daemon();
  const s: Setup = await call("/api/setup");
  const items = checkItems(s, info.port);
  return { ready: items.every((i) => i.state === "ok" || i.state === "info"), items };
}

server.registerTool(
  "dailies_check",
  {
    title: "Check the Dailies setup",
    description: "What Dailies can see on this PC: the render service, Tesseract CLI, ffmpeg, the MCP entry, the reviewer's name and how notes reach agents, with a fix for anything missing.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => guarded(async () => text(await check())),
);

if (process.argv.includes("--check")) {
  const args = process.argv.slice(2);
  const ownerArg = args.indexOf("--owner");
  clientId = "dailies-check/0.1.0";
  try {
    if (ownerArg >= 0 && args[ownerArg + 1]?.trim()) await call("/api/settings", { owner: args[ownerArg + 1] });
    const result = await check();
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      const mark = { ok: "ok  ", missing: "MISS", warn: "WARN", info: "info" };
      const pad = Math.max(...result.items.map((i) => i.item.length));
      console.log("Dailies setup check");
      for (const i of result.items) {
        console.log(`  ${mark[i.state]}  ${i.item.padEnd(pad)}  ${i.detail}`);
        if (i.fix) console.log(`        ${" ".repeat(pad)}  fix: ${i.fix}`);
      }
      console.log(result.ready ? "Ready. Start a new agent session to load the dailies_* tools." : "Fix the items above, then run this check again.");
    }
    process.exit(result.ready ? 0 : 1);
  } catch (e) {
    console.log(`Dailies is not reachable: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`Open Dailies from the Start menu and run this again. Logs: ${join(APP_DIR, "daemon.log")}`);
    process.exit(2);
  }
} else {
  await server.connect(new StdioServerTransport());
}
