import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { exportSpan, tryFindCli } from "./tsrct";
import { FFMPEG, FFMPEG_FOUND, pickEncoder, probeVideo } from "./media";
import { JOB_DIR, readJson, writeJsonAtomic } from "./paths";
import { emit } from "./events";
import { SHIM, taskkillTree } from "./render";
import { nowIso, type Cut } from "./cuts";
import type { Author } from "./types";

export const EXPORT_PROFILE = { resolution: "4k", fps: 60, label: "4K60" } as const;

export type ExportRecord = { id: string; rev: number; file: string; at: string; bytes: number; ms: number; encoder: string; width?: number; height?: number };

type Phase = "waiting" | "starting" | "rendering" | "finishing";

type Job = {
  id: string;
  cut: Cut;
  rev: number;
  author: Author;
  phase: Phase;
  queuedAt: number;
  startedAt?: number;
  completed: number;
  total: number;
  rate?: number;
  eta?: number;
  reportedAt?: number;
  file?: string;
  temp?: string;
  cancelled?: boolean;
  kill?: () => void;
  stop?: () => void;
};

const TEMP_PATTERN = /\.[0-9a-f]{8}\.part\.mp4/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sourceStamp(path: string) {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch {
    return "gone";
  }
}

function tail(msg: string) {
  return msg.length > 600 ? `...${msg.slice(-600)}` : msg;
}

export function exportReadiness(): { ok: boolean; reason?: string } {
  const cli = tryFindCli();
  if (!cli && !FFMPEG_FOUND) return { ok: false, reason: "Install the Tesseract CLI and ffmpeg to export" };
  if (!cli) return { ok: false, reason: "Install the Tesseract CLI to export" };
  if (!FFMPEG_FOUND) return { ok: false, reason: "Install ffmpeg to export" };
  return { ok: true };
}

export class Exporter {
  private queue: Job[] = [];
  private current?: Job;
  private failures = new Map<string, { rev: number; error: string; at: string }>();
  private swept = new Set<string>();

  constructor() {
    process.on("exit", () => {
      this.current?.stop?.();
    });
  }

  private historyFile(cut: Cut) {
    return join(cut.dataDir, "exports.json");
  }

  history(cut: Cut): ExportRecord[] {
    return readJson<{ exports: ExportRecord[] }>(this.historyFile(cut), { exports: [] }).exports ?? [];
  }

  private record(cut: Cut, r: ExportRecord) {
    const list = [...this.history(cut).filter((x) => x.file.toLowerCase() !== r.file.toLowerCase()), r].slice(-40);
    writeJsonAtomic(this.historyFile(cut), { cut: cut.path, exports: list });
  }

  stateFor(cut: Cut) {
    const all = [this.current, ...this.queue].filter((j): j is Job => !!j);
    const job = all.find((j) => j.cut.id === cut.id);
    const ahead = job ? all.indexOf(job) : 0;
    return {
      profile: EXPORT_PROFILE.label,
      ready: exportReadiness(),
      job: job
        ? {
            id: job.id,
            rev: job.rev,
            phase: job.phase,
            ahead,
            progress: job.total ? Math.min(job.phase === "finishing" ? 1 : 0.99, job.completed / job.total) : 0,
            completed: job.completed,
            total: job.total,
            rate: job.rate,
            etaMs: job.eta !== undefined ? Math.round(job.eta * 1000) : undefined,
            reportedAt: job.reportedAt,
            startedAt: job.startedAt,
            queuedAt: job.queuedAt,
            file: job.file,
          }
        : undefined,
      failure: this.failures.get(cut.id),
      history: this.history(cut)
        .map((r) => {
          let exists = false;
          let bytes = r.bytes;
          try {
            const s = statSync(r.file);
            exists = s.isFile();
            bytes = s.size;
          } catch {}
          return { ...r, bytes, exists };
        })
        .reverse(),
    };
  }

