import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, watch, linkSync, copyFileSync, rmSync, readdirSync, appendFileSync, renameSync, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { listZip, readZipEntry } from "./zip";
import { analyze, diffDocs, hash, type Analysis, type AssetTable, type Doc, canonical, findLayer } from "./doc";
import { cutDataDir, cutIdFor, normPath, readJson, writeJsonAtomic, REGISTRY_FILE } from "./paths";
import { emit } from "./events";
import { owner } from "./settings";
import type { Activity, Author, CutSummary, Note, Revision } from "./types";

export const RENDER_SETTINGS = { resolution: "1080p", fps: 60, segmentMs: 1000, keyframeMs: 500, version: 2, cli: "", encoder: "" };

export function configureRender(cli: string, encoder: string) {
  RENDER_SETTINGS.cli = cli;
  RENDER_SETTINGS.encoder = encoder;
}

export const keySignature = () => hash(RENDER_SETTINGS);

export const ATTRIBUTION_MS = 5 * 60_000;
const SNAPSHOT_KEEP = 6;
const SNAPSHOT_MIN = 2;
const SNAPSHOT_BUDGET = 3_000_000_000;
const COPY_LIMIT = 1_500_000_000;

const sameFile = (a: string, b: string) => {
  try {
    return statSync(a, { bigint: true }).ino === statSync(b, { bigint: true }).ino;
  } catch {
    return false;
  }
};

type Loaded = { doc: Doc; assets: AssetTable; raw: Buffer; hash: string };

