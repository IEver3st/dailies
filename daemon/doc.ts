import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Layer = { id: number; name?: string; type?: string; layers?: Layer[]; [k: string]: any };
export type Doc = {
  composition: { id: string; layers: Layer[]; dynamics?: { entries?: any[] }; [k: string]: any };
  dimensions: { width: number; height: number };
  duration: number;
  [k: string]: any;
};
export type AssetTable = Record<string, { path?: string; kind?: string; sha256?: string; byteLength?: number }>;

export const SEGMENT_MS = 1000;

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
}

export function hash(...parts: unknown[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(typeof p === "string" ? p : canonical(p)).update("\u0000");
  return h.digest("hex");
}

export function durationMs(doc: Doc) {
  return Math.round(doc.duration * 1000);
}

export function segmentCount(doc: Doc) {
  return Math.max(1, Math.ceil(durationMs(doc) / SEGMENT_MS));
}

export type Window = { start: number; end: number };
const ALWAYS: Window = { start: -Infinity, end: Infinity };

export function layerWindow(layer: Layer): Window {
  const pb = layer.playback;
  if (pb && pb.type === "windowed" && pb.inputRange) {
    return { start: pb.inputRange.start, end: pb.inputRange.start + pb.inputRange.duration };
  }
  if (layer.activeRange && typeof layer.activeRange.start === "number") {
    return { start: layer.activeRange.start, end: layer.activeRange.start + layer.activeRange.duration };
  }
  return ALWAYS;
}

export function mapLocal(layer: Layer, parentTime: number): number | undefined {
  const pb = layer.playback;
  if (pb && pb.type === "windowed") {
    const m = pb.mapping;
    if (m?.type === "linear" && m.input && m.output) {
      const rate = m.input.duration > 0 ? m.output.duration / m.input.duration : 1;
      return m.output.start + (parentTime - m.input.start) * rate;
    }
    return undefined;
  }
  if (layer.activeRange) return parentTime - layer.activeRange.start;
  return parentTime;
}

export function walk(layers: Layer[], visit: (layer: Layer, path: Layer[]) => void, path: Layer[] = []) {
  for (const layer of layers) {
    visit(layer, path);
    if (Array.isArray(layer.layers)) walk(layer.layers, visit, [...path, layer]);
  }
}

function collectIds(layer: Layer, into: Set<number>) {
  into.add(layer.id);
  for (const child of layer.layers ?? []) collectIds(child, into);
}

function scan(value: any, fn: (key: string, v: any) => void) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) scan(v, fn);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    fn(k, v);
    scan(v, fn);
  }
}

const AUDIBLE = new Set(["Audio", "Video"]);

type TopInfo = {
  layer: Layer;
  window: Window;
  ids: Set<number>;
  refs: Set<number>;
  visual: boolean;
  audible: boolean;
  vOwn: string;
  aOwn: string;
};

export type Analysis = {
  doc: Doc;
  durationMs: number;
  segments: number;
  globalKey: string;
  tops: TopInfo[];
  topOf: Map<number, number>;
  vkeys: string[];
  akeys: string[];
};

const AUDIO_FIELDS = new Set(["volume", "audioEnhancement", "mediaAudioEnhancement", "preserveAudioPitch", "audioGain", "audioGainLeft", "audioGainRight", "audioGainBoth"]);

function stripAudio(value: any): any {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripAudio);
  const out: any = {};
  for (const [k, v] of Object.entries(value)) {
    if (AUDIO_FIELDS.has(k)) continue;
    if (k === "layers" && Array.isArray(v)) {
      out[k] = v.filter((l: Layer) => !(l?.type === "Audio" && !l.captionsEnabled)).map(stripAudio);
      continue;
    }
    out[k] = stripAudio(v);
  }
  return out;
}

function isVisualLayer(layer: Layer): boolean {
  let visual = false;
  walk([layer], (l) => {
    if (l.type === "Group") return;
    if (l.type === "Audio") {
      if (l.captionsEnabled) visual = true;
      return;
    }
    visual = true;
  });
  return visual;
}

