import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR, AUDIO_CACHE, FRAME_CACHE, MOVIE_CACHE, POSTER_CACHE, SLATE_CACHE, THUMB_CACHE, VIDEO_CACHE, readJson, writeJsonAtomic } from "./paths";
import { emit } from "./events";

export type ServiceSettings = { cacheGb: number; renderSlots: number };

export const CACHE_CHOICES = [5, 10, 20, 50, 100, 200];
export const SLOT_CHOICES = [1, 2, 3, 4, 6, 8];
export const SERVICE_DEFAULTS: ServiceSettings = {
  cacheGb: CACHE_CHOICES.includes(Number(process.env.DAILIES_CACHE_GB)) ? Number(process.env.DAILIES_CACHE_GB) : 20,
  renderSlots: 3,
};

const FILE = join(APP_DIR, "service.json");

function clean(raw: Partial<Record<keyof ServiceSettings, unknown>>, base: ServiceSettings): ServiceSettings {
  const out = { ...base };
  if (CACHE_CHOICES.includes(raw.cacheGb as number)) out.cacheGb = raw.cacheGb as number;
  if (SLOT_CHOICES.includes(raw.renderSlots as number)) out.renderSlots = raw.renderSlots as number;
  return out;
}

let current = clean(readJson(FILE, {}), SERVICE_DEFAULTS);
const listeners = new Set<(s: ServiceSettings) => void>();

export const serviceSettings = () => current;
export const cacheLimitBytes = () => current.cacheGb * 1e9;

export function updateService(patch: Partial<Record<keyof ServiceSettings, unknown>>) {
  const next = clean(patch, current);
  if (next.cacheGb === current.cacheGb && next.renderSlots === current.renderSlots) return current;
  current = next;
  writeJsonAtomic(FILE, current);
  for (const l of listeners) l(current);
  emit({ type: "service" });
  return current;
}

export function onServiceChange(fn: (s: ServiceSettings) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type CacheUsage = { total: number; kinds: { id: string; label: string; bytes: number; files: number }[] };

const KINDS = [
  { id: "video", label: "Video segments", dirs: [VIDEO_CACHE] },
  { id: "movies", label: "Assembled cuts", dirs: [MOVIE_CACHE] },
  { id: "audio", label: "Audio", dirs: [AUDIO_CACHE] },
  { id: "stills", label: "Frames and thumbnails", dirs: [FRAME_CACHE, THUMB_CACHE, POSTER_CACHE, SLATE_CACHE] },
];

function sizeOf(dir: string) {
  let bytes = 0;
  let files = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { bytes, files };
  }
  for (const n of names) {
    try {
      const s = statSync(join(dir, n));
      if (s.isFile()) {
        bytes += s.size;
        files++;
      }
    } catch {}
  }
  return { bytes, files };
}

export function cacheUsage(): CacheUsage {
  const kinds = KINDS.map((k) => {
    const parts = k.dirs.map(sizeOf);
    return { id: k.id, label: k.label, bytes: parts.reduce((a, p) => a + p.bytes, 0), files: parts.reduce((a, p) => a + p.files, 0) };
  });
  return { total: kinds.reduce((a, k) => a + k.bytes, 0), kinds };
}
