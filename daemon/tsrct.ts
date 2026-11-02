import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function findCli(): string {
  const override = process.env.DAILIES_TSRCT;
  if (override && existsSync(override)) return override;
  const local = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const root = join(local, "Tesseract", "public-cli");
  const shim = join(local, "Tesseract", "bin", "tsrct.cmd");
  if (existsSync(shim)) {
    const text = readFileSync(shim, "utf8");
    const m = text.match(/public-cli\\([^\\]+)\\bin\\tsrct\.exe/);
    if (m) {
      const exe = join(root, m[1], "bin", "tsrct.exe");
      if (existsSync(exe)) return exe;
    }
  }
  if (existsSync(root)) {
    const versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const exe = join(root, v, "bin", "tsrct.exe");
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error("Tesseract CLI not found. Install it per the tesseract-video skill.");
}

export async function cliVersion(cli: string): Promise<string> {
  const p = Bun.spawn([cli, "--version"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().replace(/^tsrct(\.exe)?\s*/, "");
}

export type ExportProgress = { phase: string; completed?: number; total?: number; elapsed?: number };

export type ExportJob = {
  done: Promise<void>;
  pid: number;
  kill: () => void;
};

export function exportSpan(opts: {
  cli: string;
  project: string;
  output: string;
  resolution: string;
  fps: number;
  startMs: number;
  durationMs: number;
  shim: string;
  env: Record<string, string>;
  onProgress?: (p: ExportProgress) => void;
}): ExportJob {
  const args = [
    opts.cli,
    "export",
    "--json",
    "--project",
    opts.project,
    "--output",
    opts.output,
    "--resolution",
    opts.resolution,
    "--fps",
    String(opts.fps),
    "--start-ms",
    String(Math.round(opts.startMs)),
    "--duration-ms",
    String(Math.round(opts.durationMs)),
    "--encoder-backend",
    "external-ffmpeg-command",
    "--ffmpeg-path",
    opts.shim,
  ];
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
    windowsHide: true,
  });
  let stderrTail = "";
  const readErr = (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stderr as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith("{")) {
          try {
            const j = JSON.parse(line);
            opts.onProgress?.({ phase: j.phase ?? j.type, completed: j.completed, total: j.total, elapsed: j.elapsedSeconds });
            continue;
          } catch {}
        }
        stderrTail = (stderrTail + "\n" + line).slice(-4000);
      }
    }
  })();
  const done = (async () => {
    const [code] = await Promise.all([proc.exited, readErr, new Response(proc.stdout).text()]);
    if (code !== 0) throw new Error(`tsrct export failed (${code}): ${stderrTail.trim().split("\n").slice(-6).join(" | ")}`);
  })();
  return { done, pid: proc.pid, kill: () => proc.kill() };
}

export async function applyActions(cli: string, project: string, actionsFile: string): Promise<any> {
  const p = Bun.spawn([cli, "project", "apply", "--project", project, "--actions", actionsFile], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error((err || out).trim().split("\n").slice(-4).join(" | "));
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out };
  }
}

export async function commitDocument(cli: string, project: string, file: string): Promise<void> {
  const p = Bun.spawn([cli, "project", "commit", "--project", project, "--file", file], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error((err || out).trim().split("\n").slice(-4).join(" | "));
}
