import { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createUpdater, type UpdateState } from "./updater";

type DaemonInfo = { port: number; token: string; pid?: number; root?: string };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Dailies");
const DAEMON_FILE = join(APP_DIR, "daemon.json");
const RESOURCES = join(ROOT, "resources");
const startHidden = process.argv.includes("--background");
const INSTALLED = process.platform === "win32" && basename(process.execPath).toLowerCase() === "dailies.exe";
const APP_ID = INSTALLED ? "dev.ever3st.dailies" : "dev.ever3st.dailies.dev";
const TOAST_CLSID = "{7ABCD69B-5294-4735-9F68-17BB9994399C}";
const START_MENU = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let daemon: DaemonInfo | undefined;
let pendingNav: string | undefined;

const updater = createUpdater({
  root: ROOT,
  appDir: APP_DIR,
  bun: bunPath,
  icon: join(RESOURCES, "icon.png"),
  windowVisible: () => !!win?.isVisible(),
  beforeRestart: () => {
    quitting = true;
  },
  onChange: (state) => {
    refreshTray?.();
    win?.webContents.send("dailies:update", state);
  },
});
let refreshTray: (() => void) | undefined;

function registerShortcut() {
  const link = join(START_MENU, "Dailies.lnk");
  const details = {
    target: process.execPath,
    cwd: dirname(process.execPath),
    description: "Review room for agent-made Tesseract videos",
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: APP_ID,
    toastActivatorClsid: TOAST_CLSID,
  };
  const current = existsSync(link) ? shell.readShortcutLink(link) : undefined;
  const same =
    current &&
    current.target.toLowerCase() === details.target.toLowerCase() &&
    current.appUserModelId === APP_ID &&
    current.toastActivatorClsid?.toUpperCase() === TOAST_CLSID &&
    current.icon?.toLowerCase() === details.icon.toLowerCase();
  if (!same) shell.writeShortcutLink(link, details);
  const stale = join(START_MENU, "Electron.lnk");
  try {
    if (existsSync(stale) && shell.readShortcutLink(stale).appUserModelId === APP_ID) rmSync(stale);
  } catch {}
}

app.setAppUserModelId(APP_ID);
if (INSTALLED) {
  app.setToastActivatorCLSID(TOAST_CLSID);
  try {
    registerShortcut();
  } catch {}
}
if (process.argv.includes("--register")) {
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (!argv.includes("--background")) showWindow();
  });
}

function readDaemonFile(): DaemonInfo | undefined {
  try {
    const j = JSON.parse(readFileSync(DAEMON_FILE, "utf8"));
    return j.port && j.token ? { port: j.port, token: j.token, pid: j.pid, root: j.root } : undefined;
  } catch {
    return undefined;
  }
}

async function healthy(info: DaemonInfo | undefined) {
  if (!info) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { "x-dailies-token": info.token }, signal: AbortSignal.timeout(1500) });
    const j: any = await r.json();
    return j.app === "dailies" && j.authed === true;
  } catch {
    return false;
  }
}

function bunPath() {
  const candidates = [process.env.DAILIES_BUN, join(homedir(), ".bun", "bin", "bun.exe")];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? "bun";
}

const RELEASED = existsSync(join(ROOT, "release.json"));
const samePath = (a?: string, b?: string) => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();

async function retire(info: DaemonInfo) {
  try {
    if (info.pid) process.kill(info.pid);
  } catch {}
  const until = Date.now() + 8000;
  while (Date.now() < until && (await healthy(info))) await new Promise((r) => setTimeout(r, 200));
}

async function ensureDaemon(): Promise<DaemonInfo> {
  const current = readDaemonFile();
  if (await healthy(current)) {
    if (!RELEASED || samePath(current!.root, ROOT)) return current!;
    await retire(current!);
  }
  mkdirSync(APP_DIR, { recursive: true });
  const log = openSync(join(APP_DIR, "daemon.log"), "a");
  const child = spawn(bunPath(), [join(ROOT, "daemon", "main.ts"), "--parent-pid", String(process.pid), "--ui", join(ROOT, "out", "renderer")], {
    cwd: ROOT,
    stdio: ["ignore", log, log],
    windowsHide: true,
    detached: false,
  });
  child.unref();
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 300));
    const next = readDaemonFile();
    if (await healthy(next)) return next!;
    if (child.exitCode !== null && child.exitCode !== 0) break;
  }
  throw new Error(`The Dailies service did not start. See ${join(APP_DIR, "daemon.log")}.`);
}

function rendererUrl() {
  return process.env.ELECTRON_RENDERER_URL;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#0f1b1d",
    title: "Dailies",
    icon: join(RESOURCES, process.platform === "win32" ? "icon.ico" : "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0f1b1d", symbolColor: "#8aa3a0", height: 48 },
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
      updater.windowHidden();
    }
  });
  win.once("ready-to-show", () => {
    if (!startHidden) win?.show();
  });
  const dev = rendererUrl();
  if (dev) void win.loadURL(dev);
  else if (daemon) void win.loadURL(`http://127.0.0.1:${daemon.port}/?launch=${Date.now()}`);
}