  start(cut: Cut, rev: number, author: Author) {
    const ready = exportReadiness();
    if (!ready.ok) throw new Error(ready.reason);
    const r = cut.revision(rev);
    if (!r) throw new Error(`r${rev} does not exist`);
    if (!cut.renderSource(rev)) throw new Error(`r${rev} is no longer kept on disk, so it cannot be exported`);
    const existing = [this.current, ...this.queue].find((j) => j?.cut.id === cut.id);
    if (existing) throw new Error(existing.rev === rev ? `r${rev} is already exporting` : `r${existing.rev} is exporting; cancel it first`);
    const job: Job = { id: randomUUID().slice(0, 8), cut, rev, author, phase: "waiting", queuedAt: Date.now(), completed: 0, total: 0 };
    cut.pinned.add(rev);
    this.failures.delete(cut.id);
    this.queue.push(job);
    console.log(`[dailies] export ${cut.name} r${rev} queued (${job.id})`);
    this.changed(job, "queued");
    void this.pump();
    return job.id;
  }

  cancel(cut: Cut) {
    const queued = this.queue.find((j) => j.cut.id === cut.id);
    if (queued) {
      this.queue = this.queue.filter((j) => j !== queued);
      cut.pinned.delete(queued.rev);
      console.log(`[dailies] export ${cut.name} r${queued.rev} cancelled before it started`);
      this.changed(queued, "cancelled");
      return true;
    }
    const job = this.current;
    if (job?.cut.id !== cut.id) return false;
    job.cancelled = true;
    job.kill?.();
    return true;
  }

  private changed(job: Job, state: "queued" | "running" | "done" | "failed" | "cancelled", extra?: { file?: string; error?: string; bytes?: number }) {
    emit({ type: "export", cutId: job.cut.id, cut: job.cut.name, rev: job.rev, state, progress: job.total ? job.completed / job.total : 0, phase: job.phase, ...extra });
    if (state === "running" && job.phase !== "starting") return;
    for (const q of this.queue) if (q !== job) emit({ type: "export", cutId: q.cut.id, cut: q.cut.name, rev: q.rev, state: "queued", progress: 0, phase: q.phase });
  }

