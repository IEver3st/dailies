import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type Release = {
  sha: string;
  short: string;
  subject: string;
  author: string;
  committedAt: string;
  builtAt: string;
  version: string;
  electron: string;
  shellUpdate: boolean;
  dir: string;
};

export type Current = Release & { previous?: string };

type State = { failed: Record<string, { at: string; step: string; error: string }>; skipped: string[]; lastCheck?: string };

const REPO = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const REMOTE: string = process.env.DAILIES_REMOTE ?? pkg.repository?.url ?? "https://github.com/IEver3st/dailies.git";
const APP_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Dailies");
const RELEASES = join(APP_DIR, "releases");
const SOURCE = join(APP_DIR, "source.git");
const CURRENT = join(RELEASES, "current.json");
const STATE = join(RELEASES, "state.json");
const LOCK = join(RELEASES, ".lock");
const LOG = join(APP_DIR, "updates.log");
const SHELL_VERSION = join(process.env.LOCALAPPDATA ?? "", "Programs", "Dailies", "version");
const KEEP = 3;

const quiet = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ELECTRON_SKIP_BINARY_DOWNLOAD: "1", ELECTRON_RUN_AS_NODE: undefined, CI: "1" };

class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

function log(line: string) {
  mkdirSync(APP_DIR, { recursive: true });
  appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function bun() {
  return process.execPath;
}

function run(step: string, cmd: string[], cwd: string, env: Record<string, string | undefined> = quiet) {
  log(`$ ${cmd.join(" ")}  (${cwd})`);
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`.trim();
  if (out) log(out);
  if (p.exitCode !== 0) throw new StepError(step, out.split("\n").slice(-12).join("\n") || `${cmd[0]} exited ${p.exitCode}`);
  return p.stdout.toString().trim();
}

function git(step: string, ...args: string[]) {
  return run(step, ["git", ...args], APP_DIR);
}

export function readCurrent(): Current | undefined {
  const c = readJson<Current | undefined>(CURRENT, undefined);
  return c?.dir && existsSync(join(c.dir, "out", "main", "index.js")) ? c : undefined;
}

function readState(): State {
  return { failed: {}, skipped: [], ...readJson<Partial<State>>(STATE, {}) };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lock(): boolean {
  mkdirSync(RELEASES, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      const holder = Number(readFileSync(LOCK, "utf8").trim());
      const stale = !holder || !alive(holder) || Date.now() - statSync(LOCK).mtimeMs > 30 * 60_000;
      if (!stale) return false;
      rmSync(LOCK, { force: true });
    }
  }
  return false;
}

function unlock() {
  if (existsSync(LOCK) && readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK, { force: true });
}

function shellElectron() {
  try {
    return readFileSync(SHELL_VERSION, "utf8").trim();
  } catch {
    return "";
  }
}

function sync(ref: string) {
  if (!existsSync(join(SOURCE, "HEAD"))) git("clone", "clone", "--bare", "--quiet", REMOTE, SOURCE);
  git("fetch", "-C", SOURCE, "fetch", "--quiet", "--prune", REMOTE, "+refs/heads/*:refs/heads/*");
  const sha = git("resolve", "-C", SOURCE, "rev-parse", `${ref}^{commit}`);
  const [subject, author, committedAt] = git("resolve", "-C", SOURCE, "log", "-1", "--format=%s%x00%an%x00%cI", sha).split("\0");
  return { sha, subject, author, committedAt };
}

function build(commit: ReturnType<typeof sync>): Release {
  const short = commit.sha.slice(0, 7);
  const dir = join(RELEASES, `${short}-${Date.now().toString(36)}`);
  const stage = `${dir}.staging`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const tarball = `${stage}.tar`;
  try {
    git("export", "-C", SOURCE, "archive", "--format=tar", "-o", tarball, commit.sha);
    run("export", [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), "-xf", tarball, "-C", stage], RELEASES);
  } finally {
    rmSync(tarball, { force: true });
  }

  run("install", [bun(), "install", "--frozen-lockfile"], stage);
  run("typecheck", [bun(), "run", "typecheck"], stage);
  run("build", [bun(), "run", "build"], stage);
  for (const f of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"]) {
    if (!existsSync(join(stage, f))) throw new StepError("build", `build did not produce ${f}`);
  }

  const electron = readJson<{ version?: string }>(join(stage, "node_modules", "electron", "package.json"), {}).version ?? "";
  const shellUpdate = !!electron && electron !== shellElectron();
  if (shellUpdate) {
    run("electron", [bun(), join(stage, "node_modules", "electron", "install.js")], join(stage, "node_modules", "electron"), { ...quiet, ELECTRON_SKIP_BINARY_DOWNLOAD: undefined });
  } else {
    rmSync(join(stage, "node_modules"), { recursive: true, force: true });
    run("prune", [bun(), "install", "--frozen-lockfile", "--production"], stage);
  }
  const probe = join(stage, ".probe");
  run("verify", [bun(), "build", "daemon/main.ts", "mcp/server.ts", "--target=bun", `--outdir=${probe}`], stage);
  rmSync(probe, { recursive: true, force: true });

  const release: Release = {
    ...commit,
    short,
    builtAt: new Date().toISOString(),
    version: readJson<{ version?: string }>(join(stage, "package.json"), {}).version ?? "0.0.0",
    electron,
    shellUpdate,
    dir,
  };
  writeJson(join(stage, "release.json"), release);
  renameSync(stage, dir);
  return release;
}

function activate(release: Release) {
  const old = readCurrent();
  writeJson(CURRENT, { ...release, previous: old && old.dir !== release.dir ? old.dir : old?.previous });
  log(`activated ${release.short} ${release.subject}`);
}

function prune() {
  const current = readCurrent();
  const norm = (d: string) => resolve(d).toLowerCase();
  const keep = new Set([current?.dir, current?.previous].filter((d): d is string => !!d).map(norm));
  const others = readdirSync(RELEASES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.endsWith(".staging"))
    .map((d) => join(RELEASES, d.name))
    .filter((d) => !keep.has(norm(d)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const d of others.slice(Math.max(0, KEEP - keep.size))) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 2 });
    } catch {}
  }
}

type Result =
  | { status: "current"; release: Current }
  | { status: "updated"; release: Release }
  | { status: "skipped"; sha: string; reason: string }
  | { status: "failed"; sha?: string; step: string; error: string }
  | { status: "busy" };

export function update(opts: { ref?: string; force?: boolean } = {}): Result {
  if (!lock()) return { status: "busy" };
  let sha: string | undefined;
  try {
    const state = readState();
    state.lastCheck = new Date().toISOString();
    writeJson(STATE, state);
    const commit = sync(opts.ref ?? "main");
    sha = commit.sha;
    const current = readCurrent();
    if (!opts.force && current?.sha === sha) return { status: "current", release: current };
    if (!opts.force && state.skipped.includes(sha)) return { status: "skipped", sha, reason: "rolled back" };
    const failed = state.failed[sha];
    if (!opts.force && failed) return { status: "failed", sha, step: failed.step, error: failed.error };
    log(`building ${sha.slice(0, 7)} ${commit.subject}`);
    const release = build(commit);
    activate(release);
    prune();
    return { status: "updated", release };
  } catch (e) {
    const step = e instanceof StepError ? e.step : "update";
    const error = e instanceof Error ? e.message : String(e);
    log(`failed at ${step}: ${error}`);
    if (sha && step !== "fetch" && step !== "clone") {
      const state = readState();
      state.failed[sha] = { at: new Date().toISOString(), step, error };
      writeJson(STATE, state);
    }
    for (const d of existsSync(RELEASES) ? readdirSync(RELEASES) : []) {
      if (d.endsWith(".staging")) rmSync(join(RELEASES, d), { recursive: true, force: true });
    }
    return { status: "failed", sha, step, error };
  } finally {
    unlock();
  }
}

export function rollback(): Result {
  const current = readCurrent();
  const previous = current?.previous ? readJson<Release | undefined>(join(current.previous, "release.json"), undefined) : undefined;
  if (!current || !previous || !existsSync(join(previous.dir, "out", "main", "index.js"))) return { status: "failed", step: "rollback", error: "No previous release to roll back to." };
  const state = readState();
  if (!state.skipped.includes(current.sha)) state.skipped.push(current.sha);
  writeJson(STATE, state);
  writeJson(CURRENT, { ...previous, previous: current.dir });
  log(`rolled back ${current.short} -> ${previous.short}`);
  return { status: "updated", release: previous };
}

if (import.meta.main) {
  const [cmd = "update", ...rest] = process.argv.slice(2);
  const arg = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const result =
    cmd === "status"
      ? { status: "status", current: readCurrent() ?? null, state: readState(), remote: REMOTE }
      : cmd === "rollback"
        ? rollback()
        : update({ ref: arg("--ref"), force: rest.includes("--force") });
  if (rest.includes("--json")) console.log(JSON.stringify(result));
  else {
    const r: any = result;
    if (r.status === "updated") console.log(`Production is now ${r.release.short}: ${r.release.subject}`);
    else if (r.status === "current") console.log(`Production is up to date at ${r.release.short}: ${r.release.subject}`);
    else if (r.status === "failed") console.error(`Update ${r.sha?.slice(0, 7) ?? ""} failed at ${r.step}:\n${r.error}\nFull log: ${LOG}`);
    else console.log(JSON.stringify(result, null, 2));
  }
  process.exit((result as any).status === "failed" ? 1 : 0);
}
