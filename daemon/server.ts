import { existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { subscribe, type DailiesEvent, emit } from "./events";
import type { Registry, Cut } from "./cuts";
import type { Renderer } from "./render";
import { videoFile } from "./render";
import { contextAt, timelineItems, SEGMENT_MS } from "./doc";
import { extractFrame, extractThumb, run, FFMPEG, THUMB_SHORT_SIDE } from "./media";
import { FRAME_CACHE, THUMB_CACHE } from "./paths";
import { RENDER_SETTINGS } from "./cuts";
import { findCli } from "./tsrct";
import { projectInfo, libraryPoster, resolveLibraryPath, entryRange, chunkedStream, groupOf, POSTER_SHORT_SIDE } from "./library";
import {
  createNote, updateNote, deleteNote, reply, publish, approve, edit, applyQueued, undoEdit, revertTo, feedbackFor, revisionInfo, displayTime, YOU, clip,
  type EditRequest,
} from "./collab";
import type { Author, Note, NoteStatus } from "./types";

type Ctx = { registry: Registry; renderer: Renderer; token: string; uiDir: () => string | undefined; startedAt: string; version: string };

type Caching = "immutable" | "no-cache" | "no-store";
const CACHE_HEADER: Record<Caching, string> = { immutable: "private, max-age=31536000, immutable", "no-cache": "no-cache", "no-store": "no-store" };

const building = new Map<string, Promise<void>>();
function buildOnce(file: string, make: () => Promise<void>) {
  let p = building.get(file);
  if (!p) {
    p = make().finally(() => building.delete(file));
    building.set(file, p);
  }
  return p;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, message: string) => json({ error: message }, status);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function allowedOrigin(origin: string | null, host: string | null) {
  if (!origin) return true;
  if (origin === "null" || origin.startsWith("file://") || origin.startsWith("app://")) return true;
  try {
    const u = new URL(origin);
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && (!host || u.host === host || u.port === "5173" || u.port === "5174");
  } catch {
    return false;
  }
}

async function serveFile(req: Request, path: string, type: string | undefined, caching: Caching) {
  const file = Bun.file(path);
  if (!(await file.exists())) return fail(404, "not found");
  const size = file.size;
  const range = req.headers.get("range");
  const headers: Record<string, string> = { "content-type": type ?? MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": CACHE_HEADER[caching] };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
    }
  }
  return new Response(file, { headers: { ...headers, "content-length": String(size) } });
}

const waiters = new Set<{ cutId?: string; resolve: (e: DailiesEvent) => void }>();
subscribe((e) => {
  for (const w of [...waiters]) {
    if ("cutId" in e && w.cutId && e.cutId !== w.cutId) continue;
    w.resolve(e);
  }
});

function linkOf(body: any): string | undefined {
  return typeof body?.threadLink === "string" && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(body.threadLink) ? body.threadLink : undefined;
}

function agentOf(body: any): Author {
  const name = typeof body?.agent === "string" && body.agent.trim() ? body.agent.trim().slice(0, 60) : "Agent";
  return { kind: "agent", name };
}

export function cutDetail(ctx: Ctx, cut: Cut, rev?: number) {
  const latest = cut.latest;
  const r = cut.revision(rev) ?? latest;
  const doc = r ? cut.docFor(r.n)?.doc : undefined;
  const movie = r ? ctx.renderer.movie(cut.id, r.n) : undefined;
  return {
    ...cut.summary(ctx.renderer.progressFor(cut)),
    rev: r?.n,
    revisions: cut.revisions.map((x) => ({ ...revisionInfo(x), authorKind: x.author.kind, published: !!x.published, hasMovie: !!ctx.renderer.movie(cut.id, x.n), movieKey: ctx.renderer.movie(cut.id, x.n)?.key, restorable: !!x.snapshot && existsSync(x.snapshot) })),
    timeline: doc ? timelineItems(doc) : [],
    segments: r ? ctx.renderer.segmentStates(cut, r) : [],
    changedSegments: r?.changedSegments ?? [],
    movie: movie ? { rev: movie.rev, key: movie.key, stale: movie.stale, missing: movie.missing, complete: movie.complete } : undefined,
    jobs: ctx.renderer.jobsFor(cut.id),
    renderError: ctx.renderer.failureFor(cut),
    notes: cut.notes.map((n) => {
      const d = displayTime(n as any, doc);
      return { ...n, displayT: d.t, moved: d.moved, anchorGone: d.gone, frame: n.frame ? `/api/cuts/${cut.id}/notes/${n.id}/frame` : undefined, annotatedFrame: n.annotatedFrame ? `/api/cuts/${cut.id}/notes/${n.id}/frame?marked=1` : undefined };
    }),
    activity: cut.activity.slice(-200),
    collaborators: cut.collaborators,
  };
}

