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

async function call(path: string, body?: Record<string, unknown>): Promise<any> {
  const info = await daemon();
  const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-dailies-token": info.token, "content-type": "application/json" },
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

const server = new McpServer(
  { name: "dailies", version: "0.1.0" },
  {
    instructions:
      "Dailies is Manuel's review room for Tesseract (.tsrct) videos. It renders every saved revision of a cut with hardware playback, and Manuel leaves timestamped notes, frame drawings and direct edits there. Loop: dailies_open the .tsrct when you start (Manuel sees it live), dailies_status while you work, edit and save the project with the tsrct CLI as usual, then dailies_publish with a one-line summary and the ids of the notes you addressed. Read feedback with dailies_feedback; answer notes with dailies_reply. Edits Manuel made in Dailies are already in the .tsrct: keep them when you rebuild from a generator script. Use dailies_frame instead of `tsrct preview` (which renders black frames on this machine). If you end your turn, Dailies messages your T3 thread when Manuel sends notes; dailies_wait is only for staying in the loop within a turn.",
  },
);

server.registerTool(
  "dailies_open",
  {
    title: "Open a cut in Dailies",
    description: "Register a .tsrct with Dailies, link it to your T3 thread so Manuel's notes reach you, show it in the app and start rendering. Call this when you begin work on a video.",
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
    description: "Tell Manuel what you are doing on a cut. state working queues his direct edits instead of writing the file under you; ready means a revision is worth watching; blocked means you need him.",
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
    title: "Read Manuel's feedback",
    description:
      "Notes and direct edits on a cut: time, text, the layers visible at that moment, the frame Manuel looked at and his drawing on it (PNG paths you can read), structured suggestions and exact engine actions. Default is what still needs action.",
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
    description: "Block up to 50 s until Manuel sends notes, replies or approves. Use it only while you are actively iterating with him; otherwise end your turn and Dailies will message your thread.",
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
    description: "Every revision of a cut with author, summary, changed layers and changed seconds, plus the revision Manuel approved.",
    inputSchema: { cut },
    annotations: { readOnlyHint: true },
  },
  ({ cut }) => guarded(async () => text(await call("/api/agent/revisions", { cut }))),
);

await server.connect(new StdioServerTransport());