function showWindow(cutId?: string) {
  if (!win) createWindow();
  if (cutId) {
    pendingNav = cutId;
    win!.webContents.send("dailies:navigate", cutId);
  }
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
}

function loginEnabled() {
  return app.getLoginItemSettings({ args: ["--background"] }).openAtLogin;
}

function updateItems(u: UpdateState): Electron.MenuItemConstructorOptions[] {
  if (!u.enabled) return [{ label: "Development build", enabled: false }, { type: "separator" }];
  const items: Electron.MenuItemConstructorOptions[] = [{ label: `Version ${u.running!.short}: ${u.running!.subject.slice(0, 48)}`, enabled: false }];
  if (u.ready) items.push({ label: `Restart to update to ${u.ready.short}`, click: () => updater.apply() });
  else items.push({ label: u.checking ? "Checking for updates..." : "Check for updates", enabled: !u.checking, click: () => void updater.check() });
  if (u.failure) items.push({ label: `Update ${u.failure.short} failed at ${u.failure.step}: open log`, click: () => void shell.openPath(updater.logFile) });
  if (u.previous && !u.ready) items.push({ label: `Roll back to ${u.previous.short}`, click: () => void updater.rollback() });
  items.push({ type: "separator" });
  return items;
}

function buildTray() {
  const image = nativeImage.createFromPath(join(RESOURCES, "tray.png"));
  tray = new Tray(image);
  tray.setToolTip("Dailies");
  const refresh = () =>
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Dailies", click: () => showWindow() },
        { type: "separator" },
        ...updateItems(updater.state()),
        {
          label: "Start with Windows",
          type: "checkbox",
          checked: loginEnabled(),
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--background"] });
            refresh();
          },
        },
        { label: "Open cache folder", click: () => void shell.openPath(APP_DIR) },
        { type: "separator" },
        {
          label: "Quit Dailies",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  refreshTray = refresh;
  refresh();
  tray.on("click", () => showWindow());
}

const seenRevisions = new Map<string, number>();
async function watchEvents() {
  for (;;) {
    try {
      if (!daemon || !(await healthy(daemon))) daemon = await ensureDaemon();
      const r = await fetch(`http://127.0.0.1:${daemon.port}/api/events?token=${daemon.token}`);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) void onEvent(JSON.parse(line.slice(6)));
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function onEvent(e: any) {
  if (!daemon) return;
  if (e.type === "revision" && e.cutId) {
    const r = await fetch(`http://127.0.0.1:${daemon.port}/api/cuts/${e.cutId}`, { headers: { "x-dailies-token": daemon.token } }).catch(() => undefined);
    const d: any = await r?.json().catch(() => undefined);
    const rev = d?.revisions?.at(-1);
    if (!rev || seenRevisions.get(e.cutId) === rev.n) return;
    seenRevisions.set(e.cutId, rev.n);
    if (rev.authorKind !== "agent" || (win?.isVisible() && win.isFocused())) return;
    notify(`${rev.author} published r${rev.n} of ${d.name}`, rev.summary, e.cutId);
  }
  if (e.type === "focus" && e.cutId && win?.isVisible()) win.webContents.send("dailies:navigate", e.cutId);
}

function notify(title: string, body: string, cutId: string) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: join(RESOURCES, "icon.png"), silent: false });
  n.on("click", () => showWindow(cutId));
  n.show();
}

ipcMain.handle("dailies:connection", async () => {
  if (!daemon || !(await healthy(daemon))) daemon = await ensureDaemon();
  return { base: `http://127.0.0.1:${daemon.port}`, token: daemon.token };
});
ipcMain.handle("dailies:updateState", () => updater.state());
ipcMain.handle("dailies:applyUpdate", () => updater.apply());
ipcMain.handle("dailies:takeNavigation", () => {
  const nav = pendingNav;
  pendingNav = undefined;
  return nav;
});
ipcMain.handle("dailies:openFile", async () => {
  const r = await dialog.showOpenDialog(win!, { title: "Open a Tesseract project", properties: ["openFile", "multiSelections"], filters: [{ name: "Tesseract project", extensions: ["tsrct"] }] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("dailies:reveal", (_e, path: string) => {
  if (typeof path === "string" && existsSync(path)) shell.showItemInFolder(path);
});
ipcMain.handle("dailies:openExternal", (_e, url: string) => {
  if (typeof url === "string" && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) void shell.openExternal(url);
});

app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  quitting = true;
});

void app.whenReady().then(async () => {
  buildTray();
  try {
    daemon = await ensureDaemon();
  } catch (e) {
    dialog.showErrorBox("Dailies", e instanceof Error ? e.message : String(e));
  }
  createWindow();
  void watchEvents();
  updater.start();
});