export function analyze(doc: Doc, assets: AssetTable, settings: Record<string, unknown>): Analysis {
  const topOf = new Map<number, number>();
  const effectOwners = new Map<number, Set<number>>();
  doc.composition.layers.forEach((layer, index) => {
    walk([layer], (l) => {
      topOf.set(l.id, index);
      const fxs = [...(Array.isArray(l.effects) ? l.effects : []), ...(Array.isArray(l.styles) ? l.styles : [])];
      for (const fx of fxs) {
        if (typeof fx?.id !== "number") continue;
        if (!effectOwners.has(fx.id)) effectOwners.set(fx.id, new Set());
        effectOwners.get(fx.id)!.add(index);
      }
    });
  });

  const dynByTop = new Map<number, any[]>();
  const globalDyn: any[] = [];
  for (const entry of doc.composition.dynamics?.entries ?? []) {
    const t = entry?.target;
    let owner: number | undefined;
    if (typeof t?.layerId === "number") owner = topOf.get(t.layerId);
    else if (t?.kind === "effectProperty" && typeof t.effectId === "number") {
      const owners = effectOwners.get(t.effectId);
      if (owners?.size === 1) owner = [...owners][0];
    }
    if (owner === undefined) globalDyn.push(entry);
    else {
      if (!dynByTop.has(owner)) dynByTop.set(owner, []);
      dynByTop.get(owner)!.push(entry);
    }
  }

  const { layers, dynamics, name: _compName, id: _compId, ...compRest } = doc.composition;
  const { composition, duration, $schema: _schema, ...docRest } = doc;
  const fontTable = Object.fromEntries(
    Object.entries(assets).filter(([, a]) => a.kind === "font").map(([k, a]) => [k, a.sha256 ?? a.byteLength ?? null]),
  );
  const globalKey = hash(settings, docRest, compRest, globalDyn, fontTable);

  const tops: TopInfo[] = doc.composition.layers.map((layer, index) => {
    const ids = new Set<number>();
    collectIds(layer, ids);
    const refs = new Set<number>();
    let unresolved = false;
    const assetIds = new Set<string>();
    const ownDyn = dynByTop.get(index) ?? [];
    const visitRefs = (k: string, v: any) => {
      if (k === "assetId" && typeof v === "string") assetIds.add(v);
      const found: number[] = [];
      if (/layer_?id$/i.test(k) && typeof v === "number") found.push(v);
      if (/layer_?ids$/i.test(k) && Array.isArray(v)) for (const x of v) if (typeof x === "number") found.push(x);
      for (const id of found) {
        if (ids.has(id)) continue;
        const owner = topOf.get(id);
        if (owner === undefined) unresolved = true;
        else refs.add(owner);
      }
    };
    scan(layer, visitRefs);
    for (const entry of ownDyn) scan(entry.animator ?? {}, visitRefs);
    const assetsList = [...assetIds].sort().map((a) => `${a}:${assets[a]?.sha256 ?? assets[a]?.byteLength ?? "?"}`);
    let audible = false;
    walk([layer], (l) => {
      if (AUDIBLE.has(l.type ?? "")) audible = true;
    });
    const visual = isVisualLayer(layer);
    return {
      layer,
      window: unresolved ? ALWAYS : layerWindow(layer),
      ids,
      refs,
      visual,
      audible,
      vOwn: visual ? hash(stripAudio(layer), ownDyn, assetsList) : "",
      aOwn: audible ? hash(layer, ownDyn, assetsList) : "",
    };
  });

  const total = durationMs(doc);
  const segments = Math.max(1, Math.ceil(total / SEGMENT_MS));
  const frame = 1000 / Number(settings.fps ?? 60);
  const videoGuard = 2 * frame;
  const audioGuard = frame;

  const keyFor = (s: number, guard: number, audio: boolean) => {
    const segEnd = Math.min(total, (s + 1) * SEGMENT_MS);
    const a = s * SEGMENT_MS - guard;
    const b = segEnd + guard;
    const included = new Set<number>();
    tops.forEach((top, i) => {
      if (audio ? !top.audible : !top.visual) return;
      if (top.window.end > a && top.window.start < b) included.add(i);
    });
    const queue = [...included];
    while (queue.length) {
      const i = queue.pop()!;
      for (const j of tops[i].refs) {
        if (included.has(j)) continue;
        included.add(j);
        queue.push(j);
      }
    }
    const parts = [...included]
      .sort((x, y) => x - y)
      .map((i) => `${tops[i].layer.id}:${audio ? tops[i].aOwn || tops[i].vOwn : tops[i].vOwn || tops[i].aOwn}`);
    return hash(audio ? "a" : "v", globalKey, s, segEnd - s * SEGMENT_MS, parts);
  };

  const vkeys: string[] = [];
  const akeys: string[] = [];
  for (let s = 0; s < segments; s++) {
    vkeys.push(keyFor(s, videoGuard, false));
    akeys.push(keyFor(s, audioGuard, true));
  }
  return { doc, durationMs: total, segments, globalKey, tops, topOf, vkeys, akeys };
}

