import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { findCli } from "../daemon/tsrct";

const [cutPath, cutId] = process.argv.slice(2);
const info = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA!, "Dailies", "daemon.json"), "utf8"));
const base = `http://127.0.0.1:${info.port}`;
const H = { "x-dailies-token": info.token, "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail: unknown) => {
  results.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
async function api(path: string, body?: unknown, method?: string) {
  const r = await fetch(base + path, { method: method ?? (body ? "POST" : "GET"), headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data, headers: r.headers };
}
const detail = async () => (await api(`/api/cuts/${cutId}`)).data;
async function renderDone(label: string, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await detail();
    if (d.segments.every((s: string) => s === "ready") && d.movie?.complete && d.movie.rev === d.rev) return { ms: Date.now() - t0, d };
    await sleep(250);
  }
  throw new Error(`${label}: render did not finish`);
}
async function nextRevision(after: number, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const x = await detail();
    if (x.rev > after) return { d: x, ms: Date.now() - t0 };
    await sleep(100);
  }
  throw new Error(`no revision after r${after} within ${timeoutMs} ms`);
}
async function agentApply(actions: unknown[]) {
  const f = join(process.env.TEMP!, `dailies-e2e-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify(actions));
  const before = statSync(cutPath, { bigint: true }).ino;
  const p = Bun.spawn([findCli(), "project", "apply", "--project", cutPath, "--actions", f], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  rmSync(f, { force: true });
  if (code !== 0) throw new Error(err || out);
  return { inPlace: statSync(cutPath, { bigint: true }).ino === before };
}

const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["mcp/server.ts"], env: { ...process.env } as Record<string, string> }));
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: { agent: "E2E agent", ...args } });
  const t = r.content[0].text;
  try {
    return { error: !!r.isError, data: JSON.parse(t) };
  } catch {
    return { error: !!r.isError, data: t };
  }
};

let d = await detail();
const startRev = d.rev;
console.log(`cut ${d.name} at r${startRev}`);
await renderDone("initial");

const open = await mcp("dailies_open", { path: cutPath, message: "E2E: checking publish after ingest" });
check("mcp open links thread", !open.error && open.data.threadLinked === true, { revision: open.data.revision, threadLinked: open.data.threadLinked });
d = await detail();
check("thread link stored", !!d.collaborators.at(-1)?.link?.startsWith("http://127.0.0.1:"), d.collaborators.at(-1));

const noteA = (await api(`/api/cuts/${cutId}/notes`, { t: 985, text: "E2E: frame at the end of second 0", status: "open" })).data;
const noteB = (await api(`/api/cuts/${cutId}/notes`, { t: d.latest.durationMs - 1, text: "E2E: last frame of the cut", status: "open" })).data;
check("note frame at 985 ms", !!noteA.frame, { id: noteA.id, frame: noteA.frame });
check("note frame at last ms", !!noteB.frame, { id: noteB.id, frame: noteB.frame });

const agentText = `every sunday (${Date.now() % 1000}):`;
const applied = await agentApply([{ type: "animatorSetTextContent", compositionId: "main", layerId: 19, text: agentText }]);
const first = await nextRevision(startRev);
d = first.d;
const ingested = d.revisions.at(-1);
check("watcher ingested agent save before publish", ingested.n === startRev + 1, { n: ingested.n, ms: first.ms, author: ingested.author, published: ingested.published, inPlace: applied.inPlace });
await sleep(1000);
const pub = await mcp("dailies_publish", { cut: cutPath, summary: "Sunday caption shows a counter", addresses: [noteA.id] });
d = await detail();
const last = d.revisions.at(-1);
const na = d.notes.find((n: any) => n.id === noteA.id);
check("publish after ingest credits agent", !pub.error && pub.data.published === ingested.n && !pub.data.warning && last.author === "E2E agent" && last.summary === "Sunday caption shows a counter" && last.published, { pub: pub.data, last: { n: last.n, author: last.author, summary: last.summary, published: last.published } });
check("publish marks addressed notes", na.status === "addressed" && pub.data.addressed?.includes(noteA.id), { status: na.status, thread: na.thread.at(-1)?.text });
const again = await mcp("dailies_publish", { cut: cutPath, summary: "again" });
check("second publish warns", !!again.data.warning && !again.data.newRevision, again.data.warning?.slice(0, 90));
const textRender = await renderDone("agent text");
check("text edit re-rendered changed seconds", true, { ms: textRender.ms, changed: last.changedSeconds });

const sinceWait = new Date().toISOString();
await mcp("dailies_reply", { cut: cutPath, note: noteB.id, text: "Looking", status: "claimed" });
const w0 = Date.now();
const waited = await mcp("dailies_wait", { cut: cutPath, since: sinceWait, timeoutSec: 3 });
check("wait ignores agent's own reply", (waited.data.changed ?? []).length === 0 && Date.now() - w0 > 2500, { changed: waited.data.changed, ms: Date.now() - w0 });

const music = d.timeline.find((t: any) => t.type === "Audio" && /music/i.test(t.name));
const logBefore = readFileSync(join(process.env.LOCALAPPDATA!, "Dailies", "daemon.log"), "utf8").length;
const vol = await api(`/api/cuts/${cutId}/edits`, { edits: [{ kind: "volume", layerId: music.id, db: -6 - (Date.now() % 4000) / 1000 }], force: true });
check("volume edit accepted", vol.status === 200, vol.data);
await sleep(1500);
const audioRender = await renderDone("audio only");
const logAfter = readFileSync(join(process.env.LOCALAPPDATA!, "Dailies", "daemon.log"), "utf8").slice(logBefore);
check("music volume renders audio only", /\(audio only\)/.test(logAfter) && !/rendered [^\n]*\d-\d+ in[^\n]*\n/.test(logAfter.replace(/[^\n]*\(audio only\)[^\n]*\n/g, "")), { ms: audioRender.ms, log: logAfter.trim().split("\n").filter((l) => l.includes("rendered")) });
d = await detail();

const thumb = await fetch(`${base}/api/cuts/${cutId}/thumb?s=3&rev=${d.rev}&v=x&token=${info.token}`);
const thumbBytes = (await thumb.arrayBuffer()).byteLength;
const thumbLatest = await fetch(`${base}/api/cuts/${cutId}/thumb?s=3&token=${info.token}`);
check("thumb endpoint", thumb.status === 200 && thumb.headers.get("content-type") === "image/jpeg" && /immutable/.test(thumb.headers.get("cache-control") ?? "") && thumbLatest.headers.get("cache-control") === "no-store", { status: thumb.status, bytes: thumbBytes, cache: thumb.headers.get("cache-control"), latest: thumbLatest.headers.get("cache-control") });
const bogus = await fetch(`${base}/api/cuts/${cutId}/movie?rev=${d.rev}&k=deadbeef&token=${info.token}`);
const keyed = await fetch(`${base}/api/cuts/${cutId}/movie?rev=${d.rev}&k=${d.movie.key}&token=${info.token}`, { headers: { range: "bytes=0-99" } });
const loose = await fetch(`${base}/api/cuts/${cutId}/movie?rev=${d.rev}&token=${info.token}`, { headers: { range: "bytes=0-99" } });
check("movie urls are keyed", bogus.status === 404 && keyed.status === 206 && /immutable/.test(keyed.headers.get("cache-control") ?? "") && loose.headers.get("cache-control") === "no-store", { bogus: bogus.status, keyed: [keyed.status, keyed.headers.get("cache-control")], loose: loose.headers.get("cache-control") });
const poster = await fetch(`${base}/api/cuts/${cutId}/poster?token=${info.token}`);
check("poster is not cached", poster.headers.get("cache-control") === "no-store", poster.headers.get("cache-control"));

const mine = await api(`/api/cuts/${cutId}/edits`, { edits: [{ kind: "text", layerId: 19, text: "every sunday, by you:" }], force: true });
await sleep(2500);
await agentApply([{ type: "animatorSetTextContent", compositionId: "main", layerId: 19, text: "every sunday, by the agent:" }]);
await sleep(3500);
const undo = await api(`/api/cuts/${cutId}/edits/${mine.data.id}/undo`, {});
check("undo refuses to overwrite a later change", undo.status === 400 && /changed since your edit/.test(undo.data.error ?? ""), undo.data);
d = await detail();
const mineNote = d.notes.find((n: any) => n.id === mine.data.id);
check("edit flagged as overwritten", !!mineNote.overwrittenIn, { overwrittenIn: mineNote.overwrittenIn, conflict: mineNote.conflict });
await renderDone("final");

const lateNote = (await api(`/api/cuts/${cutId}/notes`, { t: 8000, text: "E2E: caption wording", status: "open" })).data;
const preLate = (await detail()).rev;
await agentApply([{ type: "animatorSetTextContent", compositionId: "main", layerId: 19, text: `every sunday (late ${Date.now() % 1000}):` }]);
const late = await nextRevision(preLate);
d = late.d;
const agentRev = d.rev;
check("watcher ingests the agent save promptly", late.ms < 2500, { ms: late.ms, rev: agentRev });
const youEdit = await api(`/api/cuts/${cutId}/edits`, { edits: [{ kind: "volume", layerId: music.id, db: -10 - (Date.now() % 30) / 10 }], force: true });
await sleep(3500);
d = await detail();
const lateAgentPub = await mcp("dailies_publish", { cut: cutPath, summary: "Late publish after Manuel's edit", addresses: [lateNote.id] });
d = await detail();
const claimed = d.revisions.find((r: any) => r.n === agentRev);
check("publish claims agent revision under Manuel's edit", lateAgentPub.data.published === agentRev && claimed.author === "E2E agent" && claimed.published && d.revisions.at(-1).author === "You" && d.notes.find((n: any) => n.id === lateNote.id).status === "addressed", { youEdit: youEdit.status, published: lateAgentPub.data.published, agentRev, latest: [d.revisions.at(-1).n, d.revisions.at(-1).author] });

const undoVol = await api(`/api/cuts/${cutId}/edits/${youEdit.data.id}/undo`, {});
await sleep(3500);
d = await detail();
const restored = d.timeline.find((t: any) => t.id === music.id).volume;
const original = d.notes.find((n: any) => n.id === youEdit.data.id).expect?.[0]?.before;
check("undo restores the exact volume", undoVol.status === 200 && Math.abs(restored - original) < 1e-5, { restored, original });

const fb = await mcp("dailies_feedback", { cut: cutPath });
check("feedback returns now", typeof fb.data.now === "string" && !Number.isNaN(Date.parse(fb.data.now)), fb.data.now);

const target = d.revisions.filter((r: any) => r.restorable && r.n < d.rev).at(-1);
const reverted = await api(`/api/cuts/${cutId}/revert`, { rev: target.n });
await sleep(3500);
d = await detail();
check("revert creates a new revision by you", reverted.status === 200 && d.revisions.at(-1).author === "You" && /Reverted to r/.test(d.revisions.at(-1).summary), { status: reverted.status, data: reverted.data, latest: [d.revisions.at(-1).n, d.revisions.at(-1).author, d.revisions.at(-1).summary] });
await renderDone("after revert");

const revertSame = await api(`/api/cuts/${cutId}/revert`, { rev: target.n });
check("revert to the current content is refused", revertSame.status === 400 && /already matches/.test(revertSame.data.error ?? ""), revertSame.data);

const revsBeforeRace = d.revisions.length;
const raceEdit = await api(`/api/cuts/${cutId}/edits`, { edits: [{ kind: "volume", layerId: music.id, db: -12 - (Date.now() % 30) / 10 }], force: true });
await agentApply([{ type: "animatorSetTextContent", compositionId: "main", layerId: 19, text: `every sunday (race ${Date.now() % 1000}):` }]);
await sleep(4000);
d = await detail();
const raceRevs = d.revisions.slice(revsBeforeRace).map((r: any) => [r.n, r.author, r.summary]);
check("agent save right after a Dailies edit is not credited to you", raceEdit.status === 200 && d.revisions.at(-1).author !== "You", { edit: raceEdit.status, revisions: raceRevs });
await renderDone("after race");

if (process.env.E2E_DELIVER) {
  await api(`/api/cuts/${cutId}/notes`, { t: 4500, text: "E2E delivery check: Dailies sends this to the linked T3 thread", status: "draft" });
  const sent = await api(`/api/cuts/${cutId}/publish`, {});
  check("send delivers to linked thread", sent.data.published === 1 && sent.data.delivered.length > 0, sent.data);
}

await client.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
