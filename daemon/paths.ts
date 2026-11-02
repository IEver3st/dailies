import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";

export const APP_DIR = process.env.DAILIES_HOME ? resolve(process.env.DAILIES_HOME) : join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local"), "Dailies");
export const CACHE_DIR = join(APP_DIR, "cache");
export const VIDEO_CACHE = join(CACHE_DIR, "v");
export const AUDIO_CACHE = join(CACHE_DIR, "a");
export const MOVIE_CACHE = join(CACHE_DIR, "movies");
export const SLATE_CACHE = join(CACHE_DIR, "slates");
export const FRAME_CACHE = join(CACHE_DIR, "frames");
export const THUMB_CACHE = join(CACHE_DIR, "thumbs");
export const POSTER_CACHE = join(CACHE_DIR, "posters");
export const JOB_DIR = join(APP_DIR, "jobs");
export const BIN_DIR = join(APP_DIR, "bin");
export const DAEMON_FILE = join(APP_DIR, "daemon.json");
export const REGISTRY_FILE = join(APP_DIR, "registry.json");
export const DEFAULT_PORT = 47800;
export const HOME_ID = createHash("sha1").update(APP_DIR.toLowerCase()).digest("hex").slice(0, 12);

for (const d of [APP_DIR, VIDEO_CACHE, AUDIO_CACHE, MOVIE_CACHE, SLATE_CACHE, FRAME_CACHE, THUMB_CACHE, POSTER_CACHE, JOB_DIR, BIN_DIR]) mkdirSync(d, { recursive: true });

export function normPath(p: string) {
  return resolve(p).replace(/\//g, "\\");
}

export function cutIdFor(path: string) {
  return createHash("sha1").update(normPath(path).toLowerCase()).digest("hex").slice(0, 12);
}

export function cutDataDir(path: string) {
  const stem = basename(path, extname(path));
  return join(dirname(path), ".dailies", stem);
}

export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