export type ContextLayer = {
  id: number;
  name: string;
  type: string;
  path: string[];
  text?: string;
  asset?: string;
  sourceMs?: number;
  hidden?: boolean;
  volume?: number;
};

export function contextAt(doc: Doc, t: number): ContextLayer[] {
  const out: ContextLayer[] = [];
  const visit = (layers: Layer[], parentTime: number | undefined, path: string[], hiddenAbove: boolean) => {
    for (const layer of layers) {
      const w = layerWindow(layer);
      if (parentTime === undefined) continue;
      if (!(parentTime >= w.start && parentTime < w.end)) continue;
      const local = mapLocal(layer, parentTime);
      const hidden = hiddenAbove || layer.hidden === true;
      const item: ContextLayer = {
        id: layer.id,
        name: layer.name ?? `${layer.type} ${layer.id}`,
        type: layer.type ?? "Layer",
        path,
      };
      if (hidden) item.hidden = true;
      if (layer.type === "Text" && typeof layer.sourceText?.text === "string") item.text = layer.sourceText.text;
      if (layer.source?.assetId) item.asset = layer.source.assetId;
      if ((layer.type === "Video" || layer.type === "Audio") && local !== undefined) item.sourceMs = Math.round(local);
      if (typeof layer.volume === "number") item.volume = layer.volume;
      if (layer.type !== "Group") out.push(item);
      if (Array.isArray(layer.layers)) visit(layer.layers, layer.type === "Group" ? local : parentTime, [...path, item.name], hidden);
    }
  };
  visit(doc.composition.layers, t, [], false);
  return out;
}

export type LayerChange = {
  id: number;
  name: string;
  type: string;
  kind: "added" | "removed" | "changed";
  fields: string[];
  detail?: string;
};

function flatten(doc: Doc) {
  const map = new Map<number, { layer: Layer; path: string[] }>();
  walk(doc.composition.layers, (layer, path) => map.set(layer.id, { layer, path: path.map((p) => p.name ?? String(p.id)) }));
  return map;
}

const FIELD_LABELS: Record<string, string> = {
  activeRange: "timing",
  playback: "timing",
  sourceRange: "source trim",
  sourceText: "text",
  transform: "transform",
  volume: "volume",
  hidden: "visibility",
  source: "media",
  effects: "effects",
  rect: "shape",
  shape: "shape",
  name: "name",
  blendMode: "blend",
  masks: "masks",
};

export function diffDocs(before: Doc | undefined, after: Doc): LayerChange[] {
  const changes: LayerChange[] = [];
  const a = before ? flatten(before) : new Map();
  const b = flatten(after);
  const dynFor = (doc: Doc | undefined) => {
    const m = new Map<number, string>();
    for (const e of doc?.composition.dynamics?.entries ?? []) {
      const id = e?.target?.layerId;
      if (typeof id === "number") m.set(id, (m.get(id) ?? "") + canonical(e));
    }
    return m;
  };
  const da = dynFor(before);
  const db = dynFor(after);
  for (const [id, { layer }] of b) {
    const prev = a.get(id);
    if (!prev) {
      changes.push({ id, name: layer.name ?? String(id), type: layer.type ?? "Layer", kind: "added", fields: [] });
      continue;
    }
    const fields = new Set<string>();
    const keys = new Set([...Object.keys(layer), ...Object.keys(prev.layer)]);
    for (const k of keys) {
      if (k === "layers") continue;
      if (canonical(layer[k]) !== canonical(prev.layer[k])) fields.add(FIELD_LABELS[k] ?? k);
    }
    if ((da.get(id) ?? "") !== (db.get(id) ?? "")) fields.add("animation");
    if (fields.size) {
      let detail: string | undefined;
      if (fields.has("text")) detail = `"${prev.layer.sourceText?.text ?? ""}" -> "${layer.sourceText?.text ?? ""}"`;
      else if (fields.has("volume")) detail = `${toDb(prev.layer.volume)} -> ${toDb(layer.volume)}`;
      else if (fields.has("timing")) {
        const w0 = layerWindow(prev.layer);
        const w1 = layerWindow(layer);
        if (Number.isFinite(w0.start) && Number.isFinite(w1.start)) detail = `${fmt(w0.start)}-${fmt(w0.end)} -> ${fmt(w1.start)}-${fmt(w1.end)}`;
      }
      changes.push({ id, name: layer.name ?? String(id), type: layer.type ?? "Layer", kind: "changed", fields: [...fields], detail });
    }
  }
  for (const [id, { layer }] of a) {
    if (!b.has(id)) changes.push({ id, name: layer.name ?? String(id), type: layer.type ?? "Layer", kind: "removed", fields: [] });
  }
  return changes;
}

