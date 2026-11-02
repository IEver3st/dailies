import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import * as ResEdit from "resedit";
import { readCurrent, update } from "./release";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const SOURCE = resolve(option("--from-release") ?? join(import.meta.dir, ".."));
const DIST = join(SOURCE, "node_modules", "electron", "dist");
const TARGET = join(process.env.LOCALAPPDATA!, "Programs", "Dailies");
const STAGE = `${TARGET}.staging`;
const OLD = `${TARGET}.old`;
const MARKER = "dailies-install.json";
const pkg = JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8"));

const LOADER = `import { app, dialog } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const releases = join(process.env.LOCALAPPDATA, "Dailies", "releases");
const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const usable = (dir) => dir && existsSync(join(dir, "out", "main", "index.js"));
const current = read(join(releases, "current.json"));
const dir = [current?.dir, current?.previous].find(usable);
if (dir) {
  await import(pathToFileURL(join(dir, "out", "main", "index.js")).href);
} else {
  await app.whenReady();
  dialog.showErrorBox("Dailies", "No production build of Dailies was found in " + releases + ". Run \\"bun run deploy\\" in the Dailies repo.");
  app.exit(1);
}
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function brandExecutable(source: string, dest: string) {
  const exe = ResEdit.NtExecutable.from(readFileSync(source), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!group) fail("Could not find the icon resource in electron.exe.");
  const icon = ResEdit.Data.IconFile.from(readFileSync(join(SOURCE, "resources", "icon.ico")));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    group.id,
    group.lang,
    icon.icons.map((i) => i.data),
  );
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!info) fail("Could not find version info in electron.exe.");
  const version = `${pkg.version}.0`;
  for (const lang of info.getAllLanguagesForStringValues()) {
    info.setStringValues(lang, {
      ProductName: "Dailies",
      FileDescription: "Dailies",
      InternalName: "Dailies",
      OriginalFilename: "Dailies.exe",
      CompanyName: "Ever3st",
      LegalCopyright: "",
      FileVersion: version,
      ProductVersion: version,
    });
  }
  info.setFileVersion(version);
  info.setProductVersion(version);
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(dest, Buffer.from(exe.generate()));
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pid: number) {
  const until = Date.now() + 60_000;
  while (alive(pid) && Date.now() < until) await Bun.sleep(250);
}

async function swapInto(target: string, patience: number) {
  const until = Date.now() + patience;
  for (;;) {
    try {
      if (existsSync(target)) {
        rmSync(OLD, { recursive: true, force: true });
        renameSync(target, OLD);
      }
      renameSync(STAGE, target);
      rmSync(OLD, { recursive: true, force: true });
      return;
    } catch (e) {
      if (existsSync(OLD) && !existsSync(target)) renameSync(OLD, target);
      if (Date.now() > until) {
        rmSync(STAGE, { recursive: true, force: true });
        fail("Dailies is running from the installed copy. Quit it from the tray (Quit Dailies) and run this again.");
      }
      await Bun.sleep(500);
    }
  }
}

function installShell() {
  if (!existsSync(join(DIST, "electron.exe"))) fail(`Electron is missing at ${DIST}. Run bun install first.`);
  if (existsSync(TARGET) && !existsSync(join(TARGET, MARKER))) fail(`${TARGET} exists and was not made by this installer. Move it away first.`);
  const electronVersion = readFileSync(join(DIST, "version"), "utf8").trim();
  rmSync(STAGE, { recursive: true, force: true });
  cpSync(DIST, STAGE, {
    recursive: true,
    filter: (src) => !["electron.exe", "default_app.asar"].includes(basename(src).toLowerCase()),
  });
  brandExecutable(join(DIST, "electron.exe"), join(STAGE, "Dailies.exe"));
  const app = join(STAGE, "resources", "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "dailies", productName: "Dailies", version: pkg.version, type: "module", main: "main.js" }, null, 2));
  writeFileSync(join(app, "main.js"), LOADER);
  writeFileSync(join(STAGE, MARKER), JSON.stringify({ electron: electronVersion, version: pkg.version, installedFrom: SOURCE, installedAt: new Date().toISOString() }, null, 2));
  return electronVersion;
}

if (process.platform !== "win32") fail("This installer is for Windows.");

const waitPid = Number(option("--wait-pid") ?? 0);
const electronVersion = installShell();
if (waitPid) await waitFor(waitPid);
await swapInto(TARGET, waitPid ? 30_000 : 0);

if (!flag("--from-release") && (!readCurrent() || flag("--update"))) {
  console.log("Building the production release from GitHub main...");
  const result = update();
  if (result.status === "failed") fail(`Installed the app shell, but building the production release failed at ${result.step}:\n${result.error}`);
}

const exe = join(TARGET, "Dailies.exe");
const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
const register = Bun.spawnSync([exe, "--register"], { stdout: "pipe", stderr: "pipe", env });
if (register.exitCode !== 0) fail(`Installed, but registering the Start menu shortcut failed: ${register.stderr.toString().trim()}`);

const current = readCurrent();
console.log(`Installed Dailies (Electron ${electronVersion}) to ${exe}`);
if (current) console.log(`Production release: ${current.short} ${current.subject}`);
if (flag("--launch")) {
  const commandLine = `"${exe}"${flag("--background") ? " --background" : ""}`;
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${TARGET.replace(/'/g, "''")}' }; $r.ReturnValue`;
  const launched = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (launched.stdout.toString().trim() !== "0") fail(`Installed, but launching Dailies failed: ${launched.stderr.toString().trim()}`);
} else {
  console.log("Start menu: Dailies. Quit any running Dailies and open it from there to get the Dailies icon in the taskbar.");
}