async function frameFor(ctx: Ctx, cut: Cut, t: number, revN?: number): Promise<string | undefined> {
  const rev = cut.revision(revN) ?? cut.latest;
  if (!rev) return undefined;
  const fps = RENDER_SETTINGS.fps;
  const clamped = Math.max(0, Math.min(rev.durationMs - 1, t));
  const s = Math.min(rev.vkeys.length - 1, Math.floor(clamped / SEGMENT_MS));
  const seg = videoFile(rev.vkeys[s]);
  if (!existsSync(seg)) return undefined;
  const segMs = Math.min(rev.durationMs, (s + 1) * SEGMENT_MS) - s * SEGMENT_MS;
  const frames = Math.max(1, Math.round((segMs * fps) / 1000));
  const index = Math.min(frames - 1, Math.floor(((clamped - s * SEGMENT_MS) * fps) / 1000 + 0.01));
  const out = join(FRAME_CACHE, `${rev.vkeys[s]}-f${index}.png`);
  if (existsSync(out)) ctx.renderer.touch(out);
  else await buildOnce(out, () => extractFrame(seg, index, out));
  return out;
}

async function exactFrame(cut: Cut, t: number, revN?: number): Promise<string> {
  const rev = cut.revision(revN) ?? cut.latest;
  if (!rev) throw new Error("no revision");
  const source = cut.renderSource(rev.n);
  if (!source) throw new Error("revision archive not available");
  const out = join(FRAME_CACHE, `exact-${cut.id}-r${rev.n}-${Math.round(t)}.png`);
  if (existsSync(out)) return out;
  const mov = `${out}.mov`;
  const p = Bun.spawn([findCli(), "export", "--project", source.path, "--output", mov, "--format", "prores", "--resolution", "1080p", "--fps", "60", "--start-ms", String(Math.round(t)), "--duration-ms", "17"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim().split("\n").slice(-2).join(" | "));
  const r = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", mov, "-frames:v", "1", out]);
  rmSync(mov, { force: true });
  if (r.code !== 0) throw new Error(r.stderr);
  return out;
}

function decodeDataUrl(v: unknown): Buffer | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(v);
  return m ? Buffer.from(m[2], "base64") : undefined;
}

function resolveCut(ctx: Ctx, idOrPath: string | null | undefined, open = false): Cut | undefined {
  if (!idOrPath) return undefined;
  const hit = ctx.registry.get(idOrPath);
  if (hit) return hit;
  if (open && /\.tsrct$/i.test(idOrPath) && existsSync(idOrPath)) return ctx.registry.add(resolve(idOrPath));
  return undefined;
}