function toDb(v: unknown) {
  if (typeof v !== "number") return "?";
  if (v <= 0) return "-inf dB";
  return `${(20 * Math.log10(v)).toFixed(1)} dB`;
}

function fmt(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`;
}

export type TrackItem = {
  id: number;
  name: string;
  type: string;
  start: number;
  end: number;
  hidden?: boolean;
  volume?: number;
  text?: string;
  asset?: string;
  children?: number;
  editable: { timing: boolean; text: boolean; volume: boolean };
};

export function timelineItems(doc: Doc): TrackItem[] {
  const total = durationMs(doc);
  return doc.composition.layers.map((layer) => {
    const w = layerWindow(layer);
    const texts: string[] = [];
    walk([layer], (l) => {
      if (l.type === "Text" && typeof l.sourceText?.text === "string") texts.push(l.sourceText.text);
    });
    return {
      id: layer.id,
      name: layer.name ?? `${layer.type} ${layer.id}`,
      type: layer.type ?? "Layer",
      start: Number.isFinite(w.start) ? w.start : 0,
      end: Number.isFinite(w.end) ? w.end : total,
      hidden: layer.hidden === true || undefined,
      volume: typeof layer.volume === "number" ? layer.volume : undefined,
      text: texts.length ? texts.join(" / ") : undefined,
      asset: layer.source?.assetId,
      children: layer.layers?.length,
      editable: {
        timing: Number.isFinite(w.start),
        text: layer.type === "Text",
        volume: layer.type === "Audio" || layer.type === "Video",
      },
    };
  });
}

export function findLayer(doc: Doc, id: number): Layer | undefined {
  let found: Layer | undefined;
  walk(doc.composition.layers, (l) => {
    if (l.id === id) found = l;
  });
  return found;
}

function toParent(layer: Layer, local: number): number {
  const pb = layer.playback;
  if (pb && pb.type === "windowed") {
    const m = pb.mapping;
    if (m?.type === "linear" && m.input && m.output) {
      const rate = m.input.duration > 0 ? m.output.duration / m.input.duration : 1;
      return m.input.start + (local - m.output.start) / (rate || 1);
    }
    return pb.inputRange?.start ?? local;
  }
  if (layer.activeRange) return local + layer.activeRange.start;
  return local;
}

export function absoluteWindow(doc: Doc, id: number): Window | undefined {
  let hit: { layer: Layer; path: Layer[] } | undefined;
  walk(doc.composition.layers, (layer, path) => {
    if (layer.id === id) hit = { layer, path };
  });
  if (!hit) return undefined;
  const w = layerWindow(hit.layer);
  let start = Number.isFinite(w.start) ? w.start : 0;
  let end = Number.isFinite(w.end) ? w.end : durationMs(doc);
  for (const parent of [...hit.path].reverse()) {
    start = toParent(parent, start);
    end = toParent(parent, end);
    const pw = layerWindow(parent);
    if (Number.isFinite(pw.start)) start = Math.max(start, pw.start);
    if (Number.isFinite(pw.end)) end = Math.min(end, pw.end);
  }
  return { start, end };
}
