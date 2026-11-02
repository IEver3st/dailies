import { existsSync, openSync, readSync, closeSync, statSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { listZip, readZipEntry, entryDataStart, type ZipEntry } from "./zip";
import { contextAt, type AssetTable, type Doc } from "./doc";
import { POSTER_CACHE, normPath } from "./paths";
import { FFMPEG, run } from "./media";

export type ProjectInfo = { durationMs: number; width: number; height: number };
type Source = { entry: ZipEntry; video: boolean; ms: number };
type Known = { sig: string; info?: ProjectInfo; source?: Source; error?: string };

const known = new Map<string, Known>();
const failed = new Map<string, string>();
const CHUNK = 1 << 20;
export const POSTER_SHORT_SIDE = 480;

const signature = (path: string) => {
  const s = statSync(path);
  return `${Math.round(s.mtimeMs)}-${s.size}`;
};

function pickSource(doc: Doc, assets: AssetTable, entries: Map<string, ZipEntry>): Source | undefined {
  const entryOf = (assetId?: string) => {
    const p = assetId ? assets[assetId]?.path : undefined;
    return p ? entries.get(p) : undefined;
  };
  const durationMs = Math.round(doc.duration * 1000);
  const t = Math.min(durationMs * 0.3, 2500);
  const live = contextAt(doc, t).filter((l) => !l.hidden && l.asset && (l.type === "Video" || l.type === "Image"));
  const ranked = (type: string) =>
    live
      .filter((l) => l.type === type)
      .map((l) => ({ l, e: entryOf(l.asset) }))
      .filter((x): x is { l: typeof x.l; e: ZipEntry } => !!x.e && x.e.method === 0)
      .sort((a, b) => b.e.size - a.e.size);
  const video = ranked("Video")[0];
  if (video) return { entry: video.e, video: true, ms: Math.max(0, video.l.sourceMs ?? 0) };
  const byKind = (kind: string) =>
    Object.values(assets)
      .filter((a) => a.kind === kind && a.path)
      .map((a) => entries.get(a.path!))
      .filter((e): e is ZipEntry => !!e && e.method === 0)
      .sort((a, b) => b.size - a.size)[0];
  const anyVideo = byKind("video");
  if (anyVideo) return { entry: anyVideo, video: true, ms: 1500 };
  const images = ranked("Image");
  const image = images.find((x) => !TEXTURE.test(`${x.l.name} ${x.e.name}`)) ?? images[0];
  if (image) return { entry: image.e, video: false, ms: 0 };
  const anyImage = byKind("image");
  return anyImage ? { entry: anyImage, video: false, ms: 0 } : undefined;
}

const TEXTURE = /paper|texture|grain|noise|grunge|tile|pattern|vignette|overlay|mask|\bbg\b|background/i;

export function groupOf(path: string, roots: string[]) {
  const p = normPath(path);
  for (const r of roots) {
    const root = normPath(r);
    if (p.toLowerCase().startsWith(root.toLowerCase() + sep)) {
      const parts = p.slice(root.length + 1).split(sep);
      return parts.length > 1 ? parts[0] : root.split(sep).pop() ?? "";
    }
  }
  return "";
}

function inspect(path: string): Known {
  const sig = signature(path);
  const hit = known.get(path);
  if (hit && hit.sig === sig) return hit;
  let k: Known;
  try {
    const entries = listZip(path);
    const projectEntry = entries.get("project.json");
    if (!projectEntry) throw new Error("no project.json");
    const doc = JSON.parse(readZipEntry(path, projectEntry).toString("utf8")) as Doc;
    const metaEntry = entries.get("metadata.json");
    const assets: AssetTable = metaEntry ? (JSON.parse(readZipEntry(path, metaEntry).toString("utf8")).assets ?? {}) : {};
    k = {
      sig,
      info: { durationMs: Math.round((doc.duration ?? 0) * 1000), width: doc.dimensions?.width ?? 1080, height: doc.dimensions?.height ?? 1920 },
      source: pickSource(doc, assets, entries),
    };
  } catch (e) {
    k = { sig, error: e instanceof Error ? e.message : String(e) };
  }
  known.set(path, k);
  return k;
}

export function projectInfo(path: string): (ProjectInfo & { poster: boolean }) | undefined {
  try {
    const k = inspect(path);
    return k.info && { ...k.info, poster: !!k.source };
  } catch {
    return undefined;
  }
}

export function inRoots(path: string, roots: string[]) {
  const p = normPath(path).toLowerCase();
  return /\.tsrct$/i.test(p) && roots.some((r) => p.startsWith(normPath(r).toLowerCase() + sep));
}

export function entryRange(path: string, name: string, sig: string): { start: number; size: number } | undefined {
  const k = inspect(path);
  if (k.sig !== sig || !k.source || k.source.entry.name !== name) return undefined;
  return { start: entryDataStart(path, k.source.entry), size: k.source.entry.size };
}

export function chunkedStream(path: string, from: number, to: number, sig: string) {
  let pos = from;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos > to) return controller.close();
      if (signature(path) !== sig) return controller.error(new Error("project changed while reading"));
      const len = Math.min(CHUNK, to - pos + 1);
      const buf = Buffer.alloc(len);
      const fd = openSync(path, "r");
      let n = 0;
      try {
        n = readSync(fd, buf, 0, len, pos);
      } finally {
        closeSync(fd);
      }
      if (n <= 0) return controller.close();
      pos += n;
      controller.enqueue(buf.subarray(0, n));
    },
  });
}

