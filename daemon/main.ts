import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Registry, configureRender } from "./cuts";
import { Renderer, ensureShim } from "./render";
import { Exporter } from "./exports";
import { cliVersion, tryFindCli } from "./tsrct";
import { startServer } from "./server";
import { DAEMON_FILE, DEFAULT_PORT, HOME_ID, readJson, writeJsonAtomic } from "./paths";
import { FFMPEG_FOUND, findFfmpeg, pickEncoder } from "./media";

const VERSION = "0.1.0";
const daemonDir = dirname(Bun.fileURLToPath(import.meta.url));

async function alreadyRunning(): Promise<boolean> {
  const info = readJson<{ port?: number; token?: string; pid?: number }>(DAEMON_FILE, {});
  if (!info.port || !info.token) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { "x-dailies-token": info.token }, signal: AbortSignal.timeout(800) });
    const j: any = await r.json();
    return j.app === "dailies" && j.authed === true && j.pid !== process.pid;
  } catch {
    return false;
  }
}

if (await alreadyRunning()) {
  console.log("[dailies] daemon already running");
  process.exit(0);
}

const uiArg = process.argv.indexOf("--ui");
const uiCandidates = uiArg > 0 ? [process.argv[uiArg + 1]] : [join(daemonDir, "..", "out", "renderer"), join(daemonDir, "renderer")];
const uiDir = () => uiCandidates.find((d) => existsSync(join(d, "index.html")));

await ensureShim(daemonDir);
const encoder = await pickEncoder();
const cli = tryFindCli();
const cliV = cli ? await cliVersion(cli).catch(() => cli) : "missing";
configureRender(cliV, encoder);
const registry = new Registry();
const renderer = new Renderer(() => [...registry.cuts.values()]);
const exporter = new Exporter();
registry.onRevision = (cut, rev) => renderer.plan(cut, rev.n);
registry.onSourceLost = (cut, n) => renderer.abandon(cut, n);

const token = randomBytes(24).toString("hex");
const startedAt = new Date().toISOString();
if (await alreadyRunning()) {
  console.log("[dailies] daemon already running");
  process.exit(0);
}
let server: ReturnType<typeof startServer> | undefined;
const firstPort = Number(process.env.DAILIES_PORT || DEFAULT_PORT);
let port = firstPort;
for (let i = 0; i < 20 && !server; i++, port++) {
  try {
    server = startServer({ registry, renderer, exporter, token, uiDir, startedAt, version: VERSION }, port);
  } catch {}
}
if (!server) {
  console.error("[dailies] no free port");
  process.exit(1);
}
if (server.port !== firstPort) {
  const rival = await fetch(`http://127.0.0.1:${firstPort}/api/health`, { signal: AbortSignal.timeout(800) })
    .then((r) => r.json())
    .catch(() => undefined);
  if (rival?.app === "dailies" && rival.home === HOME_ID) {
    console.log(`[dailies] another daemon holds ${firstPort}; exiting`);
    server.stop(true);
    process.exit(0);
  }
}
writeJsonAtomic(DAEMON_FILE, { port: server.port, token, pid: process.pid, startedAt, version: VERSION, root: resolve(daemonDir, "..") });
console.log(`[dailies] daemon ${VERSION} on http://127.0.0.1:${server.port} (tsrct ${cliV}, encoder ${encoder}, ui ${uiDir() ?? "not built yet"})`);

if (!cli || !FFMPEG_FOUND) {
  const missing = [!cli && "the Tesseract CLI", !FFMPEG_FOUND && "ffmpeg"].filter(Boolean).join(" and ");
  console.log(`[dailies] rendering is off until ${missing} is installed`);
  const runs = async (exe: string | undefined, args: string[]) => {
    if (!exe) return false;
    try {
      const p = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return code === 0 && /\d+\.\d+/.test(out + err);
    } catch {
      return false;
    }
  };
  let probing = false;
  setInterval(async () => {
    if (probing) return;
    probing = true;
    if ((!cli && (await runs(tryFindCli(), ["--version"]))) || (!FFMPEG_FOUND && (await runs(findFfmpeg(), ["-version"])))) {
      console.log("[dailies] a missing tool is installed now; restarting to pick it up");
      shutdown();
    }
    probing = false;
  }, 5000);
}

void Promise.all(
  [...registry.cuts.values()].map((cut) =>
    cut.ingest().then(() => {
      if (cut.latest) renderer.plan(cut, cut.latest.n);
    }),
  ),
).then(() => renderer.evict());
setInterval(() => renderer.evict(), 60 * 60_000);
setInterval(() => {
  for (const cut of registry.cuts.values()) {
    try {
      cut.pollForChanges();
    } catch {}
  }
}, 1000);

const shutdown = () => {
  const info = readJson<{ pid?: number }>(DAEMON_FILE, {});
  if (info.pid === process.pid) writeJsonAtomic(DAEMON_FILE, { stopped: new Date().toISOString() });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {
  const info = readJson<{ pid?: number }>(DAEMON_FILE, {});
  if (info.pid && info.pid !== process.pid) {
    console.log(`[dailies] daemon ${info.pid} took over; exiting`);
    process.exit(0);
  }
}, 2000);
if (process.argv.includes("--parent-pid")) {
  const parent = Number(process.argv[process.argv.indexOf("--parent-pid") + 1]);
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      shutdown();
    }
  }, 2000);
}
