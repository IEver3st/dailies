import { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createUpdater, type UpdateState } from "./updater";
import { createPreferences } from "./preferences";
import type { Alert, SettingsSnapshot } from "../shared/preferences";
import { resolveTheme } from "../shared/themes";

type DaemonInfo = { port: number; token: string; pid?: number; root?: string };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_DIR = process.env.DAILIES_HOME ? resolve(process.env.DAILIES_HOME) : join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Dailies");
const RELEASED = existsSync(join(ROOT, "release.json"));
if (process.env.DAILIES_HOME) app.setPath("userData", join(APP_DIR, RELEASED ? "electron-release" : "electron"));
else if (!RELEASED) app.setPath("userData", join(app.getPath("appData"), "Dailies Dev"));
const prefs = createPreferences(APP_DIR);
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
  autoRestart: () => prefs.get().autoRestart,
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
const registering = process.argv.includes("--register");
const primary = !registering && app.requestSingleInstanceLock();
if (registering) {
  app.exit(0);
} else if (!primary) {
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

const samePath = (a?: string, b?: string) => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();

async function retire(info: DaemonInfo) {
  try {
    if (info.pid) process.kill(info.pid);
  } catch {}
  const until = Date.now() + 8000;
  while (Date.now() < until && (await healthy(info))) await new Promise((r) => setTimeout(r, 200));
}

const isDevRoot = (root?: string) => !!root && existsSync(join(root, "package.json")) && !existsSync(join(root, "release.json"));
const accepts = (root?: string) => samePath(root, ROOT) || (RELEASED && isDevRoot(root));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function stake() {
  mkdirSync(APP_DIR, { recursive: true });
  const tmp = `${DAEMON_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ claim: ROOT, by: process.pid, at: Date.now() }));
    renameSync(tmp, DAEMON_FILE);
  } catch {
    rmSync(tmp, { force: true });
  }
}

function staked() {
  try {
    const j = JSON.parse(readFileSync(DAEMON_FILE, "utf8"));
    return typeof j.claim === "string" && j.by !== process.pid && alive(j.by) && Date.now() - j.at < 30_000 && accepts(j.claim);
  } catch {
    return false;
  }
}

function startDaemon() {
  mkdirSync(APP_DIR, { recursive: true });
  const log = openSync(join(APP_DIR, "daemon.log"), "a");
  const child = spawn(bunPath(), [join(ROOT, "daemon", "main.ts"), "--parent-pid", String(process.pid), "--ui", join(ROOT, "out", "renderer")], {
    cwd: ROOT,
    stdio: ["ignore", log, log],
    windowsHide: true,
    detached: false,
  });
  child.unref();
  return child;
}

let ensuring: Promise<DaemonInfo> | undefined;
function ensureDaemon() {
  return (ensuring ??= connectDaemon().finally(() => (ensuring = undefined)));
}

async function connectDaemon(): Promise<DaemonInfo> {
  const failed = () => new Error(`The Dailies service did not start. See ${join(APP_DIR, "daemon.log")}.`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = readDaemonFile();
    if (await healthy(current)) {
      if (accepts(current!.root)) return current!;
      stake();
      await retire(current!);
    }
    const child = staked() ? undefined : startDaemon();
    const until = Date.now() + 45_000;
    for (;;) {
      if (Date.now() > until) throw failed();
      await new Promise((r) => setTimeout(r, 300));
      const next = readDaemonFile();
      const exited = child ? child.exitCode !== null : !staked();
      if (await healthy(next)) {
        if (accepts(next!.root)) return next!;
        if (exited) break;
      } else if (exited) {
        if (child?.exitCode) throw failed();
        break;
      }
    }
  }
  throw failed();
}

function rendererUrl() {
  return process.env.ELECTRON_RENDERER_URL;
}

function windowTheme() {
  const choice = prefs.get().theme;
  const source = choice === "system" ? "system" : resolveTheme(choice, true).scheme;
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  return resolveTheme(choice, nativeTheme.shouldUseDarkColors);
}

function paintWindow() {
  if (!win || win.isDestroyed()) return;
  const t = windowTheme();
  win.setBackgroundColor(t.palette.ink);
  win.setTitleBarOverlay({ color: t.palette.ink, symbolColor: t.symbol, height: 48 });
}

function createWindow() {
  const theme = windowTheme();
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: theme.palette.ink,
    title: "Dailies",
    icon: join(RESOURCES, process.platform === "win32" ? "icon.ico" : "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: theme.palette.ink, symbolColor: theme.symbol, height: 48 },
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
    if (quitting) return;
    if (prefs.get().closeAction === "quit") {
      quitting = true;
      app.quit();
      return;
    }
    e.preventDefault();
    win?.hide();
    updater.windowHidden();
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

function openSettings(page?: string) {
  showWindow();
  const send = () => win?.webContents.send("dailies:openSettings", page);
  if (win?.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}

function loginEnabled() {
  return app.getLoginItemSettings({ args: ["--background"] }).openAtLogin;
}

function setLogin(on: boolean) {
  app.setLoginItemSettings({ openAtLogin: on, args: ["--background"] });
  refreshTray?.();
  broadcastSettings();
}

function snapshot(): SettingsSnapshot {
  return { preferences: prefs.get(), startWithWindows: loginEnabled(), installed: INSTALLED, appDir: APP_DIR };
}

function broadcastSettings() {
  win?.webContents.send("dailies:settings", snapshot());
}

prefs.onChange(broadcastSettings);
prefs.onChange(paintWindow);
nativeTheme.on("updated", paintWindow);
ipcMain.on("dailies:initialTheme", (e) => {
  e.returnValue = prefs.get().theme;
});

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
          click: (item) => setLogin(item.checked),
        },
        { label: "Settings", click: () => openSettings() },
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
    if (rev.authorKind !== "agent") return;
    notify(prefs.get().revisionAlerts, `${rev.author} published r${rev.n} of ${d.name}`, rev.summary, e.cutId);
  }
  if (e.type === "agent" && e.state === "blocked" && e.cutId) {
    notify(prefs.get().blockedAlerts, `${e.name ?? "An agent"} needs you on ${e.cut ?? "a cut"}`, e.text || "Open the cut to see what it is waiting on.", e.cutId);
  }
  if (e.type === "export" && e.state === "done" && typeof e.file === "string") {
    const file: string = e.file;
    const size = typeof e.bytes === "number" ? `${Math.round(e.bytes / 1e6)} MB, ` : "";
    notify("sound", `Exported r${e.rev} of ${e.cut ?? "your cut"}`, `${size}4K60. Click to show it in Explorer.`, e.cutId, () => {
      if (existsSync(file)) shell.showItemInFolder(file);
    });
  }
  if (e.type === "export" && e.state === "failed") {
    notify("sound", `Export of r${e.rev} of ${e.cut ?? "your cut"} failed`, String(e.error ?? "Open the cut to see why."), e.cutId);
  }
  if (e.type === "focus" && e.cutId && win?.isVisible() && prefs.get().followAgents) win.webContents.send("dailies:navigate", e.cutId);
}

function notify(alert: Alert, title: string, body: string, cutId: string, onClick?: () => void) {
  if (alert === "off" || !Notification.isSupported()) return;
  if (win?.isVisible() && win.isFocused() && (onClick || !prefs.get().alertWhenFocused)) return;
  const n = new Notification({ title, body, icon: join(RESOURCES, "icon.png"), silent: alert === "silent" });
  n.on("click", () => (onClick ? onClick() : showWindow(cutId)));
  n.show();
}

ipcMain.handle("dailies:connection", async () => {
  if (!daemon || !(await healthy(daemon))) daemon = await ensureDaemon();
  return { base: `http://127.0.0.1:${daemon.port}`, token: daemon.token };
});
ipcMain.handle("dailies:updateState", () => updater.state());
ipcMain.handle("dailies:applyUpdate", () => updater.apply());
ipcMain.handle("dailies:checkUpdates", () => updater.check());
ipcMain.handle("dailies:rollback", () => updater.rollback());
ipcMain.handle("dailies:settings", () => snapshot());
ipcMain.handle("dailies:setPreferences", (_e, patch: unknown) => {
  prefs.set(patch);
  return snapshot();
});
ipcMain.handle("dailies:setStartWithWindows", (_e, on: unknown) => {
  if (INSTALLED && typeof on === "boolean") setLogin(on);
  return snapshot();
});
ipcMain.handle("dailies:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win!, { title: "Add a project folder", properties: ["openDirectory"] });
  return r.canceled ? undefined : r.filePaths[0];
});
ipcMain.handle("dailies:openFolder", (_e, path: string) => {
  if (typeof path === "string" && existsSync(path)) void shell.openPath(path);
});
ipcMain.handle("dailies:openLog", (_e, which: string) => {
  const file = which === "updates" ? updater.logFile : which === "daemon" ? join(APP_DIR, "daemon.log") : undefined;
  if (file && existsSync(file)) void shell.openPath(file);
});
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
  if (!primary) return;
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
