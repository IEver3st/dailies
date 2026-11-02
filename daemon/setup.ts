import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./paths";
import { FFMPEG, FFMPEG_FOUND, pickEncoder, run } from "./media";
import { TESSERACT_VERSION, tryFindCli } from "./tsrct";
import { t3Launcher } from "./collab";
import { agentClients, getSettings, type AgentClient } from "./settings";

export type SetupReport = {
  owner?: string;
  onboardedAt?: string;
  tsrct: { found: boolean; path?: string; version?: string; wanted: string };
  ffmpeg: { found: boolean; path?: string; version?: string; encoder: string };
  bun: { path: string; version: string };
  mcp: { entry: string; exists: boolean };
  release?: { short: string; subject: string };
  t3: boolean;
  appDir: string;
  repo: string;
  roots: string[];
  clients: AgentClient[];
};

const versions = new Map<string, { sig: string; version?: string }>();

async function versionOf(exe: string, args: string[], parse: (out: string) => string | undefined) {
  let sig = "";
  try {
    sig = String(statSync(exe).mtimeMs);
  } catch {}
  const hit = versions.get(exe);
  if (hit && hit.sig === sig) return hit.version;
  let version: string | undefined;
  try {
    const r = await run([exe, ...args]);
    version = parse(`${new TextDecoder().decode(r.stdout)}\n${r.stderr}`);
  } catch {}
  versions.set(exe, { sig, version });
  return version;
}

function repoUrl() {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const url: string | undefined = pkg.repository?.url;
    if (url) return url.replace(/\.git$/, "");
  } catch {}
  return "https://github.com/IEver3st/dailies";
}

function release() {
  try {
    const r = JSON.parse(readFileSync(join(import.meta.dir, "..", "release.json"), "utf8"));
    return r.short ? { short: String(r.short), subject: String(r.subject ?? "") } : undefined;
  } catch {
    return undefined;
  }
}

export async function setupReport(roots: string[]): Promise<SetupReport> {
  const cli = tryFindCli();
  const settings = getSettings();
  const entry = join(APP_DIR, "mcp.mjs");
  return {
    owner: settings.owner,
    onboardedAt: settings.onboardedAt,
    tsrct: {
      found: !!cli,
      path: cli,
      version: cli ? await versionOf(cli, ["--version"], (out) => /(\d+\.\d+\.\d+[\w.-]*)/.exec(out)?.[1]) : undefined,
      wanted: TESSERACT_VERSION,
    },
    ffmpeg: {
      found: FFMPEG_FOUND,
      path: FFMPEG_FOUND ? FFMPEG : undefined,
      version: FFMPEG_FOUND ? await versionOf(FFMPEG, ["-version"], (out) => /ffmpeg version (\S+)/.exec(out)?.[1]?.replace(/-.*$/, "")) : undefined,
      encoder: await pickEncoder(),
    },
    bun: { path: process.execPath, version: Bun.version },
    mcp: { entry, exists: existsSync(entry) },
    release: release(),
    t3: !!t3Launcher(),
    appDir: APP_DIR,
    repo: repoUrl(),
    roots,
    clients: agentClients(),
  };
}