export function startServer(ctx: Ctx, port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      if (!allowedOrigin(origin, req.headers.get("host"))) return fail(403, "origin not allowed");
      const p = url.pathname;

      if (!p.startsWith("/api/")) {
        const uiDir = ctx.uiDir();
        if (!uiDir) return fail(404, "no UI bundle; run bun run build");
        let rel = "index.html";
        try {
          if (p !== "/") rel = decodeURIComponent(p.slice(1));
        } catch {
          return fail(400, "bad path");
        }
        const file = resolve(uiDir, rel);
        if (!file.startsWith(resolve(uiDir) + sep)) return fail(403, "bad path");
        if (existsSync(file) && statSync(file).isFile()) return serveFile(req, file, undefined, rel.startsWith("assets/") ? "immutable" : "no-cache");
        return serveFile(req, join(uiDir, "index.html"), undefined, "no-cache");
      }

      const token = req.headers.get("x-dailies-token") ?? url.searchParams.get("token");
      if (p === "/api/health") return json({ ok: true, app: "dailies", version: ctx.version, pid: process.pid, startedAt: ctx.startedAt, authed: token === ctx.token });
      if (token !== ctx.token) return fail(401, "missing or wrong token");

      try {
        const body: any = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => ({})) : {};
        const segs = p.split("/").filter(Boolean);

        if (p === "/api/events") {
          const cutFilter = url.searchParams.get("cut");
          let unsub: (() => void) | undefined;
          let beat: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              const send = (e: unknown) => {
                try {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
                } catch {}
              };
              send({ type: "hello" });
              unsub = subscribe((e) => {
                if (cutFilter && "cutId" in e && e.cutId !== cutFilter) return;
                send(e);
              });
              beat = setInterval(() => send({ type: "ping" }), 15000);
            },
            cancel() {
              unsub?.();
              clearInterval(beat);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
        }

        if (p === "/api/state") {
          return json({ cuts: [...ctx.registry.cuts.values()].map((c) => c.summary(ctx.renderer.progressFor(c))).sort((a, b) => (b.latest?.at ?? "").localeCompare(a.latest?.at ?? "")) });
        }
        if (p === "/api/library") return json({ roots: ctx.registry.roots, files: ctx.registry.scanLibrary().map((f) => ({ ...f, ...projectInfo(f.path), group: groupOf(f.path, ctx.registry.roots) })) });
        if (p === "/api/library/poster") {
          const path = resolveLibraryPath(url.searchParams.get("path"), ctx.registry.roots);
          if (!path) return fail(404, "not a project in the library");
          const f = await libraryPoster(path, (name, sig) => `${url.origin}/api/library/entry?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}&sig=${sig}&token=${ctx.token}`);
          if (!f) return fail(404, "no footage to make a poster from");
          return serveFile(req, f, "image/jpeg", url.searchParams.has("v") ? "immutable" : "no-cache");
        }
        if (p === "/api/library/entry") {
          const path = resolveLibraryPath(url.searchParams.get("path"), ctx.registry.roots);
          const sig = url.searchParams.get("sig") ?? "";
          const range = path ? entryRange(path, url.searchParams.get("name") ?? "", sig) : undefined;
          if (!path || !range) return fail(404, "no such entry");
          const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
          const from = m?.[1] ? Number(m[1]) : m?.[2] ? Math.max(0, range.size - Number(m[2])) : 0;
          const to = m?.[1] && m[2] ? Math.min(range.size - 1, Number(m[2])) : range.size - 1;
          if (from >= range.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${range.size}` } });
          const headers: Record<string, string> = { "content-type": "application/octet-stream", "accept-ranges": "bytes", "content-length": String(to - from + 1), "cache-control": "no-store" };
          if (m) headers["content-range"] = `bytes ${from}-${to}/${range.size}`;
          return new Response(chunkedStream(path, range.start + from, range.start + to, sig), { status: m ? 206 : 200, headers });
        }
        if (p === "/api/activity") {
          const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit") ?? 80)));
          const items = [...ctx.registry.cuts.values()].flatMap((c) => c.activity.slice(-limit).map((a) => ({ ...a, cutId: c.id, cut: c.name })));
          items.sort((a, b) => b.at.localeCompare(a.at));
          return json({ items: items.slice(0, limit) });
        }
        if (p === "/api/cuts/open" && req.method === "POST") {
          const path = String(body.path ?? "");
          if (!/\.tsrct$/i.test(path) || !existsSync(path)) return fail(400, `not a .tsrct file: ${path}`);
          const cut = ctx.registry.add(resolve(path));
          return json(cut.summary(ctx.renderer.progressFor(cut)));
        }

        if (segs[1] === "cuts" && segs[2]) {
          const cut = resolveCut(ctx, segs[2]);
          if (!cut) return fail(404, "unknown cut");
          const sub = segs[3];
          if (!sub && req.method === "GET") return json(cutDetail(ctx, cut, url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined));
          if (sub === "close" && req.method === "POST") {
            ctx.registry.remove(cut.id);
            return json({ ok: true });
          }
          if (sub === "movie") {
            const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : cut.latest?.n;
            const key = url.searchParams.get("k");
            if (rev === undefined) return fail(404, "no revision");
            if (key) {
              const file = ctx.renderer.movieFile(cut.id, rev, key);
              if (!existsSync(file)) return fail(404, "that movie was replaced; reload the cut");
              ctx.renderer.touch(file);
              return serveFile(req, file, "video/mp4", "immutable");
            }
            const m = ctx.renderer.movie(cut.id, rev);
            if (!m || !existsSync(m.file)) return fail(404, "not rendered yet");
            ctx.renderer.touch(m.file);
            return serveFile(req, m.file, "video/mp4", "no-store");
          }
          if (sub === "frame") {
            const t = Number(url.searchParams.get("t") ?? 0);
            const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined;
            const f = url.searchParams.get("exact") ? await exactFrame(cut, t, rev) : await frameFor(ctx, cut, t, rev);
            if (!f) return fail(404, "that part has not rendered yet");
            return serveFile(req, f, "image/png", rev !== undefined ? "immutable" : "no-store");
          }
          if (sub === "thumb") {
            const rev = cut.revision(url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined);
            const s = Number(url.searchParams.get("s"));
            if (!rev || !Number.isInteger(s) || s < 0 || s >= rev.vkeys.length) return fail(404, "no such second");
            const seg = videoFile(rev.vkeys[s]);
            if (!existsSync(seg)) return fail(404, "not rendered yet");
            const out = join(THUMB_CACHE, `${rev.vkeys[s]}-${THUMB_SHORT_SIDE}.jpg`);
            if (existsSync(out)) ctx.renderer.touch(out);
            else await buildOnce(out, () => extractThumb(seg, out));
            return serveFile(req, out, "image/jpeg", url.searchParams.has("rev") ? "immutable" : "no-store");
          }
          if (sub === "poster") {
            const rev = cut.revision(url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined) ?? cut.latest;
            if (!rev) return fail(404, "no revision");
            const s = Math.min(rev.vkeys.length - 1, Math.floor(Math.min(rev.durationMs * 0.3, 2500) / SEGMENT_MS));
            const seg = videoFile(rev.vkeys[s]);
            if (!existsSync(seg)) return fail(404, "not rendered yet");
            const out = join(THUMB_CACHE, `${rev.vkeys[s]}-${POSTER_SHORT_SIDE}.jpg`);
            if (existsSync(out)) ctx.renderer.touch(out);
            else await buildOnce(out, () => extractThumb(seg, out, POSTER_SHORT_SIDE));
            return serveFile(req, out, "image/jpeg", url.searchParams.has("rev") ? "immutable" : "no-store");
          }
          if (sub === "context") {
            const rev = cut.revision(url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : undefined);
            const doc = rev ? cut.docFor(rev.n)?.doc : undefined;
            return json({ layers: doc ? contextAt(doc, Number(url.searchParams.get("t") ?? 0)) : [] });
          }
          if (sub === "playhead" && req.method === "POST") {
            ctx.renderer.setPlayhead(cut.id, Number(body.t ?? 0));
            return json({ ok: true });
          }
          if (sub === "retry" && req.method === "POST") {
            ctx.renderer.retry(cut);
            return json({ ok: true });
          }
          if (sub === "render" && req.method === "POST") {
            const rev = Number(body.rev);
            ctx.renderer.plan(cut, rev);
            return json({ ok: true });
          }
          if (sub === "publish" && req.method === "POST") return json(await publish(cut));
          if (sub === "approve" && req.method === "POST") {
            await approve(cut, Number(body.rev ?? cut.latest?.n));
            return json({ ok: true });
          }
          if (sub === "revert" && req.method === "POST") {
            await revertTo(cut, Number(body.rev));
            return json({ ok: true });
          }
          if (sub === "edits" && req.method === "POST") {
            if (segs[4] && segs[5] === "apply") {
              await applyQueued(cut, segs[4]);
              return json({ ok: true });
            }
            if (segs[4] && segs[5] === "undo") {
              await undoEdit(cut, segs[4]);
              return json({ ok: true });
            }
            const r = await edit(cut, (body.edits ?? []) as EditRequest[], { force: !!body.force, text: body.text });
            return json({ id: r.note.id, queued: r.queued });
          }
          if (sub === "notes") {
            const noteId = segs[4];
            if (!noteId && req.method === "POST") {
              const note = createNote(cut, {
                rev: body.rev,
                t: Number(body.t ?? 0),
                end: body.end !== undefined ? Number(body.end) : undefined,
                text: String(body.text ?? ""),
                annotations: Array.isArray(body.annotations) ? body.annotations : [],
                status: body.status === "open" ? "open" : "draft",
                frame: decodeDataUrl(body.frame),
                annotatedFrame: decodeDataUrl(body.annotatedFrame),
              });
              if (!note.frame) {
                const f = await frameFor(ctx, cut, note.t, note.rev).catch(() => undefined);
                if (f) {
                  note.frame = join(cut.dataDir, "frames", `${note.id}.png`);
                  await Bun.write(note.frame, Bun.file(f));
                  cut.saveNotes();
                }
              }
              return json(note);
            }
            if (noteId && segs[5] === "frame") {
              const n = cut.notes.find((x) => x.id === noteId);
              const f = url.searchParams.get("marked") ? n?.annotatedFrame : n?.frame;
              if (!f || !existsSync(f)) return fail(404, "no frame");
              return serveFile(req, f, "image/png", "no-cache");
            }
            if (noteId && segs[5] === "reply" && req.method === "POST") return json(reply(cut, noteId, String(body.text ?? ""), YOU, body.status as NoteStatus | undefined));
            if (noteId && req.method === "PATCH") return json(updateNote(cut, noteId, body));
            if (noteId && req.method === "DELETE") {
              deleteNote(cut, noteId);
              return json({ ok: true });
            }
          }
          return fail(404, "unknown endpoint");
        }

        if (segs[1] === "agent") {
          const op = segs[2];
          const cutRef = body.cut ?? url.searchParams.get("cut");
          if (op === "open") {
            const path = String(body.path ?? body.cut ?? "");
            if (!/\.tsrct$/i.test(path) || !existsSync(path)) return fail(400, `not a .tsrct file: ${path}`);
            const cut = ctx.registry.add(resolve(path));
            const who = agentOf(body);
            if (typeof body.thread === "string" && body.thread) cut.addCollaborator(body.thread, who.name, linkOf(body));
            cut.agent = { name: who.name, state: "working", text: body.message ? String(body.message) : "Opened for review", at: new Date().toISOString() };
            if (!cut.lastAgentTouch?.publishing) cut.lastAgentTouch = { name: who.name, at: Date.now() };
            cut.saveState();
            cut.log({ author: who, kind: "open", text: `${who.name} opened this cut` });
            await cut.ingest();
            emit({ type: "cuts" });
            emit({ type: "focus", cutId: cut.id });
            return json({ cut: cut.path, id: cut.id, revision: cut.latest?.n, render: ctx.renderer.progressFor(cut), openNotes: cut.notes.filter((n) => n.status === "open" || n.status === "claimed").length, threadLinked: !!body.thread });
          }
          const cut = resolveCut(ctx, cutRef, true);
          if (!cut) return fail(404, `unknown cut: ${cutRef}. Call dailies_open first.`);
          const who = agentOf(body);
          if (op === "status") {
            const state = ["working", "ready", "blocked", "idle"].includes(body.state) ? body.state : "working";
            cut.agent = { name: who.name, state, text: String(body.message ?? ""), at: new Date().toISOString() };
            if (!cut.lastAgentTouch?.publishing) cut.lastAgentTouch = { name: who.name, at: Date.now() };
            if (typeof body.thread === "string" && body.thread) cut.addCollaborator(body.thread, who.name, linkOf(body));
            cut.saveState();
            cut.log({ author: who, kind: "status", state, text: String(body.message ?? state) });
            emit({ type: "cuts" });
            return json({ ok: true });
          }
          if (op === "publish") {
            const summary = body.summary ? String(body.summary) : undefined;
            const addresses: string[] | undefined = Array.isArray(body.addresses) ? body.addresses.map(String) : undefined;
            if (typeof body.thread === "string" && body.thread) cut.addCollaborator(body.thread, who.name, linkOf(body));
            const { rev, reason } = await cut.publishFromAgent(who.name, summary, addresses);
            const latest = cut.latest;
            cut.agent = { name: who.name, state: "ready", text: rev ? `Published r${rev.n}${summary ? `: ${summary}` : ""}` : `Nothing new to publish since r${latest?.n ?? "?"}`, at: new Date().toISOString() };
            cut.saveState();
            emit({ type: "cuts" });
            emit({ type: "cut", cutId: cut.id });
            const unknown = (addresses ?? []).filter((id) => !cut.notes.some((n) => n.id === id));
            return json({
              revision: latest?.n,
              published: rev?.n,
              newRevision: !!rev,
              addressed: rev ? (addresses ?? []).filter((id) => cut.notes.find((n) => n.id === id)?.status === "addressed") : [],
              unknownNotes: unknown.length ? unknown : undefined,
              render: ctx.renderer.progressFor(cut),
              warning: rev
                ? undefined
                : `Nothing was published and no notes were marked addressed: ${reason}. Save or commit the project first. If a note needs no change, answer it with dailies_reply (status addressed or wontfix) instead.`,
            });
          }
          if (op === "feedback") return json(feedbackFor(cut, { status: body.status ?? url.searchParams.get("status") ?? undefined, since: body.since ?? url.searchParams.get("since") ?? undefined }));
          if (op === "wait") {
            const timeout = Math.min(55, Math.max(1, Number(body.timeoutSec ?? url.searchParams.get("timeoutSec") ?? 50)));
            const since = String(body.since ?? url.searchParams.get("since") ?? new Date().toISOString());
            const pending = () => cut.notes.filter((n) => n.status !== "draft" && ((n.humanAt ?? (n.author.kind === "you" ? n.publishedAt : undefined) ?? "") > since || n.thread.some((t) => t.author.kind === "you" && t.at > since)));
            const approvedSince = () => cut.activity.find((a) => a.kind === "approve" && a.at > since);
            let found = pending();
            if (!found.length && !approvedSince()) {
              await new Promise<void>((done) => {
                const w = { cutId: cut.id, resolve: () => {
                  if (pending().length || approvedSince()) {
                    waiters.delete(w);
                    clearTimeout(timer);
                    done();
                  }
                } };
                const timer = setTimeout(() => {
                  waiters.delete(w);
                  done();
                }, timeout * 1000);
                waiters.add(w);
              });
              found = pending();
            }
            const appr = approvedSince();
            return json({ now: new Date().toISOString(), approved: appr ? appr.rev : undefined, changed: found.map((n) => ({ id: n.id, kind: n.kind, status: n.status, text: clip(n.text, 140) })), hint: found.length || appr ? "Call dailies_feedback for details." : "Nothing new yet. Wait again or end your turn; Dailies will message your thread when Manuel sends notes." });
          }
          if (op === "reply") {
            const n = reply(cut, String(body.note), String(body.text ?? ""), who, body.status as NoteStatus | undefined, cut.latest?.n);
            return json({ id: n.id, status: n.status });
          }
          if (op === "frame") {
            const t = Number(body.t ?? url.searchParams.get("t") ?? 0);
            const rev = body.revision ?? (url.searchParams.has("revision") ? Number(url.searchParams.get("revision")) : undefined);
            const exact = !!(body.exact ?? url.searchParams.get("exact"));
            const f = exact ? await exactFrame(cut, t, rev) : await frameFor(ctx, cut, t, rev);
            if (!f) return fail(409, "that second has not rendered yet; try again shortly or pass exact=true");
            return json({ path: f, t, revision: rev ?? cut.latest?.n, exact });
          }
          if (op === "revisions") return json({ cut: cut.path, revisions: cut.revisions.map(revisionInfo), approvedRevision: cut.approvedRev });
          return fail(404, "unknown agent op");
        }
        return fail(404, "unknown endpoint");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(400, msg);
      }
    },
  });
}
