import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Film, FolderOpen, Search, X } from "lucide-react";
import { api, media, type ActivityItem, type CutSummary, type LibraryFile } from "@/lib/api";
import { useActivity, useCuts } from "@/lib/store";
import { ago, cn, plural, tc } from "@/lib/format";
import { Button, IconButton, Tip } from "./ui/button";
import { Mark } from "./Mark";
import { UpdatePill } from "./UpdatePill";

export type OpenTarget = {
  cutId: string;
  rev?: number;
  t?: number;
  tab?: string;
};

const WORKING_MS = 15 * 60_000;
const STRIP_MAX = 24;
const STACK_MIN = 10;

const isWorking = (c: CutSummary) => c.agent?.state === "working" && Date.now() - Date.parse(c.agent.at) < WORKING_MS;
const awaitingReview = (c: CutSummary) => !!c.latest && c.latest.author.kind === "agent" && c.approvedRev !== c.latest.n;
const needsYou = (c: CutSummary) => !c.missing && !isWorking(c) && (c.agent?.state === "blocked" || c.draftNotes > 0 || awaitingReview(c));

function short(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function aspectLabel(w: number, h: number) {
  const r = w / h;
  for (const [a, b] of [
    [9, 16],
    [16, 9],
    [1, 1],
    [4, 5],
    [4, 3],
    [3, 4],
    [21, 9],
  ])
    if (Math.abs(r - a / b) < 0.01) return `${a}:${b}`;
  return `${w}x${h}`;
}

function listed(parts: string[]) {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function changedText(l: NonNullable<CutSummary["latest"]>) {
  if (l.n === 1) return "First revision";
  if (!l.changed.length) return "No visible changes";
  const s = [...l.changed].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const x of s) {
    const last = ranges.at(-1);
    if (last && x === last[1] + 1) last[1] = x;
    else ranges.push([x, x]);
  }
  const span = ([a, b]: [number, number]) => `${short(a * 1000)} to ${short(Math.min((b + 1) * 1000, l.durationMs))}`;
  if (ranges.length > 3) return `Changed ${ranges.length} spans between ${short(ranges[0][0] * 1000)} and ${short(Math.min((ranges.at(-1)![1] + 1) * 1000, l.durationMs))}`;
  return `Changed ${listed(ranges.map(span))}`;
}

function cutStatus(c: CutSummary): { text: string; tone: string } {
  if (c.missing) return { text: "File moved or deleted", tone: "text-red" };
  if (c.render.failed) return { text: "Some seconds failed to render", tone: "text-red" };
  if (c.render.rendering && c.render.total)
    return {
      text: `Rendering, ${c.render.ready} of ${c.render.total} seconds`,
      tone: "text-soft",
    };
  if (c.approvedRev && c.latest && c.approvedRev === c.latest.n)
    return {
      text: `Approved r${c.approvedRev}`,
      tone: "text-dim",
    };
  if (c.latest) return { text: `r${c.latest.n}, ${ago(c.latest.at)}`, tone: "text-dim" };
  return { text: "Reading project", tone: "text-dim" };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Img({ src, className }: { src?: string; className?: string }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  useEffect(() => setState("loading"), [src]);
  if (!src || state === "failed") return null;
  return (
    <img
      src={src}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setState("ok")}
      onError={() => setState("failed")}
      className={cn("absolute inset-0 size-full object-cover transition-opacity duration-200", state === "ok" ? "opacity-100" : "opacity-0", className)}
    />
  );
}

function Blank() {
  return (
    <div className="absolute inset-0 grid place-items-center text-faint">
      <Film className="size-5" strokeWidth={1.6} />
    </div>
  );
}

function cutPoster(c: CutSummary) {
  if (!c.latest) return undefined;
  return media(`/api/cuts/${c.id}/poster?rev=${c.latest.n}${c.render.rendering ? `&r=${c.render.ready}` : ""}`);
}

function Strip({ cut, maxH, onSeek }: { cut: CutSummary; maxH: number; onSeek: (ms: number) => void }) {
  const l = cut.latest!;
  const total = Math.max(1, l.segments);
  const n = Math.min(total, STRIP_MAX);
  const changed = new Set(l.changed);
  const highlight = l.n > 1 && changed.size > 0;
  const cells = Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * total) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * total) / n));
    let hit = -1;
    for (let s = a; s < b && hit < 0; s++) if (changed.has(s)) hit = s;
    return { s: hit >= 0 ? hit : a, on: hit >= 0 };
  });
  const retry = cut.render.rendering ? `&r=${cut.render.ready}` : "";
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, ${Math.round((maxH * l.width) / l.height)}px))` }}>
      {cells.map((c) => (
        <button
          key={c.s}
          title={`${tc(c.s * 1000)}${c.on ? ", changed" : ""}`}
          onClick={() => onSeek(c.s * 1000)}
          className="relative overflow-hidden rounded-[4px] bg-well"
          style={{ aspectRatio: `${l.width} / ${l.height}` }}
        >
          <Img src={media(`/api/cuts/${cut.id}/thumb?rev=${l.n}&s=${c.s}${retry}`)} className={highlight && !c.on ? "!opacity-50" : undefined} />
          {c.on && <span className="pointer-events-none absolute inset-0 rounded-[4px] shadow-[inset_0_0_0_2px_var(--color-amber)]" />}
        </button>
      ))}
    </div>
  );
}

function AgentLine({ cut }: { cut: CutSummary }) {
  const l = cut.latest;
  const a = cut.agent;
  if (a?.state === "blocked")
    return (
      <Line dot="bg-amber">
        <b className="font-semibold">{a.name}</b> <span className="text-amber">needs you</span>
        <span className="text-faint">{ago(a.at)}</span>
      </Line>
    );
  if (a && isWorking(cut))
    return (
      <Line dot="bg-teal animate-pulse">
        <b className="font-semibold">{a.name}</b> <span className="text-soft">is working</span>
        <span className="text-faint">{ago(a.at)}</span>
      </Line>
    );
  if (!l) return null;
  return (
    <Line dot={l.author.kind === "agent" ? "bg-teal" : "bg-amber"}>
      <b className="font-semibold">{l.author.name}</b>
      <span className="text-soft">{l.author.kind === "agent" ? "published" : "saved"}</span>
      <b className="font-semibold text-amber">r{l.n}</b>
      <span className="text-faint">{ago(l.at)}</span>
    </Line>
  );
}

function Line({ dot, children }: { dot: string; children: ReactNode }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[14px]">
      <i className={cn("size-[7px] shrink-0 rounded-full", dot)} />
      {children}
    </div>
  );
}

function InboxCard({ cut, wide, onOpen, onRemove, onApproved }: { cut: CutSummary; wide?: boolean; onOpen: (t: OpenTarget) => void; onRemove: () => void; onApproved: () => void }) {
  const l = cut.latest!;
  const portrait = l.height >= l.width;
  const working = isWorking(cut);
  const [approving, setApproving] = useState(false);
  const body = cut.agent?.state === "blocked" ? cut.agent.text : working ? cut.agent?.text || l.summary : l.summary;
  const changed = cut.render.rendering && cut.render.total ? `Rendering, ${cut.render.ready} of ${cut.render.total} seconds ready` : changedText(l);

  async function approve() {
    setApproving(true);
    try {
      await api(`/api/cuts/${cut.id}/approve`, { body: { rev: l.n } });
      onApproved();
    } finally {
      setApproving(false);
    }
  }

  return (
    <article className="group grid grid-cols-[auto_minmax(0,1fr)] gap-5 rounded-[14px] bg-panel p-4">
      <button
        onClick={() => onOpen({ cutId: cut.id })}
        className={cn("relative self-start overflow-hidden rounded-[9px] bg-well", portrait ? "aspect-[9/16] w-[132px]" : "aspect-video w-[220px]")}
        aria-label={`Review ${cut.name}`}
      >
        <Blank />
        <Img src={cutPoster(cut)} />
      </button>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5">
            <span className="text-[18px] leading-snug font-semibold [overflow-wrap:anywhere]">{cut.name}</span>
            <span className="text-dim">{cut.folder}</span>
          </div>
          <span className="pt-1 text-[13px] whitespace-nowrap text-faint">
            {tc(l.durationMs)}, {aspectLabel(l.width, l.height)}
          </span>
          <IconButton label="Remove from Dailies" onClick={onRemove} className="-mt-0.5 -mr-1.5 size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-4">
            <X />
          </IconButton>
        </div>
        <AgentLine cut={cut} />
        {body && <p className="mt-1.5 max-w-[78ch] text-[14px] leading-snug text-soft">{body}</p>}
        <div className="mt-3.5">
          <Strip cut={cut} maxH={wide ? 220 : 150} onSeek={(t) => onOpen({ cutId: cut.id, t })} />
        </div>
        <div className={cn("mt-1.5 text-[12.5px]", l.n > 1 && l.changed.length ? "text-amber" : "text-dim")}>{changed}</div>
        <div className="min-h-3 flex-1" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex flex-wrap gap-1">
            {cut.recent.map((r) => (
              <Tip key={r.n} label={`${r.author.name}, ${ago(r.at)}`}>
                <button
                  onClick={() =>
                    onOpen({
                      cutId: cut.id,
                      rev: r.n === l.n ? undefined : r.n,
                    })
                  }
                  className={cn("inline-flex h-[24px] items-center gap-[5px] rounded-md bg-raised px-2 text-[12px] font-semibold hover:bg-hover", r.n === l.n ? "text-text" : "text-soft")}
                >
                  <i className={cn("size-1.5 rounded-full", r.author.kind === "agent" ? "bg-teal" : "bg-amber")} />r{r.n}
                  {cut.approvedRev === r.n && <Check className="size-3 text-teal" strokeWidth={3} />}
                </button>
              </Tip>
            ))}
          </div>
          <div className="flex-1" />
          {(cut.openNotes > 0 || cut.draftNotes > 0) && (
            <button onClick={() => onOpen({ cutId: cut.id, tab: "cues" })} className="text-[13px] text-soft hover:text-text">
              {cut.openNotes > 0 && plural(cut.openNotes, "open note")}
              {cut.openNotes > 0 && cut.draftNotes > 0 && ", "}
              {cut.draftNotes > 0 && <span className="text-amber">{plural(cut.draftNotes, "draft")} not sent</span>}
            </button>
          )}
          {working ? (
            <Button onClick={() => onOpen({ cutId: cut.id })}>Watch r{l.n}</Button>
          ) : (
            <>
              {awaitingReview(cut) && (
                <Button variant="ghost" disabled={approving} onClick={() => void approve()}>
                  Approve r{l.n}
                </Button>
              )}
              <Button variant="primary" onClick={() => onOpen({ cutId: cut.id })}>
                Review r{l.n}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

type WallItem = {
  key: string;
  aspect: number;
  name: string;
  at: number;
  group: string;
  cut?: CutSummary;
  file?: LibraryFile;
  stack?: WallItem[];
};

function rows(items: WallItem[], width: number, target: number, gap: number) {
  const out: { items: WallItem[]; h: number }[] = [];
  let row: WallItem[] = [];
  let sum = 0;
  for (const it of items) {
    row.push(it);
    sum += it.aspect;
    if (sum * target + gap * (row.length - 1) >= width) {
      out.push({
        items: row,
        h: Math.floor((width - gap * (row.length - 1) - row.length) / sum),
      });
      row = [];
      sum = 0;
    }
  }
  if (row.length) out.push({ items: row, h: target });
  return out;
}

function itemPoster(it: WallItem) {
  if (it.cut) return cutPoster(it.cut);
  if (it.file && it.file.poster !== false) return media(`/api/library/poster?path=${encodeURIComponent(it.file.path)}&v=${Math.round(it.file.mtimeMs)}-${it.file.size}`);
  return undefined;
}

function itemMeta(it: WallItem): { text: string; tone: string } {
  if (it.stack)
    return {
      text: `${it.stack.length} projects, ${ago(new Date(it.at).toISOString())}`,
      tone: "text-faint",
    };
  if (it.cut) return cutStatus(it.cut);
  const f = it.file!;
  return {
    text: [f.durationMs ? short(f.durationMs) : undefined, ago(new Date(f.mtimeMs).toISOString())].filter(Boolean).join(", "),
    tone: "text-faint",
  };
}

function Wall({ items, busy, onPick, onRemove }: { items: WallItem[]; busy?: string; onPick: (it: WallItem) => void; onRemove: (c: CutSummary) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gap = 16;
  const target = width > 1700 ? 250 : 220;
  const laid = useMemo(() => (width ? rows(items, width, target, gap) : []), [items, width, target]);
  return (
    <div ref={ref} className="grid gap-y-6">
      {laid.map((row, i) => (
        <div key={i} className="flex items-start" style={{ gap }}>
          {row.items.map((it) => {
            const w = Math.floor(row.h * it.aspect);
            const meta = itemMeta(it);
            return (
              <div key={it.key} className="group relative shrink-0" style={{ width: w }}>
                <button onClick={() => onPick(it)} disabled={busy === it.key} className="block w-full rounded-[10px] text-left" title={it.file?.path ?? it.cut?.path}>
                  <div className="relative overflow-hidden rounded-[10px] bg-panel" style={{ height: row.h }}>
                    {it.stack ? (
                      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-[2px]">
                        {it.stack.slice(0, 4).map((x) => (
                          <div key={x.key} className="relative overflow-hidden bg-well">
                            <Img src={itemPoster(x)} className="transition-[opacity,filter] group-hover:brightness-110" />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <Blank />
                        <Img src={itemPoster(it)} className="transition-[opacity,filter] group-hover:brightness-110" />
                      </>
                    )}
                    {busy === it.key && <div className="absolute inset-0 grid place-items-center bg-ink/70 text-[13px] font-semibold">Opening</div>}
                    {it.cut && it.cut.openNotes + it.cut.draftNotes > 0 && (
                      <span className="absolute top-2 left-2 rounded-full bg-amber px-2 text-[12px] leading-[20px] font-bold text-amber-ink">{it.cut.openNotes + it.cut.draftNotes}</span>
                    )}
                  </div>
                  <div className="mt-2 text-[13.5px] leading-snug font-medium [overflow-wrap:anywhere] text-text">{it.name}</div>
                  <div className={cn("text-[12.5px] leading-snug", meta.tone)}>{meta.text}</div>
                </button>
                {it.cut && (
                  <IconButton
                    label="Remove from Dailies"
                    onClick={() => onRemove(it.cut!)}
                    className="absolute top-1.5 right-1.5 size-7 bg-ink/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-4"
                  >
                    <X />
                  </IconButton>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function phrase(a: ActivityItem): { verb: string; body?: string } {
  const t = a.text.trim();
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  if (a.author.kind === "unknown") return { verb: lower(t) };
  if (a.kind === "revision") return { verb: `saved r${a.rev}`, body: t };
  if (a.kind === "approve") return { verb: `approved r${a.rev}` };
  if (a.kind === "open") return { verb: "opened this cut" };
  if (a.kind === "publish") {
    const m = /^Published r\d+(?::\s*([\s\S]*))?$/.exec(t);
    return m ? { verb: `published r${a.rev}`, body: m[1] } : { verb: lower(t) };
  }
  if (a.kind === "edit") {
    const m = /^(Edited|Queued for ([^:]+)|Applied|Undid):\s*([\s\S]*)$/.exec(t);
    if (!m) return { verb: lower(t) };
    const verb = m[1] === "Edited" ? "edited" : m[2] ? `queued an edit for ${m[2]}` : m[1] === "Applied" ? "applied a queued edit" : "undid an edit";
    return { verb, body: m[3] };
  }
  if (a.kind === "reply") {
    const m = /^(Resolved|Reopened|Open|Working on it|Addressed|Won't fix|Draft):\s*([\s\S]*)$/.exec(t);
    const verbs: Record<string, string> = {
      Resolved: "resolved a note",
      Reopened: "reopened a note",
      Open: "reopened a note",
      "Working on it": "took a note",
      Addressed: "addressed a note",
      "Won't fix": "won't fix a note",
      Draft: "replied to a note",
    };
    return m ? { verb: verbs[m[1]], body: m[2] } : { verb: "replied to a note", body: t };
  }
  if (a.kind === "status") {
    const verb = a.state === "blocked" ? "needs you" : a.state === "ready" ? "is ready" : a.state === "idle" ? "went idle" : "is working";
    return { verb, body: t && t !== a.state ? t : undefined };
  }
  if (a.kind === "note") return { verb: "left a note", body: t };
  return { verb: lower(t) };
}

function collapse(items: ActivityItem[]) {
  const out: ActivityItem[] = [];
  for (const a of items) {
    const prev = out.at(-1);
    if (prev && a.kind === "status" && prev.kind === "status" && prev.cutId === a.cutId && prev.author.name === a.author.name) continue;
    if (a.kind === "render") continue;
    out.push(a);
  }
  return out;
}

function agentState(c: CutSummary): { dot: string; text: string } {
  const a = c.agent!;
  if (isWorking(c)) return { dot: "bg-teal animate-pulse", text: a.text || "Working" };
  if (a.state === "blocked") return { dot: "bg-amber", text: `Needs you: ${a.text}` };
  if (awaitingReview(c))
    return {
      dot: "bg-amber",
      text: `Published r${c.latest!.n}, waiting on you`,
    };
  if (c.approvedRev && c.approvedRev === c.latest?.n) return { dot: "bg-faint", text: `r${c.approvedRev} approved` };
  return { dot: "bg-faint", text: `Last seen ${ago(a.at)}` };
}

function Rail({ cuts, activity, onOpen }: { cuts: CutSummary[]; activity: ActivityItem[]; onOpen: (t: OpenTarget) => void }) {
  const agents = cuts.filter((c) => c.agent).sort((a, b) => b.agent!.at.localeCompare(a.agent!.at));
  const feed = collapse(activity).slice(0, 40);
  const many = new Set(feed.map((a) => a.cutId)).size > 1;
  return (
    <aside className="hidden min-h-0 flex-col overflow-y-auto border-l border-line bg-well px-3 pt-4 pb-8 lg:flex">
      <Heading count={agents.length || undefined} className="px-2.5">
        Agents
      </Heading>
      <div className="mt-2 grid gap-0.5">
        {agents.length === 0 && <p className="px-2.5 text-[13.5px] text-dim">Agents show up here when they open a cut with dailies_open.</p>}
        {agents.map((c) => {
          const s = agentState(c);
          return (
            <button key={c.id} onClick={() => onOpen({ cutId: c.id })} className="grid grid-cols-[7px_minmax(0,1fr)] gap-x-3 rounded-lg px-2.5 py-2 text-left hover:bg-panel">
              <i className={cn("mt-[7px] size-[7px] rounded-full", s.dot)} />
              <div className="min-w-0">
                <div className="[overflow-wrap:anywhere]">
                  <b className="font-semibold">{c.agent!.name}</b> <span className="text-dim">on {c.name}</span>
                </div>
                <div className="text-[13px] leading-snug text-soft [overflow-wrap:anywhere]">{s.text}</div>
              </div>
            </button>
          );
        })}
      </div>
      <Heading className="mt-6 px-2.5">Activity</Heading>
      <div className="mt-2 grid gap-0.5">
        {feed.length === 0 && <p className="px-2.5 text-[13.5px] text-dim">Revisions, notes and approvals across your cuts land here.</p>}
        {feed.map((a, i) => {
          const p = phrase(a);
          const label = many && feed[i - 1]?.cutId !== a.cutId;
          return (
            <div key={`${a.cutId}-${a.id}`} className="contents">
              {label && <div className={cn("px-2.5 pb-0.5 text-[12px] font-medium text-faint [overflow-wrap:anywhere]", i > 0 && "mt-3")}>{a.cut}</div>}
              <button onClick={() => onOpen({ cutId: a.cutId, tab: a.noteId ? "cues" : undefined })} className="rounded-lg px-2.5 py-2 text-left hover:bg-panel">
                <div className="text-[13.5px] leading-snug [overflow-wrap:anywhere]">
                  <b className={cn("font-semibold", a.author.kind === "agent" ? "text-teal" : a.author.kind === "you" ? "text-amber" : "text-text")}>{a.author.name}</b>{" "}
                  <span className="text-soft">{p.verb}</span> <span className="text-[12px] whitespace-nowrap text-faint">{ago(a.at)}</span>
                </div>
                {p.body && <div className="mt-0.5 text-[13px] leading-snug text-dim [overflow-wrap:anywhere]">{p.body}</div>}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function Heading({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <h2 className={cn("flex items-baseline gap-2.5 text-[15px] font-semibold", className)}>
      {children}
      {count !== undefined && <span className="text-[13px] font-medium text-faint">{count}</span>}
    </h2>
  );
}

export function Library({ onOpen }: { onOpen: (t: OpenTarget) => void }) {
  const { cuts, library, error, refresh, refreshLibrary } = useCuts();
  const activity = useActivity();
  const [busy, setBusy] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !(e.target instanceof HTMLInputElement))) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (name: string, folder: string) => terms.every((t) => `${name} ${folder}`.toLowerCase().includes(t));

  const all = useMemo(
    () =>
      (cuts ?? []).map((c) => ({
        ...c,
        recent: c.recent ?? [],
        latest: c.latest && { ...c.latest, changed: c.latest.changed ?? [], segments: c.latest.segments ?? Math.max(1, Math.ceil(c.latest.durationMs / 1000)) },
      })),
    [cuts],
  );
  const order = (a: CutSummary, b: CutSummary) => Number(b.agent?.state === "blocked") - Number(a.agent?.state === "blocked") || (b.latest?.at ?? "").localeCompare(a.latest?.at ?? "");
  const inbox = all.filter((c) => needsYou(c) && matches(c.name, c.folder)).sort(order);
  const working = all.filter((c) => !c.missing && isWorking(c) && matches(c.name, c.folder)).sort(order);
  const active = new Set([...inbox, ...working].map((c) => c.id));
  const known = new Set(all.map((c) => c.id));

  const wall = useMemo<WallItem[]>(() => {
    const byRecent = (a: WallItem, b: WallItem) => b.at - a.at;
    const fromCuts: WallItem[] = all
      .filter((c) => !active.has(c.id) && matches(c.name, c.folder))
      .map((c) => ({
        key: c.id,
        aspect: c.latest ? c.latest.width / c.latest.height : 9 / 16,
        name: c.name,
        at: Date.parse(c.latest?.at ?? "") || 0,
        group: c.folder,
        cut: c,
      }));
    const fromFiles: WallItem[] = library
      .filter((f) => !(f.registered || (f.id && known.has(f.id))) && matches(f.name, `${f.folder} ${f.group ?? ""}`))
      .map((f) => ({
        key: f.path,
        aspect: f.width && f.height ? f.width / f.height : 9 / 16,
        name: f.name,
        at: f.mtimeMs,
        group: f.group || f.folder,
        file: f,
      }));
    const items = [...fromCuts, ...fromFiles].sort(byRecent);
    if (folder) return items.filter((i) => i.group === folder);
    if (terms.length) return items;
    const counts = new Map<string, number>();
    for (const i of fromFiles) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
    const stacks = new Map<string, WallItem[]>();
    const out: WallItem[] = [];
    for (const i of items) {
      if (!i.cut && (counts.get(i.group) ?? 0) >= STACK_MIN) stacks.set(i.group, [...(stacks.get(i.group) ?? []), i]);
      else out.push(i);
    }
    for (const [g, list] of stacks)
      out.push({
        key: `stack:${g}`,
        aspect: 4 / 5,
        name: g,
        at: list[0].at,
        group: g,
        stack: list,
      });
    return out.sort(byRecent);
  }, [cuts, library, q, folder]);

  async function openFile(path: string) {
    setBusy(path);
    setOpenError(undefined);
    try {
      const c = await api<CutSummary>("/api/cuts/open", { body: { path } });
      await refresh();
      void refreshLibrary();
      onOpen({ cutId: c.id });
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function pick() {
    const files = (await window.dailies?.openFile()) ?? [];
    for (const f of files) await openFile(f);
  }

  async function remove(id: string) {
    await api(`/api/cuts/${id}/close`, { body: {} });
    void refresh();
    void refreshLibrary();
  }

  const nothing = cuts && cuts.length === 0 && library.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 pr-[150px] pl-5">
        <Mark />
        <span className="font-semibold">Dailies</span>
        <UpdatePill />
        <div className="flex-1" />
        <label className="no-drag flex h-[34px] w-[320px] items-center gap-2 rounded-[9px] bg-panel px-3 text-faint focus-within:text-soft focus-within:ring-2 focus-within:ring-amber/60">
          <Search className="size-[15px] shrink-0" />
          <input
            ref={search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search projects"
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-faint"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Clear search" className="grid size-5 place-items-center rounded text-dim hover:text-text">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        <Button onClick={pick}>
          <FolderOpen className="size-4" />
          Open project
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px]">
        <main className="min-h-0 overflow-y-auto px-7 pt-3 pb-12">
          {error && <div className="mb-4 rounded-lg bg-panel px-4 py-3 text-red">{error}</div>}
          {openError && <div className="mb-4 rounded-lg bg-panel px-4 py-3 text-red">{openError}</div>}
          {nothing && (
            <div className="mx-auto mt-24 max-w-md text-center">
              <div className="text-[17px] font-semibold">No projects yet</div>
              <p className="mt-2 text-soft">Agents add their cut here when they call dailies_open. You can also open any .tsrct yourself.</p>
              <Button variant="primary" className="mt-5" onClick={pick}>
                <FolderOpen className="size-4" />
                Open project
              </Button>
            </div>
          )}
          {inbox.length > 0 && (
            <section className="mb-9">
              <Heading count={inbox.length}>Needs you</Heading>
              <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,740px),1fr))] gap-3.5">
                {inbox.map((c) => (
                  <InboxCard key={c.id} cut={c} wide={inbox.length === 1} onOpen={onOpen} onRemove={() => void remove(c.id)} onApproved={() => void refresh()} />
                ))}
              </div>
            </section>
          )}
          {working.length > 0 && (
            <section className="mb-9">
              <Heading count={working.length}>Agents working</Heading>
              <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,740px),1fr))] gap-3.5">
                {working.map((c) => (
                  <InboxCard key={c.id} cut={c} wide={working.length === 1} onOpen={onOpen} onRemove={() => void remove(c.id)} onApproved={() => void refresh()} />
                ))}
              </div>
            </section>
          )}
          {(wall.length > 0 || folder) && (
            <section>
              {folder ? (
                <div className="flex items-center gap-3">
                  <Button variant="ghost" size="sm" onClick={() => setFolder(undefined)} className="-ml-2.5">
                    <ArrowLeft className="size-4" />
                    All projects
                  </Button>
                  <Heading count={wall.length}>{folder}</Heading>
                </div>
              ) : (
                <Heading count={wall.reduce((n, i) => n + (i.stack?.length ?? 1), 0)}>{inbox.length || working.length ? "Other projects" : "Projects"}</Heading>
              )}
              <div className="mt-3">
                <Wall
                  items={wall}
                  busy={busy}
                  onPick={(it) => (it.stack ? setFolder(it.group) : it.cut ? onOpen({ cutId: it.cut.id }) : void openFile(it.file!.path))}
                  onRemove={(c) => void remove(c.id)}
                />
              </div>
            </section>
          )}
          {terms.length > 0 && !inbox.length && !working.length && !wall.length && <p className="mt-16 text-center text-soft">No projects match “{q.trim()}”.</p>}
        </main>
        <Rail cuts={all} activity={activity} onOpen={onOpen} />
      </div>
    </div>
  );
}
