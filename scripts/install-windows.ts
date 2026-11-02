import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ResEdit from "resedit";

const REPO = join(import.meta.dir, "..");
const DIST = join(REPO, "node_modules", "electron", "dist");
const TARGET = join(process.env.LOCALAPPDATA!, "Programs", "Dailies");
const STAGE = `${TARGET}.staging`;
const OLD = `${TARGET}.old`;
const MARKER = "dailies-install.json";
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const electronVersion = readFileSync(join(DIST, "version"), "utf8").trim();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "win32") fail("This installer is for Windows.");
if (!existsSync(join(REPO, "out", "main", "index.js"))) fail("Build Dailies first: bun run build");
if (existsSync(TARGET) && !existsSync(join(TARGET, MARKER))) fail(`${TARGET} exists and was not made by this installer. Move it away first.`);

function brandExecutable(source: string, dest: string) {
  const exe = ResEdit.NtExecutable.from(readFileSync(source), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!group) fail("Could not find the icon resource in electron.exe.");
  const icon = ResEdit.Data.IconFile.from(readFileSync(join(REPO, "resources", "icon.ico")));
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

rmSync(STAGE, { recursive: true, force: true });
cpSync(DIST, STAGE, {
  recursive: true,
  filter: (src) => !["electron.exe", "default_app.asar"].includes(basename(src).toLowerCase()),
});
brandExecutable(join(DIST, "electron.exe"), join(STAGE, "Dailies.exe"));

const app = join(STAGE, "resources", "app");
mkdirSync(app, { recursive: true });
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "dailies", productName: "Dailies", version: pkg.version, type: "module", main: "main.js" }, null, 2));
writeFileSync(join(app, "main.js"), `import ${JSON.stringify(pathToFileURL(join(REPO, "out", "main", "index.js")).href)};\n`);
writeFileSync(join(STAGE, MARKER), JSON.stringify({ repo: REPO, electron: electronVersion, version: pkg.version, installedAt: new Date().toISOString() }, null, 2));

if (existsSync(TARGET)) {
  rmSync(OLD, { recursive: true, force: true });
  try {
    renameSync(TARGET, OLD);
  } catch {
    rmSync(STAGE, { recursive: true, force: true });
    fail("Dailies is running from the installed copy. Quit it from the tray (Quit Dailies) and run this again.");
  }
}
renameSync(STAGE, TARGET);
rmSync(OLD, { recursive: true, force: true });

const exe = join(TARGET, "Dailies.exe");
const register = Bun.spawnSync([exe, "--register"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
if (register.exitCode !== 0) fail(`Installed, but registering the Start menu shortcut failed: ${register.stderr.toString().trim()}`);
console.log(`Installed Dailies ${pkg.version} (Electron ${electronVersion}) to ${exe}`);
console.log("Start menu: Dailies. Quit any running Dailies and open it from there to get the Dailies icon in the taskbar.");
