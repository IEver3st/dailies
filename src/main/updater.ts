import { app, Notification } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { join, resolve } from "node:path";

export type ReleaseInfo = {
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
  previous?: string;
};

export type UpdateState = {
  enabled: boolean;
  running?: ReleaseInfo;
  ready?: ReleaseInfo;
  previous?: ReleaseInfo;
  checking: boolean;
  lastCheck?: string;
  failure?: { short: string; step: string; error: string };
};

type Options = {
  root: string;
  appDir: string;
  bun: () => string;
  icon: string;
  windowVisible: () => boolean;
  beforeRestart: () => void;
  onChange: (state: UpdateState) => void;
};

const CHECK_EVERY = 2 * 60_000;
const FIRST_CHECK = 15_000;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const same = (a?: string, b?: string) => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();

export function createUpdater(o: Options) {
  const currentFile = join(o.appDir, "releases", "current.json");
  const logFile = join(o.appDir, "updates.log");
  const running = readJson<ReleaseInfo>(join(o.root, "release.json"));
  const state: UpdateState = { enabled: !!running, running, checking: false };
  const announced = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const emit = () => o.onChange({ ...state });

  function releaseAt(dir?: string) {
    return dir ? readJson<ReleaseInfo>(join(dir, "release.json")) : undefined;
  }

  function scriptRunner(args: string[]) {
    return new Promise<any>((done) => {
      const child = spawn(o.bun(), [join(o.root, "scripts", "release.ts"), ...args, "--json"], {
        cwd: o.root,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", (e) => done({ status: "failed", step: "spawn", error: e.message }));
      child.on("close", () => {
        const line = out.trim().split("\n").at(-1);
        try {
          done(JSON.parse(line ?? ""));
        } catch {
          done({ status: "failed", step: "update", error: out.trim().slice(-400) || "release script produced no result" });
        }
      });
    });
  }

  function readCurrent() {
    const current = readJson<ReleaseInfo>(currentFile);
    if (!current || !existsSync(join(current.dir, "out", "main", "index.js"))) return;
    const ready = same(current.dir, o.root) ? undefined : current;
    state.previous = ready ? undefined : releaseAt(current.previous);
    const changed = ready?.dir !== state.ready?.dir;
    state.ready = ready;
    if (changed) {
      if (ready) onReady(ready);
      emit();
    }
  }

  function onReady(ready: ReleaseInfo) {
    if (!o.windowVisible()) {
      setTimeout(() => state.ready?.dir === ready.dir && !o.windowVisible() && apply(), 3000);
      return;
    }
    if (announced.has(ready.dir) || !Notification.isSupported()) return;
    announced.add(ready.dir);
    const n = new Notification({ title: `Dailies ${ready.short} is ready`, body: `${ready.subject}\nClick to restart into it.`, icon: o.icon, silent: true });
    n.on("click", () => apply());
    n.show();
  }

  function onFailure(r: { sha?: string; step: string; error: string }) {
    const short = r.sha?.slice(0, 7) ?? "update";
    const fresh = state.failure?.short !== short;
    state.failure = { short, step: r.step, error: r.error };
    if (!fresh || !Notification.isSupported() || announced.has(`fail:${short}`)) return;
    announced.add(`fail:${short}`);
    new Notification({
      title: `Dailies ${short} did not build`,
      body: `Still running ${running?.short}. Failed at ${r.step}. See ${logFile}.`,
      icon: o.icon,
      silent: true,
    }).show();
  }

  async function check() {
    if (!state.enabled || state.checking) return;
    state.checking = true;
    emit();
    const r = await scriptRunner(["update"]);
    state.checking = false;
    state.lastCheck = new Date().toISOString();
    if (r.status === "failed") {
      if (r.step !== "fetch" && r.step !== "clone") onFailure(r);
    } else if (r.status === "updated" || r.status === "current") {
      state.failure = undefined;
    }
    readCurrent();
    emit();
  }

  function apply() {
    const ready = state.ready;
    if (!ready) return;
    const background = !o.windowVisible();
    o.beforeRestart();
    if (ready.shellUpdate && ready.electron !== process.versions.electron && existsSync(join(ready.dir, "node_modules", "electron", "dist", "electron.exe"))) {
      const args = [join(ready.dir, "scripts", "install-windows.ts"), "--from-release", ready.dir, "--wait-pid", String(process.pid), "--launch", ...(background ? ["--background"] : [])];
      spawn(o.bun(), args, { cwd: ready.dir, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }).unref();
    } else {
      const args = process.argv.slice(1).filter((a) => a !== "--background");
      app.relaunch({ args: background ? [...args, "--background"] : args });
    }
    app.quit();
  }

  async function rollback() {
    if (!state.enabled || !state.previous) return;
    const r = await scriptRunner(["rollback"]);
    readCurrent();
    if (r.status === "updated" && state.ready) apply();
    emit();
  }

  function start() {
    if (!state.enabled) return;
    watchFile(currentFile, { interval: 2000 }, readCurrent);
    readCurrent();
    setTimeout(() => void check(), FIRST_CHECK);
    timer = setInterval(() => void check(), CHECK_EVERY);
    app.on("will-quit", () => {
      unwatchFile(currentFile);
      if (timer) clearInterval(timer);
    });
  }

  return {
    start,
    check,
    apply,
    rollback,
    windowHidden: () => state.ready && apply(),
    state: () => ({ ...state }),
    logFile,
  };
}
