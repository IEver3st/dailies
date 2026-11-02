import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ActivityItem, CutSummary } from "@/lib/api";
import { ago, cn, plural } from "@/lib/format";
import { awaitingReview, cutPoster, isWorking, needsYou } from "@/lib/cuts";
import { preferences, setPreferences, usePreference } from "@/lib/preferences";
import { Popover as P } from "radix-ui";
import { Button, Tip } from "./ui/button";
import { Img } from "./ui/img";
import { Heading } from "./ui/heading";
import { openSetup } from "./Setup";
import type { OpenTarget } from "./Library";

let vacant = true;
const nudges = new Set<() => void>();

export function togglePanel() {
  if (vacant) nudges.forEach((f) => f());
  else void setPreferences({ agentsPanel: !preferences().agentsPanel });
}

type Tone = "working" | "needs" | "ready" | "idle";

function agentState(c: CutSummary): { tone: Tone; text: string } {
  const a = c.agent!;
  if (isWorking(c)) return { tone: "working", text: a.text || "Working" };
  if (a.state === "blocked") return { tone: "needs", text: a.text ? `Needs you: ${a.text}` : "Needs you" };
  if (awaitingReview(c)) return { tone: "needs", text: `Published r${c.latest!.n}, waiting on you` };
  if (c.approvedRev && c.approvedRev === c.latest?.n) return { tone: "ready", text: `r${c.approvedRev} approved` };
  return { tone: "idle", text: `Last seen ${ago(a.at)}` };
}

const rank = (c: CutSummary) => (needsYou(c) ? 0 : isWorking(c) ? 1 : 2);

function agentsOf(cuts: CutSummary[]) {
  return cuts.filter((c) => c.agent).sort((a, b) => rank(a) - rank(b) || b.agent!.at.localeCompare(a.agent!.at));
}

const hasContent = (cuts: CutSummary[], activity: ActivityItem[]) => cuts.some((c) => c.agent) || activity.some((a) => a.kind !== "render");