let slots = 2;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (slots === 0) await new Promise<void>((r) => waiting.push(r));
  slots--;
  try {
    return await fn();
  } finally {
    slots++;
    waiting.shift()?.();
  }
}

const building = new Map<string, Promise<string | undefined>>();

export function libraryPoster(path: string, entryUrl: (name: string, sig: string) => string): Promise<string | undefined> {
  const k = inspect(path);
  const out = join(POSTER_CACHE, `${createHash("sha1").update(normPath(path).toLowerCase()).digest("hex").slice(0, 16)}-${k.sig}-p2.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  if (!k.source || failed.get(out) === k.sig) return Promise.resolve(undefined);
  let p = building.get(out);
  if (p) return p;
  const source = k.source;
  p = limited(async () => {
    const tmp = `${out}.part.jpg`;
    const scale = `scale=w='if(gt(iw\\,ih)\\,-2\\,${POSTER_SHORT_SIDE})':h='if(gt(iw\\,ih)\\,${POSTER_SHORT_SIDE}\\,-2)':flags=bicubic`;
    const input = entryUrl(source.entry.name, k.sig);
    const seek = source.video ? ["-ss", (source.ms / 1000).toFixed(3)] : [];
    try {
      const r = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...seek, "-i", input, "-vf", scale, "-frames:v", "1", "-q:v", "3", "-update", "1", tmp]);
      if (r.code !== 0 || !existsSync(tmp)) {
        if (source.video && source.ms > 0) {
          const again = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vf", scale, "-frames:v", "1", "-q:v", "3", "-update", "1", tmp]);
          if (again.code !== 0 || !existsSync(tmp)) throw new Error(again.stderr.trim().split("\n").pop());
        } else throw new Error(r.stderr.trim().split("\n").pop());
      }
      renameSync(tmp, out);
      return out;
    } catch (e) {
      failed.set(out, k.sig);
      console.log(`[dailies] no library poster for ${path}: ${e instanceof Error ? e.message : e}`);
      return undefined;
    } finally {
      rmSync(tmp, { force: true });
    }
  }).finally(() => building.delete(out));
  building.set(out, p);
  return p;
}

export function resolveLibraryPath(raw: string | null, roots: string[]) {
  if (!raw) return undefined;
  const p = resolve(raw);
  return inRoots(p, roots) && existsSync(p) ? p : undefined;
}