function loadArchive(path: string): Loaded {
  const entries = listZip(path);
  const projectEntry = entries.get("project.json");
  if (!projectEntry) throw new Error("archive has no project.json");
  const raw = readZipEntry(path, projectEntry);
  const metaEntry = entries.get("metadata.json");
  const meta = metaEntry ? JSON.parse(readZipEntry(path, metaEntry).toString("utf8")) : {};
  const assets: AssetTable = meta.assets ?? {};
  const doc = JSON.parse(raw.toString("utf8")) as Doc;
  const assetSig = Object.fromEntries(Object.entries(assets).map(([k, a]) => [k, a.sha256 ?? a.byteLength ?? null]));
  return { doc, assets, raw, hash: hash(canonical(doc), assetSig) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function nowIso() {
  return new Date().toISOString();
}

export class Cut {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly dataDir: string;
  revisions: Revision[] = [];
  notes: Note[] = [];
  activity: Activity[] = [];
  agent?: { name: string; state: string; text: string; at: string };
  approvedRev?: number;
  collaborators: { thread: string; agent: string; at: string; link?: string }[] = [];
  pendingSelf?: { until: number; summary: string; size: number; mtimeMs: number };
  lastAgentTouch?: { name: string; at: number; summary?: string; addresses?: string[]; publishing?: boolean };
  readonly pinned = new Set<number>();
  private docs = new Map<number, { doc: Doc; assets: AssetTable }>();
  private analyses = new Map<number, Analysis>();
  private watcher?: FSWatcher;
  private ingestTimer?: ReturnType<typeof setTimeout>;
  private inflight?: Promise<Revision | undefined>;
  private ingestAgain = false;
  private inPlaceWriter = false;
  onRevision?: (cut: Cut, rev: Revision) => void;
  onSourceLost?: (cut: Cut, n: number) => void;

  constructor(path: string) {
    this.path = normPath(path);
    this.id = cutIdFor(this.path);
    this.name = basename(this.path, extname(this.path));
    this.folder = basename(dirname(this.path));
    this.dataDir = cutDataDir(this.path);
    mkdirSync(join(this.dataDir, "docs"), { recursive: true });
    mkdirSync(join(this.dataDir, "frames"), { recursive: true });
    const state = readJson<{ revisions: Revision[]; approvedRev?: number; agent?: Cut["agent"]; collaborators?: Cut["collaborators"] }>(join(this.dataDir, "revisions.json"), { revisions: [] });
    this.revisions = state.revisions ?? [];
    this.approvedRev = state.approvedRev;
    this.agent = state.agent;
    this.collaborators = state.collaborators ?? [];
    this.notes = readJson<{ notes: Note[] }>(join(this.dataDir, "notes.json"), { notes: [] }).notes ?? [];
    const actFile = join(this.dataDir, "activity.jsonl");
    if (existsSync(actFile)) {
      this.activity = readFileSync(actFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-400)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);
    }
    this.rekey();
  }

  private rekey() {
    const sig = keySignature();
    let changed = false;
    for (const r of this.revisions) {
      if (r.keySig === sig || !this.renderSource(r.n)) continue;
      const a = this.analysisFor(r.n);
      if (!a) continue;
      r.vkeys = a.vkeys;
      r.akeys = a.akeys;
      r.keySig = sig;
      changed = true;
    }
    if (changed) this.saveState();
  }

  get latest(): Revision | undefined {
    return this.revisions[this.revisions.length - 1];
  }

  revision(n?: number): Revision | undefined {
    if (n === undefined) return this.latest;
    return this.revisions.find((r) => r.n === n);
  }

  saveState() {
    writeJsonAtomic(join(this.dataDir, "revisions.json"), { cut: this.path, revisions: this.revisions, approvedRev: this.approvedRev, agent: this.agent, collaborators: this.collaborators });
  }

  saveNotes() {
    writeJsonAtomic(join(this.dataDir, "notes.json"), { cut: this.path, notes: this.notes });
  }

  addCollaborator(thread: string, agent: string, link?: string) {
    const prev = this.collaborators.find((c) => c.thread === thread);
    this.collaborators = [...this.collaborators.filter((c) => c.thread !== thread), { thread, agent, at: nowIso(), link: link ?? prev?.link }].slice(-4);
    this.saveState();
  }

  log(entry: Omit<Activity, "id" | "at"> & { at?: string }) {
    const a: Activity = { id: randomUUID().slice(0, 8), at: entry.at ?? nowIso(), ...entry } as Activity;
    this.activity.push(a);
    if (this.activity.length > 600) this.activity.splice(0, this.activity.length - 400);
    appendFileSync(join(this.dataDir, "activity.jsonl"), JSON.stringify(a) + "\n");
    emit({ type: "activity", cutId: this.id });
    return a;
  }

  docFor(n: number): { doc: Doc; assets: AssetTable } | undefined {
    const hit = this.docs.get(n);
    if (hit) return hit;
    const file = join(this.dataDir, "docs", `r${n}.json.gz`);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
    const value = { doc: parsed.doc as Doc, assets: parsed.assets as AssetTable };
    this.docs.set(n, value);
    if (this.docs.size > 6) this.docs.delete(this.docs.keys().next().value!);
    return value;
  }

  rawDocFile(n: number) {
    return join(this.dataDir, "docs", `r${n}.project.json`);
  }

  analysisFor(n: number): Analysis | undefined {
    const hit = this.analyses.get(n);
    if (hit) return hit;
    const d = this.docFor(n);
    if (!d) return undefined;
    const a = analyze(d.doc, d.assets, RENDER_SETTINGS);
    this.analyses.set(n, a);
    if (this.analyses.size > 4) this.analyses.delete(this.analyses.keys().next().value!);
    return a;
  }

  startWatching() {
    if (this.watcher) return;
    const dir = dirname(this.path);
    const file = basename(this.path).toLowerCase();
    try {
      const watcher = watch(dir, { persistent: true }, (_evt, name) => {
        if (!name || String(name).toLowerCase() !== file) return;
        this.scheduleIngest(400);
      });
      watcher.on("error", (e) => {
        console.error(`[dailies] stopped watching ${dir}: ${e}; polling instead`);
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch (e) {
      console.error(`[dailies] cannot watch ${dir}: ${e}`);
    }
  }

  stopWatching() {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private polledStamp?: string;
  private retry?: { stamp: string; attempts: number; nextAt: number };

  pollForChanges() {
    if (this.inflight || !this.latest || !existsSync(this.path)) return;
    const s = statSync(this.path);
    const stamp = `${s.size}:${s.mtimeMs}`;
    const stale = s.size !== this.latest.fileSize || s.mtimeMs !== this.latest.mtimeMs;
    const unchangedSinceLastPoll = stamp === this.polledStamp;
    this.polledStamp = stamp;
    if (!stale || !unchangedSinceLastPoll) return;
    const now = Date.now();
    const attempts = this.retry?.stamp === stamp ? this.retry.attempts : 0;
    if (attempts && now < this.retry!.nextAt) return;
    this.retry = { stamp, attempts: attempts + 1, nextAt: now + Math.min(300_000, 10_000 * 2 ** attempts) };
    console.log(`[dailies] ${this.name} on disk is newer than r${this.latest.n} and was not ingested; ingesting (attempt ${attempts + 1})`);
    this.scheduleIngest(0);
  }

  scheduleIngest(delay = 0) {
    clearTimeout(this.ingestTimer);
    this.ingestTimer = setTimeout(() => void this.ingest(), delay);
  }

  ingest(): Promise<Revision | undefined> {
    if (this.inflight) {
      this.ingestAgain = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      let made: Revision | undefined;
      try {
        do {
          this.ingestAgain = false;
          made = (await this.ingestOnce()) ?? made;
        } while (this.ingestAgain);
        return made;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private async waitStable(): Promise<{ size: number; mtimeMs: number } | undefined> {
    let prev: { size: number; mtimeMs: number } | undefined;
    for (let i = 0; i < 40; i++) {
      if (!existsSync(this.path)) {
        await sleep(300);
        continue;
      }
      const s = statSync(this.path);
      const cur = { size: s.size, mtimeMs: s.mtimeMs };
      if (prev && prev.size === cur.size && prev.mtimeMs === cur.mtimeMs) return cur;
      prev = cur;
      await sleep(250);
    }
    return prev;
  }

  private async ingestOnce(): Promise<Revision | undefined> {
    const stat = await this.waitStable();
    if (!stat) {
      emit({ type: "cut", cutId: this.id });
      return;
    }
    const prevSnapshot = this.latest?.snapshot;
    const inPlace = !!prevSnapshot && sameFile(prevSnapshot, this.path);
    const incoming = this.freeze(stat.size, inPlace || this.inPlaceWriter);
    const source = incoming ?? this.path;
    let loaded: Loaded | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        loaded = loadArchive(source);
        break;
      } catch (e) {
        lastErr = e;
        await sleep(400);
      }
    }
    if (!loaded) {
      if (incoming) rmSync(incoming, { force: true });
      console.error(`[dailies] cannot read ${this.path}: ${lastErr}`);
      return;
    }
    const after = statSync(this.path);
    if (after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) {
      if (incoming) rmSync(incoming, { force: true });
      this.ingestAgain = true;
      return;
    }
    const prev = this.latest;
    if (prev && prev.hash === loaded.hash) {
      if (incoming) rmSync(incoming, { force: true });
      if (prev.mtimeMs !== stat.mtimeMs) {
        prev.mtimeMs = stat.mtimeMs;
        prev.fileSize = stat.size;
        this.saveState();
      }
      return;
    }
    if (inPlace && prev?.snapshot) {
      try {
        rmSync(prev.snapshot, { force: true });
      } catch {}
      prev.snapshot = undefined;
      this.inPlaceWriter = true;
      console.error(`[dailies] ${this.name} was rewritten in place; r${prev.n} can no longer be restored and future snapshots are copies`);
      this.onSourceLost?.(this, prev.n);
    }
    const n = (prev?.n ?? 0) + 1;
    let snapshot: string | undefined;
    if (incoming) {
      snapshot = join(this.snapshotDir, `r${n}.tsrct`);
      try {
        renameSync(incoming, snapshot);
      } catch {
        snapshot = join(this.snapshotDir, `r${n}-${Date.now()}.tsrct`);
        renameSync(incoming, snapshot);
      }
    }
    writeFileSync(join(this.dataDir, "docs", `r${n}.json.gz`), gzipSync(JSON.stringify({ doc: loaded.doc, assets: loaded.assets })));
    writeFileSync(this.rawDocFile(n), loaded.raw);
    this.docs.set(n, { doc: loaded.doc, assets: loaded.assets });
    const analysis = analyze(loaded.doc, loaded.assets, RENDER_SETTINGS);
    this.analyses.set(n, analysis);
    const prevAnalysis = prev ? this.analysisFor(prev.n) : undefined;
    const changedSegments: number[] = [];
    for (let s = 0; s < analysis.segments; s++) {
      if (!prevAnalysis || prevAnalysis.vkeys[s] !== analysis.vkeys[s] || prevAnalysis.akeys[s] !== analysis.akeys[s]) changedSegments.push(s);
    }
    const author = this.attribute(stat);
    const rev: Revision = {
      n,
      hash: loaded.hash,
      at: nowIso(),
      author: author.author,
      summary: author.summary,
      addresses: author.addresses,
      changes: prev ? diffDocs(this.docFor(prev.n)?.doc, loaded.doc) : [],
      changedSegments,
      durationMs: analysis.durationMs,
      width: loaded.doc.dimensions?.width ?? 1920,
      height: loaded.doc.dimensions?.height ?? 1080,
      vkeys: analysis.vkeys,
      akeys: analysis.akeys,
      keySig: keySignature(),
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      snapshot,
      published: author.published || undefined,
    };
    this.revisions.push(rev);
    this.pruneSnapshots();
    this.checkOverwrites(rev, loaded.doc);
    this.markAddressed(rev, author.addresses);
    this.saveState();
    this.log({ author: rev.author, kind: "revision", rev: n, text: rev.summary ?? describeChanges(rev) });
    emit({ type: "revision", cutId: this.id, n });
    emit({ type: "cuts" });
    this.onRevision?.(this, rev);
    return rev;
  }

  private markAddressed(rev: Revision, ids?: string[]) {
    if (!ids?.length) return;
    let changed = false;
    for (const id of ids) {
      const note = this.notes.find((x) => x.id === id);
      if (!note || (note.status !== "open" && note.status !== "claimed")) continue;
      note.status = "addressed";
      note.updatedAt = nowIso();
      note.thread.push({ id: randomUUID().slice(0, 8), author: rev.author, text: `Addressed in r${rev.n}.`, at: nowIso(), rev: rev.n, status: "addressed" });
      changed = true;
    }
    if (changed) {
      this.saveNotes();
      emit({ type: "notes", cutId: this.id });
    }
  }

  async publishFromAgent(name: string, summary?: string, addresses?: string[]): Promise<{ rev?: Revision; reason?: string }> {
    this.lastAgentTouch = { name, at: Date.now(), summary, addresses, publishing: true };
    const made = await this.ingest();
    const touch = this.lastAgentTouch;
    if (touch?.publishing) this.lastAgentTouch = { name, at: touch.at };
    if (made?.published && made.author.kind === "agent" && made.author.name === name) return { rev: made };
    let r: Revision | undefined;
    let reason = "there is no revision yet";
    for (const x of [...this.revisions].reverse()) {
      if (x.author.kind === "you") {
        reason = `r${x.n} is ${owner("the user")}'s own edit and nothing of yours is unpublished before it`;
        continue;
      }
      if (x.published) {
        reason = `r${x.n} is already published`;
        break;
      }
      if (x.author.kind === "agent" && x.author.name === name) r = x;
      else if (x.author.kind === "unknown" && Date.now() - Date.parse(x.at) < ATTRIBUTION_MS) r = x;
      else reason = x.author.kind === "agent" ? `r${x.n} belongs to ${x.author.name} and is not published yet` : `r${x.n} is unattributed and older than 5 minutes`;
      break;
    }
    if (!r) return { reason };
    r.author = { kind: "agent", name };
    if (summary) r.summary = summary;
    r.addresses = addresses;
    r.published = true;
    this.markAddressed(r, addresses);
    this.saveState();
    this.log({ author: r.author, kind: "publish", rev: r.n, text: `Published r${r.n}${summary ? `: ${summary}` : ""}` });
    emit({ type: "revision", cutId: this.id, n: r.n });
    emit({ type: "cuts" });
    return { rev: r };
  }

  private attribute(stat: { size: number; mtimeMs: number }): { author: Author; summary?: string; addresses?: string[]; published?: boolean } {
    const now = Date.now();
    const self = this.pendingSelf;
    this.pendingSelf = undefined;
    if (self && self.until > now && self.size === stat.size && self.mtimeMs === stat.mtimeMs) {
      return { author: { kind: "you", name: "You" }, summary: self.summary, published: true };
    }
    const touch = this.lastAgentTouch;
    if (touch && now - touch.at < ATTRIBUTION_MS) {
      const out = { author: { kind: "agent" as const, name: touch.name }, summary: touch.summary, addresses: touch.addresses, published: touch.publishing };
      this.lastAgentTouch = { name: touch.name, at: touch.at };
      return out;
    }
    return { author: { kind: "unknown", name: "Unattributed" } };
  }

  get snapshotDir() {
    return join(this.dataDir, "snapshots");
  }

  private freeze(size: number, copy: boolean): string | undefined {
    mkdirSync(this.snapshotDir, { recursive: true });
    const target = join(this.snapshotDir, `incoming-${process.pid}.tsrct`);
    rmSync(target, { force: true });
    if (!copy) {
      try {
        linkSync(this.path, target);
        return target;
      } catch {}
    }
    if (size <= COPY_LIMIT) {
      try {
        copyFileSync(this.path, target);
        return target;
      } catch {}
    }
    return undefined;
  }

  private pruneSnapshots() {
    const keep = new Set<number>();
    let bytes = 0;
    for (const r of [...this.revisions].reverse()) {
      if (!r.snapshot || !existsSync(r.snapshot)) continue;
      const size = sameFile(r.snapshot, this.path) ? 0 : r.fileSize;
      if (keep.size >= SNAPSHOT_MIN && (keep.size >= SNAPSHOT_KEEP || bytes + size > SNAPSHOT_BUDGET)) break;
      keep.add(r.n);
      bytes += size;
    }
    if (this.approvedRev !== undefined) keep.add(this.approvedRev);
    for (const n of this.pinned) keep.add(n);
    const referenced = new Set(this.revisions.map((r) => r.snapshot?.toLowerCase()).filter(Boolean));
    let files: string[] = [];
    try {
      files = readdirSync(this.snapshotDir);
    } catch {}
    for (const f of files) {
      const p = join(this.snapshotDir, f);
      if (!/^r\d+(-\d+)?\.tsrct$/i.test(f) || referenced.has(p.toLowerCase())) continue;
      try {
        rmSync(p, { force: true });
      } catch {}
    }
    for (const r of this.revisions) {
      if (!keep.has(r.n) && r.snapshot) {
        try {
          rmSync(r.snapshot, { force: true });
          r.snapshot = undefined;
        } catch {}
      }
    }
  }

  renderSource(n: number): { path: string; live: boolean } | undefined {
    const r = this.revision(n);
    if (!r) return undefined;
    if (r.snapshot && existsSync(r.snapshot)) return { path: r.snapshot, live: false };
    if (r.n === this.latest?.n && existsSync(this.path)) return { path: this.path, live: true };
    return undefined;
  }

  liveMatches(n: number) {
    const r = this.revision(n);
    if (!r || !existsSync(this.path)) return false;
    const s = statSync(this.path);
    return s.mtimeMs === r.mtimeMs && s.size === r.fileSize;
  }

  private checkOverwrites(rev: Revision, doc: Doc) {
    if (rev.author.kind === "you") return;
    let changed = false;
    for (const note of this.notes as (Note & { expect?: { layerId: number; path: string[]; before: unknown; after: unknown }[]; applied?: boolean; conflict?: string })[]) {
      if (note.kind !== "edit" || note.applied === false || note.overwrittenIn || note.status === "resolved" || note.status === "wontfix" || !Array.isArray(note.expect)) continue;
      for (const exp of note.expect) {
        const layer = findLayer(doc, exp.layerId);
        const norm = (v: unknown) => (exp.path[0] === "hidden" ? v === true || undefined : v);
        const value = norm(layer ? exp.path.reduce<any>((o, k) => (o == null ? undefined : o[k]), layer) : undefined);
        const reverted = canonical(value) === canonical(norm(exp.before));
        const diverged = exp.after !== "__any__" && canonical(value) !== canonical(norm(exp.after));
        if (!layer || reverted || diverged) {
          note.overwrittenIn = rev.n;
          note.conflict = !layer ? "layer removed" : reverted ? "reverted" : "changed";
          note.updatedAt = nowIso();
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.saveNotes();
      emit({ type: "notes", cutId: this.id });
    }
  }

  summary(render: CutSummary["render"], poster?: string): CutSummary {
    const l = this.latest;
    return {
      id: this.id,
      path: this.path,
      name: this.name,
      folder: this.folder,
      latest: l ? { n: l.n, at: l.at, author: l.author, durationMs: l.durationMs, width: l.width, height: l.height, summary: l.summary ?? describeChanges(l), changed: l.changedSegments, segments: l.vkeys.length } : undefined,
      recent: this.revisions.slice(-6).map((r) => ({ n: r.n, at: r.at, author: r.author })),
      openNotes: this.notes.filter((n) => n.status === "open" || n.status === "claimed").length,
      draftNotes: this.notes.filter((n) => n.status === "draft").length,
      agent: this.agent,
      approvedRev: this.approvedRev,
      render,
      poster,
      missing: !existsSync(this.path),
    };
  }
}

export function describeChanges(rev: Revision) {
  if (rev.n === 1) return `First revision, ${(rev.durationMs / 1000).toFixed(1)} s at ${rev.width}x${rev.height}`;
  if (!rev.changes.length) return rev.changedSegments.length ? "Project settings or media changed" : "No visible changes";
  const parts = rev.changes.slice(0, 3).map((c) => {
    if (c.kind === "added") return `added ${c.name}`;
    if (c.kind === "removed") return `removed ${c.name}`;
    return `${c.name}: ${c.fields.join(", ")}${c.detail ? ` (${c.detail})` : ""}`;
  });
  const more = rev.changes.length > 3 ? `, +${rev.changes.length - 3} more` : "";
  return parts.join("; ") + more;
}

export class Registry {
  cuts = new Map<string, Cut>();
  roots: string[];
  onRevision?: (cut: Cut, rev: Revision) => void;
  onSourceLost?: (cut: Cut, n: number) => void;

  constructor() {
    const saved = readJson<{ cuts: string[]; roots?: string[] }>(REGISTRY_FILE, { cuts: [] });
    this.roots = saved.roots ?? [join(process.env.USERPROFILE ?? "", "Documents", "Tesseract")];
    for (const p of saved.cuts) {
      if (existsSync(p)) this.add(p, false);
    }
  }

  save() {
    writeJsonAtomic(REGISTRY_FILE, { cuts: [...this.cuts.values()].map((c) => c.path), roots: this.roots });
  }

  add(path: string, persist = true): Cut {
    const id = cutIdFor(path);
    let cut = this.cuts.get(id);
    if (cut) return cut;
    cut = new Cut(path);
    cut.onRevision = (c, r) => this.onRevision?.(c, r);
    cut.onSourceLost = (c, n) => this.onSourceLost?.(c, n);
    this.cuts.set(id, cut);
    cut.startWatching();
    cut.scheduleIngest(0);
    if (persist) {
      this.save();
      emit({ type: "cuts" });
    }
    return cut;
  }

  remove(id: string) {
    const cut = this.cuts.get(id);
    if (!cut) return;
    cut.stopWatching();
    this.cuts.delete(id);
    this.save();
    emit({ type: "cuts" });
  }

  get(idOrPath: string): Cut | undefined {
    return this.cuts.get(idOrPath) ?? this.cuts.get(cutIdFor(idOrPath));
  }

  setRoots(roots: string[]) {
    const seen = new Set<string>();
    this.roots = roots.map(normPath).filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
    this.save();
    emit({ type: "library" });
  }

  scanLibrary(): { path: string; folder: string; name: string; mtimeMs: number; size: number; registered: boolean }[] {
    const out: { path: string; folder: string; name: string; mtimeMs: number; size: number; registered: boolean }[] = [];
    const skip = (d: string) => d.startsWith(".") || /^(versions|final|previews|sources|captures|brainstorm|node_modules)$/i.test(d);
    const visit = (dir: string, depth: number) => {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 2 && !skip(e.name)) visit(p, depth + 1);
        } else if (e.name.toLowerCase().endsWith(".tsrct")) {
          try {
            const s = statSync(p);
            out.push({ path: normPath(p), folder: basename(dir), name: basename(e.name, ".tsrct"), mtimeMs: s.mtimeMs, size: s.size, registered: this.cuts.has(cutIdFor(p)) });
          } catch {}
        }
      }
    };
    for (const root of this.roots) visit(root, 0);
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
}