export function usePanelShown(cuts: CutSummary[], activity: ActivityItem[]) {
  return usePreference("agentsPanel") && hasContent(cuts, activity);
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

function collapse(items: ActivityItem[], cuts: CutSummary[]) {
  const now = new Map(cuts.flatMap((c) => (c.agent ? [[c.id, c.agent] as const] : [])));
  const said = new Set<string>();
  const out: ActivityItem[] = [];
  for (const a of items) {
    if (a.kind === "render") continue;
    if (a.kind === "status") {
      const prev = out.at(-1);
      if (prev?.kind === "status" && prev.cutId === a.cutId && prev.author.name === a.author.name) continue;
      const line = [a.cutId, a.author.name, a.state, a.text.trim()].join("|");
      if (said.has(line)) continue;
      said.add(line);
      const agent = now.get(a.cutId);
      if (agent && agent.name === a.author.name && agent.state === a.state && agent.text.trim() === a.text.trim()) continue;
    }
    out.push(a);
  }
  return out;
}

type Shown<T> = { item: T; key: string; leaving: boolean };

function usePresence<T>(items: T[], keyOf: (t: T) => string, ms = 300) {
  const [shown, setShown] = useState<Shown<T>[]>(() => items.map((item) => ({ item, key: keyOf(item), leaving: false })));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latest = useRef(items);
  latest.current = items;
  const signature = items.map(keyOf).join("|");
  useEffect(() => {
    const items = latest.current;
    const live = new Map(items.map((i) => [keyOf(i), i]));
    for (const k of live.keys()) {
      const t = timers.current.get(k);
      if (t) {
        clearTimeout(t);
        timers.current.delete(k);
      }
    }
    setShown((prev) => {
      const out: Shown<T>[] = items.map((item) => ({ item, key: keyOf(item), leaving: false }));
      prev.forEach((p, i) => {
        if (live.has(p.key)) return;
        out.splice(Math.min(i, out.length), 0, { ...p, leaving: true });
        if (timers.current.has(p.key)) return;
        timers.current.set(
          p.key,
          setTimeout(() => {
            timers.current.delete(p.key);
            setShown((s) => s.filter((x) => x.key !== p.key));
          }, ms),
        );
      });
      return out;
    });
  }, [signature, keyOf, ms]);
  useEffect(() => {
    const map = timers.current;
    return () => map.forEach(clearTimeout);
  }, []);
  const byKey = new Map(items.map((i) => [keyOf(i), i]));
  return shown.map((s) => (s.leaving ? s : { ...s, item: byKey.get(s.key) ?? s.item }));
}

function useSettled(ready: boolean) {
  const settled = useRef(false);
  useEffect(() => {
    if (ready) settled.current = true;
  });
  return settled.current;
}

function useFresh(keys: string[]) {
  const seen = useRef<Set<string>>(undefined);
  if (!seen.current) seen.current = new Set(keys);
  const fresh = new Set<string>();
  for (const k of keys) if (!seen.current.has(k)) fresh.add(k);
  useEffect(() => {
    for (const k of keys) seen.current!.add(k);
  });
  return fresh;
}

function Avatar({ cut, tone, size }: { cut: CutSummary; tone: Tone; size: "lg" | "sm" }) {
  const letter = cut.name.trim().charAt(0).toUpperCase();
  const lg = size === "lg";
  return (
    <span className={cn("rail-ring relative grid shrink-0 place-items-center p-[2px]", lg ? "size-10 rounded-[11px]" : "size-[26px] rounded-[8px] [--rail-pulse-mix:30%] [--rail-pulse:5px]")} data-tone={tone}>
      <span className={cn("relative grid size-full place-items-center overflow-hidden bg-panel font-semibold text-soft", lg ? "rounded-[9px] text-[13px]" : "rounded-[6px] text-[11px]")}>
        {letter}
        <Img src={cutPoster(cut)} />
      </span>
      {lg && <i className="rail-dot absolute -right-px -bottom-px size-2.5 rounded-full" />}
    </span>
  );
}

const cutKey = (c: CutSummary) => c.id;
const STACK = 4;

function Seats({ size }: { size: number }) {
  return (
    <span className="relative shrink-0" style={{ width: size * 1.7, height: size }}>
      {[0, 1, 2].map((i) => (
        <i
          key={i}
          className="rail-seat absolute top-0"
          style={{ left: i * size * 0.35, width: size, height: size, borderRadius: size * 0.28, zIndex: 3 - i, background: `color-mix(in srgb, var(--color-faint) ${[70, 45, 25][i]}%, var(--color-raised))`, animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}

function Vacant({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex items-start gap-3.5">
      <Seats size={28} />
      <div className="min-w-0">
        <p className="text-soft text-pretty">Agents land here when they open a cut.</p>
        <Button
          variant="primary"
          size="sm"
          className="mt-2.5"
          onClick={() => {
            onDone();
            openSetup();
          }}
        >
          Connect an agent
        </Button>
      </div>
    </div>
  );
}

export function AgentsPresence({ cuts, activity }: { cuts: CutSummary[]; activity: ActivityItem[] }) {
  const open = usePreference("agentsPanel");
  const content = hasContent(cuts, activity);
  const shown = open && content;
  const all = agentsOf(cuts);
  const active = all.filter((c) => rank(c) < 2);
  const pool = active.length ? active : shown ? all : [];
  const stack = usePresence(pool.slice(0, STACK), cutKey, 320);
  const settled = useSettled(stack.length > 0);
  const [card, setCard] = useState(false);
  const waiting = all.filter(needsYou).length;
  const working = all.filter(isWorking).length;
  const parts = [working && `${working} working`, waiting && `${waiting} waiting on you`].filter(Boolean);
  const label = shown ? "Hide agents" : parts.length ? parts.join(", ") : plural(all.length, "agent");

  useEffect(() => {
    vacant = !content;
    if (content) setCard(false);
  }, [content]);
  useEffect(() => {
    const nudge = () => setCard((c) => !c);
    nudges.add(nudge);
    return () => void nudges.delete(nudge);
  }, []);

  return (
    <P.Root open={card} onOpenChange={setCard}>
      <P.Anchor asChild>
        <span className="flex h-8 shrink-0 items-center empty:-ml-3 empty:w-0">
          {stack.length > 0 && (
            <Tip label={label} keys="Ctrl B" side="bottom">
              <button
                onClick={togglePanel}
                aria-label={label}
                aria-pressed={shown}
                className={cn(
                  "no-drag flex h-8 shrink-0 items-center rounded-lg pl-[3px] transition-colors duration-150",
                  shown ? "bg-raised [--rail-cut:var(--color-raised)]" : "[--rail-cut:var(--color-ink)] hover:bg-raised hover:[--rail-cut:var(--color-raised)]",
                  waiting ? "pr-2" : "pr-[3px]",
                )}
              >
                <span className="flex items-center pr-[10px]">
                  {stack.map(({ item: c, key, leaving }, i) => (
                    <span key={key} className={cn("rail-slot relative h-[30px]", leaving && "rail-slot-out")} style={{ zIndex: STACK + 2 - i, "--d": settled ? "0ms" : `${i * 70}ms` } as CSSProperties}>
                      <span className="rail-pop absolute top-0 left-0 rounded-[10px] bg-[var(--rail-cut)] p-[2px]">
                        <Avatar cut={c} tone={agentState(c).tone} size="sm" />
                      </span>
                    </span>
                  ))}
                </span>
                {waiting > 0 && (
                  <span key={waiting} className="rail-swap ml-0.5 text-[13.5px] font-semibold text-amber tabular-nums">
                    {waiting}
                  </span>
                )}
              </button>
            </Tip>
          )}
        </span>
      </P.Anchor>
      <P.Portal>
        <P.Content align="end" sideOffset={10} collisionPadding={12} onOpenAutoFocus={(e) => e.preventDefault()} className="rail-card z-50 w-max max-w-[min(380px,calc(100vw-24px))] rounded-xl bg-raised p-4 shadow-[0_12px_40px_rgba(0,0,0,.5)]">
          <Vacant onDone={() => setCard(false)} />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

function Row({ children, leaving, delay, className, onClick, label }: { children: ReactNode; leaving?: boolean; delay?: number; className?: string; onClick?: () => void; label?: string }) {
  return (
    <div className={cn("rail-row grid", leaving && "rail-row-out")} style={{ transitionDelay: leaving ? undefined : `${delay ?? 0}ms` }}>
      <div className="min-h-0 overflow-hidden">
        <button onClick={onClick} aria-label={label} className={cn("group grid w-full text-left transition-colors duration-150", className)}>
          {children}
        </button>
      </div>
    </div>
  );
}

function AgentRow({ cut, delay, leaving, onOpen }: { cut: CutSummary; delay: number; leaving: boolean; onOpen: (t: OpenTarget) => void }) {
  const s = agentState(cut);
  return (
    <Row leaving={leaving} delay={delay} onClick={() => onOpen({ cutId: cut.id })} className="grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3 rounded-xl px-2.5 py-2 hover:bg-panel">
      <Avatar cut={cut} tone={s.tone} size="lg" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <b className="max-w-[70%] shrink-0 truncate font-semibold">{cut.name}</b>
          <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{cut.agent!.name}</span>
          <span className="shrink-0 text-[12px] text-faint tabular-nums">{ago(cut.agent!.at)}</span>
        </div>
        <div key={s.text} className={cn("rail-swap line-clamp-2 text-[13px] leading-snug [overflow-wrap:anywhere]", s.tone === "needs" ? "text-amber" : s.tone === "working" ? "text-soft" : "text-dim")}>
          {s.text}
        </div>
      </div>
    </Row>
  );
}

const authorTone = (k: ActivityItem["author"]["kind"]) => (k === "agent" ? "text-teal" : k === "you" ? "text-amber" : "text-text");
const dotTone = (k: ActivityItem["author"]["kind"]) => (k === "agent" ? "bg-teal" : k === "you" ? "bg-amber" : "bg-soft");
const feedKey = (a: ActivityItem) => `${a.cutId}-${a.id}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Feed({ items, cuts, onOpen }: { items: ActivityItem[]; cuts: CutSummary[]; onOpen: (t: OpenTarget) => void }) {
  const fresh = useFresh(items.map(feedKey));
  const byId = new Map(cuts.map((c) => [c.id, c]));
  return (
    <div className="grid">
      {items.map((a, i) => {
        const p = phrase(a);
        const key = feedKey(a);
        const prev = items[i - 1];
        const head = prev?.cutId !== a.cutId;
        const last = items[i + 1]?.cutId !== a.cutId;
        const named = head || prev.author.name !== a.author.name;
        const cut = byId.get(a.cutId);
        return (
          <div key={key} className={cn("rail-row grid", fresh.has(key) && "rail-fresh")}>
            <div className="min-h-0 overflow-hidden">
              {head && (
                <button onClick={() => onOpen({ cutId: a.cutId })} className={cn("group flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left", i > 0 && "mt-3")}>
                  <span className="relative size-[18px] shrink-0 overflow-hidden rounded-[5px] bg-panel">{cut && <Img src={cutPoster(cut)} />}</span>
                  <span className="min-w-0 truncate text-[12.5px] font-semibold text-dim transition-colors group-hover:text-text">{a.cut}</span>
                </button>
              )}
              <button
                onClick={() => onOpen({ cutId: a.cutId, tab: a.noteId ? "cues" : undefined })}
                className="rail-item group grid w-full grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 rounded-lg px-2.5 py-[6px] text-left transition-colors duration-150 hover:bg-panel"
              >
                <span className="relative flex justify-center">
                  {!last && <i className="absolute top-[13px] -bottom-3 w-px bg-line" />}
                  <i className={cn("relative mt-[6px] size-[7px] rounded-full ring-[3px] ring-well transition-[box-shadow] group-hover:ring-panel", dotTone(a.author.kind))} />
                </span>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">
                      {named ? (
                        <>
                          <b className={cn("inline-block max-w-[60%] truncate align-bottom font-semibold", authorTone(a.author.kind))}>{a.author.name}</b> <span className="text-soft">{p.verb}</span>
                        </>
                      ) : (
                        <span className="text-soft">{capital(p.verb)}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-[12px] text-faint">{ago(a.at)}</span>
                  </span>
                  {p.body && <span className="mt-0.5 line-clamp-3 block text-[13px] leading-snug text-dim [overflow-wrap:anywhere]">{p.body}</span>}
                </span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Rail({ cuts, activity, onOpen }: { cuts: CutSummary[]; activity: ActivityItem[]; onOpen: (t: OpenTarget) => void }) {
  const open = usePanelShown(cuts, activity);
  const live = agentsOf(cuts);
  const agents = usePresence(live, cutKey);
  const settled = useSettled(agents.length > 0);
  const feed = collapse(activity, cuts).slice(0, 40);
  return (
    <aside className="relative hidden min-h-0 overflow-hidden bg-well lg:block" aria-hidden={!open} inert={!open}>
      <div className={cn("rail-sheet absolute inset-y-0 left-0 flex w-[var(--rail-open)] flex-col overflow-x-hidden overflow-y-auto px-3 pt-3 pb-8", !open && "rail-sheet-hidden")}>
        <>
            {live.length > 0 && (
              <>
                <Heading count={live.length} className="px-2.5">
                  Agents
                </Heading>
                <div className="mt-2 grid">
                  {agents.map(({ item, key, leaving }, i) => (
                    <AgentRow key={key} cut={item} delay={settled ? 0 : i * 45} leaving={leaving} onOpen={onOpen} />
                  ))}
                </div>
              </>
            )}
            {feed.length > 0 && (
              <>
                <Heading className={cn("px-2.5", live.length > 0 && "mt-7")}>Activity</Heading>
                <div className="mt-2">
                  <Feed items={feed} cuts={cuts} onOpen={onOpen} />
                </div>
              </>
            )}
        </>
      </div>
    </aside>
  );
}