  private async pump() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift()!;
    this.current = job;
    try {
      await this.run(job);
    } finally {
      job.cut.pinned.delete(job.rev);
      this.current = undefined;
      void this.pump();
    }
  }

  private target(cut: Cut, rev: number) {
    const folder = dirname(cut.path);
    const stem = `${cut.name} r${rev} ${EXPORT_PROFILE.label}`;
    const ours = new Set(this.history(cut).filter((r) => r.rev === rev).map((r) => r.file.toLowerCase()));
    for (let k = 1; k < 1000; k++) {
      const file = join(folder, k === 1 ? `${stem}.mp4` : `${stem} (${k}).mp4`);
      if (!existsSync(file) || ours.has(file.toLowerCase())) return file;
    }
    return join(folder, `${stem} ${Date.now()}.mp4`);
  }

  private sweep(folder: string, keep?: string) {
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(".") || !TEMP_PATTERN.test(n) || (keep && n.includes(keep))) continue;
      try {
        rmSync(join(folder, n), { force: true });
      } catch {}
    }
  }

  private async clean(folder: string, id: string) {
    for (let i = 0; i < 20; i++) {
      let left = 0;
      try {
        for (const n of readdirSync(folder)) {
          if (!n.includes(`.${id}.part.mp4`)) continue;
          try {
            rmSync(join(folder, n), { force: true });
          } catch {
            left++;
          }
        }
      } catch {
        return;
      }
      if (!left) return;
      await sleep(250);
    }
  }

  private place(temp: string, preferred: string) {
    if (existsSync(preferred)) {
      try {
        rmSync(preferred, { force: true });
      } catch {}
    }
    let file = preferred;
    for (let k = 2; existsSync(file); k++) file = preferred.replace(/( \(\d+\))?\.mp4$/i, ` (${k}).mp4`);
    renameSync(temp, file);
    return file;
  }

  private async run(job: Job) {
    const { cut } = job;
    const folder = dirname(cut.path);
    const source = cut.renderSource(job.rev);
    if (!source) {
      this.fail(job, `r${job.rev} is no longer kept on disk`);
      return;
    }
    if (!this.swept.has(folder.toLowerCase())) {
      this.swept.add(folder.toLowerCase());
      this.sweep(folder);
    }
    const rev = cut.revision(job.rev)!;
    const file = this.target(cut, job.rev);
    const temp = join(folder, `.${cut.name} r${job.rev}.${job.id}.part.mp4`);
    job.file = file;
    job.temp = temp;
    job.phase = "starting";
    job.startedAt = Date.now();
    const encoder = await pickEncoder();
    const dir = join(JOB_DIR, `export-${job.id}`);
    console.log(`[dailies] export ${cut.name} r${job.rev} from ${source.path}${source.live ? " (live file)" : ""} to ${file} with ${encoder}`);
    this.changed(job, "running");
    const stampBefore = sourceStamp(source.path);
    let lastEmit = 0;
    try {
      const cli = tryFindCli();
      if (!cli) throw new Error("the Tesseract CLI is not installed");
      const ex = exportSpan({
        cli,
        project: source.path,
        output: temp,
        resolution: EXPORT_PROFILE.resolution,
        fps: EXPORT_PROFILE.fps,
        startMs: 0,
        durationMs: rev.durationMs,
        shim: SHIM,
        env: { DAILIES_EXPORT: "1", DAILIES_JOB: dir, DAILIES_ENCODER: encoder, DAILIES_FFMPEG: FFMPEG },
        onProgress: (p) => {
          if (p.total) job.total = p.total;
          if (p.completed !== undefined) job.completed = p.completed;
          if (p.rate) job.rate = p.rate;
          job.eta = p.eta;
          job.reportedAt = Date.now();
          job.phase = p.phase === "complete" || (job.total && job.completed >= job.total) ? "finishing" : "rendering";
          if (Date.now() - lastEmit > 400 || job.phase === "finishing") {
            lastEmit = Date.now();
            this.changed(job, "running");
          }
        },
      });
      job.kill = () => void taskkillTree(ex.pid);
      job.stop = () => ex.kill();
      if (job.cancelled) job.kill();
      await ex.done;
      if (job.cancelled) throw new Error("cancelled");
      if (sourceStamp(source.path) !== stampBefore || (source.live && !cut.liveMatches(job.rev))) throw new Error(`r${job.rev} changed on disk while exporting; export it again`);
      if (!existsSync(temp)) throw new Error("the export finished without writing a file");
      job.phase = "finishing";
      this.changed(job, "running");
      const probe = await probeVideo(temp).catch(() => undefined);
      const placed = this.place(temp, file);
      const bytes = statSync(placed).size;
      const ms = Date.now() - job.startedAt;
      this.record(cut, { id: job.id, rev: job.rev, file: placed, at: nowIso(), bytes, ms, encoder, width: probe?.width, height: probe?.height });
      cut.log({ author: job.author, kind: "export", rev: job.rev, text: `Exported r${job.rev} in ${EXPORT_PROFILE.label}, ${(bytes / 1e6).toFixed(0)} MB` });
      console.log(`[dailies] exported ${cut.name} r${job.rev} to ${placed} (${(bytes / 1e6).toFixed(1)} MB, ${probe?.width}x${probe?.height}) in ${ms} ms`);
      job.completed = job.total || 1;
      this.changed(job, "done", { file: placed, bytes });
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      const msg = job.cancelled ? "cancelled" : e instanceof Error ? e.message : String(e);
      await this.clean(folder, job.id);
      if (job.cancelled) {
        console.log(`[dailies] export ${cut.name} r${job.rev} cancelled`);
        this.changed(job, "cancelled");
        rmSync(dir, { recursive: true, force: true });
      } else this.fail(job, msg);
    }
  }

  private fail(job: Job, raw: string) {
    const error = tail(raw);
    this.failures.set(job.cut.id, { rev: job.rev, error, at: nowIso() });
    console.error(`[dailies] export ${job.cut.name} r${job.rev} failed: ${raw}`);
    job.cut.log({ author: job.author, kind: "export", rev: job.rev, text: `Couldn't export r${job.rev}: ${error}` });
    this.changed(job, "failed", { error });
  }
}
