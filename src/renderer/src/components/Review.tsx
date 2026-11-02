import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Repeat, Smartphone, Columns2, Maximize, FolderOpen, ExternalLink } from "lucide-react";
import type { Annotation, CutDetail, TrackItem } from "@/lib/api";
import { api, mediaUrl } from "@/lib/api";
import { useCut } from "@/lib/store";
import { PlayerController, usePlayerSelect } from "@/lib/player";
import { ago, cn, FPS, frameAt, frameOf, tc } from "@/lib/format";
import { Button, IconButton, Tip } from "./ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Tabs, Tab, TabsContent, TabsList } from "./ui/tabs";
import { Player, type CompareMode } from "./Player";
import { VolumeControl } from "./Volume";
import { Sketch, drawAnnotations, type Tool } from "./Sketch";
import { Filmstrip } from "./Filmstrip";
import { Cues, type ComposerHandle } from "./Cues";
import { Inspector, type EditRequest } from "./Inspector";
import { History } from "./History";
import { Mark } from "./Mark";

type Toast = { id: number; text: string; tone?: "error" };

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone?: "error") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3800);
  }, []);
  return { toasts, push };
}

function SafeZones() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-x-0 top-0 h-[8%] border-b border-dashed border-white/25" />
      <div className="absolute top-[38%] right-0 h-[42%] w-[14%] border-l border-dashed border-white/25" />
      <div className="absolute inset-x-0 bottom-0 h-[19%] border-t border-dashed border-white/25" />
      <div className="absolute top-[8%] right-[14%] bottom-[19%] left-[5%] border border-dashed border-amber/30" />
    </div>
  );
}

function Presence({ cut, room, inline }: { cut: CutDetail; room?: number; inline?: boolean }) {
  const a = cut.agent;
  const latest = cut.revisions.at(-1);
  const rendering = cut.segments.filter((s) => s === "rendering" || s === "queued").length;
  const stale = cut.movie && cut.movie.rev === cut.rev ? cut.movie.stale.length : 0;
  const collaborator = cut.collaborators.at(-1);
  const fresh = a && Date.now() - Date.parse(a.at) < 30 * 60_000;
  const dot = a && (
    <span className={cn("size-2 shrink-0 rounded-full", a.state === "working" && fresh ? "animate-pulse bg-teal" : a.state === "blocked" ? "bg-red" : a.state === "ready" ? "bg-amber" : "bg-faint")} />
  );
  const status =
    a && (a.state === "working" ? a.text || "Working on this cut" : a.state === "ready" ? a.text || `r${latest?.n} is ready` : a.state === "blocked" ? `Needs you: ${a.text}` : a.text || "Idle");
  if (inline) {
    if (!a && !rendering && !cut.renderError) return null;
    return (
      <div className="flex min-w-0 items-center gap-2 text-[13px]" title={a ? `${a.name}: ${status}` : undefined}>
        {a && (
          <>
            {dot}
            <span className="shrink-0 font-semibold">{a.name}</span>
            <span className="truncate text-soft">{status}</span>
          </>
        )}
        {rendering > 0 && <span className="shrink-0 text-amber">Rendering {rendering}s</span>}
        {cut.renderError && <span className="shrink-0 text-red">Render failed</span>}
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute top-5 left-6 z-10 grid gap-3" style={{ maxWidth: Math.min(320, room ?? 320) }}>
      {a && (
        <div>
          <div className="flex items-center gap-2 font-semibold">
            {dot}
            {a.name}
            {collaborator?.link && (
              <button className="pointer-events-auto text-dim hover:text-text" aria-label="Open the agent's thread" onClick={() => void window.dailies?.openExternal(collaborator.link!)}>
                <ExternalLink className="size-3.5" />
              </button>
            )}
          </div>
          <div className="mt-0.5 text-soft">{status}</div>
          <div className="mt-0.5 text-[12px] text-faint">{ago(a.at)}</div>
        </div>
      )}
      {(rendering > 0 || stale > 0 || cut.renderError) && (
        <div className="text-[12.5px]">
          {rendering > 0 && (
            <div className="text-amber">
              Rendering {rendering} {rendering === 1 ? "second" : "seconds"}
            </div>
          )}
          {stale > 0 && (
            <div className="text-soft">
              {stale} {stale === 1 ? "second still shows" : "seconds still show"} the previous revision
            </div>
          )}
          {cut.renderError && <div className="pointer-events-auto text-red">{cut.renderError}</div>}
        </div>
      )}
    </div>
  );
}

const PRESENCE_MIN = 156;

export function Review({ cutId, start, onBack }: { cutId: string; start?: { rev?: number; t?: number; tab?: string }; onBack: () => void }) {
  const [viewRev, setViewRev] = useState<number | undefined>(start?.rev);
  const { cut, error } = useCut(cutId, viewRev);
  const controller = useMemo(() => {
    const c = new PlayerController();
    if (start?.t) c.seek(start.t);
    return c;
  }, []);
  const playing = usePlayerSelect(controller, (s) => s.playing);
  const rate = usePlayerSelect(controller, (s) => s.rate);
  const loop = usePlayerSelect(controller, (s) => s.loop);
  const durationMs = usePlayerSelect(controller, (s) => s.durationMs);
  const time = usePlayerSelect(controller, (s) => (s.playing ? Math.floor(s.time / 250) * 250 : s.time));
  const [src, setSrc] = useState<string>();
  const [compare, setCompare] = useState<{ rev: number; mode: CompareMode; pos: number; src?: string }>();
  const [safe, setSafe] = useState(false);
  const [gutter, setGutter] = useState(PRESENCE_MIN);
  const [tool, setTool] = useState<Tool>();
  const [pending, setPending] = useState<Annotation[]>([]);
  const [selectedNote, setSelectedNote] = useState<string>();
  const [selectedLayer, setSelectedLayer] = useState<number>();
  const [tab, setTab] = useState(() => start?.tab ?? new URL(location.href).searchParams.get("tab") ?? "cues");
  const composer = useRef<ComposerHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { toasts, push } = useToasts();

  const movieKey = cut?.movie ? `${cut.movie.rev}-${cut.movie.key}` : undefined;
  useEffect(() => {
    if (!cut?.movie) {
      if (viewRev !== undefined && cut?.rev === viewRev) {
        setSrc(undefined);
        void api(`/api/cuts/${cut.id}/render`, { body: { rev: viewRev } }).catch(() => {});
      }
      return;
    }
    void mediaUrl(`/api/cuts/${cut.id}/movie?rev=${cut.movie.rev}&k=${cut.movie.key}`).then(setSrc);
  }, [movieKey, viewRev, cut?.rev]);

  const compareKey = cut?.revisions.find((r) => r.n === compare?.rev)?.movieKey;
  useEffect(() => {
    if (!compare || !cut) return;
    if (!compareKey) return void api(`/api/cuts/${cut.id}/render`, { body: { rev: compare.rev } }).catch(() => {});
    void mediaUrl(`/api/cuts/${cut.id}/movie?rev=${compare.rev}&k=${compareKey}`).then((u) => setCompare((c) => (c && c.rev === compare.rev ? { ...c, src: u } : c)));
  }, [compare?.rev, cut?.id, compareKey]);

  useEffect(() => {
    let last = 0;
    controller.onTime = (ms) => {
      if (Math.abs(ms - last) < 1500) return;
      last = ms;
      void api(`/api/cuts/${cutId}/playhead`, { body: { t: Math.round(ms) } }).catch(() => {});
    };
    return () => {
      controller.onTime = undefined;
    };
  }, [controller, cutId]);

  const cues = useMemo(() => [...(cut?.notes ?? [])].sort((a, b) => a.displayT - b.displayT || a.createdAt.localeCompare(b.createdAt)), [cut?.notes]);
  const shown = useMemo(() => {
    if (!playing && !tool) {
      const sel = cues.find((n) => n.id === selectedNote);
      if (sel && Math.abs(sel.displayT - time) < 120) return sel.annotations;
      return cues.filter((n) => n.annotations.length && Math.abs(n.displayT - time) < 1000 / FPS).flatMap((n) => n.annotations);
    }
    return [];
  }, [cues, selectedNote, playing, time, tool]);

  const selectedItem: TrackItem | undefined = cut?.timeline.find((t) => t.id === selectedLayer);

  const edit = useCallback(
    async (req: EditRequest, force = false) => {
      if (!cut) return;
      try {
        const r = await api<{ id: string; queued: boolean }>(`/api/cuts/${cut.id}/edits`, { body: { edits: [req], force } });
        if (r.queued) push(`${cut.agent?.name ?? "The agent"} is working on this cut, so the edit is queued. Apply it from its cue when ready.`);
        else push("Edit applied. Re-rendering the changed seconds.");
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    },
    [cut, push],
  );

  const captureMarked = useCallback(() => {
    const v = controller.video;
    if (!v || !v.videoWidth) return undefined;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(v, 0, 0);
    drawAnnotations(ctx, pending, c.width, c.height);
    return c.toDataURL("image/png");
  }, [controller, pending]);

  const seekNote = useCallback(
    (dir: 1 | -1) => {
      if (!cues.length) return;
      const t = controller.state.time;
      const next = dir > 0 ? cues.find((n) => n.displayT > t + 20) : [...cues].reverse().find((n) => n.displayT < t - 20);
      if (next) {
        controller.pause();
        controller.seek(next.displayT);
        setSelectedNote(next.id);
        setTab("cues");
      }
    },
    [cues, controller],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (typing) return;
      const k = e.key.toLowerCase();
      if (e.target instanceof HTMLElement && e.target.getAttribute("role") === "slider" && /^(arrow|home|end|page)/.test(k)) return;
      if (e.ctrlKey && k === "enter") return void (e.preventDefault(), composer.current?.send());
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const loop = controller.state.loop;
      const map: Record<string, () => void> = {
        " ": () => controller.toggle(),
        k: () => controller.toggle(),
        j: () => controller.shuttleBack(),
        l: () => controller.shuttleForward(),
        arrowleft: () => controller.step(e.shiftKey ? -FPS : -1),
        arrowright: () => controller.step(e.shiftKey ? FPS : 1),
        ",": () => controller.step(-1),
        ".": () => controller.step(1),
        home: () => controller.seek(0),
        end: () => controller.seek(controller.state.durationMs),
        i: () => controller.setLoop({ in: controller.state.time, out: Math.max(controller.state.time + 100, loop?.out ?? controller.state.durationMs) }),
        o: () => controller.setLoop({ in: Math.min(loop?.in ?? 0, controller.state.time - 100), out: controller.state.time }),
        x: () => controller.setLoop(undefined),
        n: () => composer.current?.focus(),
        enter: () => composer.current?.focus(),
        r: () => (controller.pause(), setTool((t) => (t === "rect" ? undefined : "rect"))),
        a: () => (controller.pause(), setTool((t) => (t === "arrow" ? undefined : "arrow"))),
        d: () => (controller.pause(), setTool((t) => (t === "pen" ? undefined : "pen"))),
        p: () => (controller.pause(), setTool((t) => (t === "pin" ? undefined : "pin"))),
        escape: () => (tool ? setTool(undefined) : pending.length ? setPending([]) : setSelectedLayer(undefined)),
        "[": () => seekNote(-1),
        "]": () => seekNote(1),
        s: () => setSafe((v) => !v),
        m: () => controller.setMuted(!(controller.state.muted || controller.state.volume === 0)),
        arrowup: () => controller.nudgeVolume(0.05),
        arrowdown: () => controller.nudgeVolume(-0.05),
        c: () => toggleCompare(),
        f: () => void (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen()),
      };
      const fn = map[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function toggleCompare(rev?: number, mode?: CompareMode) {
    if (!cut) return;
    if (compare && rev === undefined && mode === undefined) return setCompare(undefined);
    const current = cut.rev ?? cut.latest?.n ?? 1;
    const target = rev ?? compare?.rev ?? [...cut.revisions].reverse().find((r) => r.n < current && (r.hasMovie || r.restorable))?.n;
    if (target === undefined) return push("There is no earlier revision to compare with yet.");
    setCompare({ rev: target, mode: mode ?? compare?.mode ?? "wipe", pos: compare?.pos ?? 50, src: compare?.rev === target ? compare.src : undefined });
  }

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      push(ok);
    } catch (e) {
      push(e instanceof Error ? e.message : String(e), "error");
    }
  };

  if (error && !cut) {
    return (
      <div className="flex h-full flex-col">
        <header className="drag flex h-12 items-center px-3">
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4" />
            Library
          </Button>
        </header>
        <div className="p-8 text-red">{error}</div>
      </div>
    );
  }
  if (!cut) return <div className="drag h-12" />;

  const latest = cut.revisions.at(-1);
  const viewing = cut.rev ?? latest?.n;
  const aspect = latest
    ? (cut.revisions.find((r) => r.n === viewing)?.size ?? latest.size)
        .split("x")
        .map(Number)
        .reduce((w, h) => w / h)
    : 9 / 16;
  const duration = durationMs || cut.latest?.durationMs || 0;
  const drafts = cut.notes.filter((n) => n.status === "draft").length;

  return (
    <div className="grid h-full grid-rows-[48px_1fr_auto]">
      <header className="drag flex items-center gap-3 pr-[150px] pl-2">
        <Button variant="ghost" onClick={onBack} className="text-dim">
          <ChevronLeft className="size-4" />
          <Mark size={18} />
        </Button>
        <div className="min-w-0">
          <span className="font-semibold">{cut.name}</span>
          {cut.folder !== cut.name && <span className="ml-2.5 text-dim">{cut.folder}</span>}
        </div>
        <IconButton label="Show in Explorer" side="bottom" onClick={() => void window.dailies?.reveal(cut.path)}>
          <FolderOpen />
        </IconButton>
        <div className="flex min-w-0 flex-1 justify-center px-4">{gutter < PRESENCE_MIN && <Presence cut={cut} inline />}</div>
        <div className="no-drag flex gap-0.5 rounded-lg bg-panel p-[3px]">
          {cut.revisions.slice(-6).map((r) => (
            <Tip key={r.n} label={`${r.author}, ${ago(r.at)}: ${r.summary}`} side="bottom">
              <button
                onClick={() => setViewRev(r.n === latest?.n ? undefined : r.n)}
                className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold", viewing === r.n ? "bg-raised text-text" : "text-dim hover:text-text")}
              >
                <i className={cn("size-1.5 rounded-full", r.authorKind === "agent" ? "bg-teal" : r.authorKind === "you" ? "bg-amber" : "bg-faint")} />r{r.n}
              </button>
            </Tip>
          ))}
        </div>
        <Menu>
          <MenuTrigger asChild>
            <Button variant={compare ? "primary" : "quiet"}>{compare ? `${compare.src ? "Comparing" : "Preparing"} r${compare.rev}` : "Compare"}</Button>
          </MenuTrigger>
          <MenuContent>
            {[...cut.revisions]
              .reverse()
              .filter((r) => r.n !== viewing && (r.hasMovie || r.restorable))
              .slice(0, 6)
              .map((r) => (
                <MenuItem key={r.n} onSelect={() => toggleCompare(r.n)}>
                  r{r.n} by {r.author}
                </MenuItem>
              ))}
            <MenuSeparator />
            <MenuItem onSelect={() => toggleCompare(undefined, "wipe")}>Wipe</MenuItem>
            <MenuItem onSelect={() => toggleCompare(undefined, "side")}>Side by side</MenuItem>
            <MenuItem onSelect={() => toggleCompare(undefined, "diff")}>Difference (paused)</MenuItem>
            {compare && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => setCompare(undefined)}>Stop comparing</MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        <Button
          variant={cut.approvedRev === viewing ? "ghost" : "quiet"}
          disabled={cut.approvedRev === viewing}
          onClick={() => void run(() => api(`/api/cuts/${cut.id}/approve`, { body: { rev: viewing } }), `Approved r${viewing}`)}
        >
          {cut.approvedRev === viewing ? `r${viewing} approved` : `Approve r${viewing}`}
        </Button>
      </header>

      <div className="grid min-h-0 grid-cols-[1fr_400px]">
        <div ref={stage} className="relative flex min-h-0 min-w-0 flex-col bg-ink">
          {gutter >= PRESENCE_MIN && <Presence cut={cut} room={gutter - 16} />}
          {viewing !== latest?.n && (
            <div className="absolute top-5 right-6 z-10 flex items-center gap-2 rounded-lg bg-raised px-3 py-1.5">
              Watching r{viewing}
              <Button size="sm" variant="primary" onClick={() => setViewRev(undefined)}>
                Back to r{latest?.n}
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1 px-6 pt-5 pb-3">
            {src ? (
              <Player
                src={src}
                controller={controller}
                aspect={aspect}
                revLabel={`r${viewing}`}
                onGutter={setGutter}
                compare={compare ? { src: compare.src, label: `r${compare.rev}`, mode: compare.mode, pos: compare.pos, onPos: (pos) => setCompare((c) => c && { ...c, pos }) } : undefined}
                overlay={
                  <>
                    {safe && <SafeZones />}
                    <Sketch
                      tool={tool}
                      pending={pending}
                      shown={shown}
                      onAdd={(a) => {
                        setPending((p) => [...p, a]);
                        composer.current?.focus();
                      }}
                    />
                  </>
                }
              />
            ) : (
              <div className="grid flex-1 place-items-center text-soft">
                {viewRev !== undefined
                  ? `Preparing r${viewing}, ${cut.segments.filter((x) => x === "ready").length} of ${cut.segments.length} seconds rendered`
                  : cut.render.total
                    ? `Rendering the first seconds, ${cut.render.ready} of ${cut.render.total} ready`
                    : "Reading the project"}
              </div>
            )}
          </div>
          <div className="@container flex h-14 shrink-0 items-center gap-1 px-5">
            <IconButton label="Previous frame" keys="," onClick={() => controller.step(-1)}>
              <ChevronLeft />
            </IconButton>
            <IconButton label={playing ? "Pause" : "Play"} keys="Space" active={false} onClick={() => controller.toggle()} className="bg-raised text-text">
              {playing ? <Pause /> : <Play />}
            </IconButton>
            <IconButton label="Next frame" keys="." onClick={() => controller.step(1)}>
              <ChevronRight />
            </IconButton>
            <Clock controller={controller} duration={duration} rate={rate} />
            <div className="flex-1" />
            {loop && (
              <button className="mr-1 min-w-0 truncate rounded-md px-2 py-1 text-[12.5px] text-amber hover:bg-raised" onClick={() => controller.setLoop(undefined)}>
                <span className="@max-[800px]:hidden">Looping </span>
                {tc(loop.in)} to {tc(loop.out)}
              </button>
            )}
            <Menu>
              <MenuTrigger asChild>
                <button className="no-drag rounded-lg px-2.5 py-1.5 font-semibold text-soft hover:bg-raised hover:text-text">{rate}x</button>
              </MenuTrigger>
              <MenuContent>
                {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                  <MenuItem key={r} onSelect={() => controller.setRate(r)}>
                    {r}x
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
            <IconButton
              label={loop ? "Clear loop" : "Loop the cue range"}
              keys="I / O / X"
              active={!!loop}
              onClick={() => controller.setLoop(loop ? undefined : { in: Math.max(0, controller.state.time - 1000), out: Math.min(duration, controller.state.time + 1000) })}
            >
              <Repeat />
            </IconButton>
            <VolumeControl controller={controller} />
            <IconButton label="Phone safe zones" keys="S" active={safe} onClick={() => setSafe(!safe)}>
              <Smartphone />
            </IconButton>
            <IconButton label="Compare revisions" keys="C" active={!!compare} onClick={() => toggleCompare()}>
              <Columns2 />
            </IconButton>
            <IconButton label="Full screen" keys="F" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen())}>
              <Maximize />
            </IconButton>
          </div>
        </div>

        <aside className="flex min-h-0 flex-col bg-panel">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList>
              <Tab value="cues" count={cut.notes.filter((n) => n.status !== "resolved" && n.status !== "wontfix").length}>
                Cues
              </Tab>
              <Tab value="layers">Layers</Tab>
              <Tab value="history" count={cut.revisions.length}>
                History
              </Tab>
            </TabsList>
            <TabsContent value="cues" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden" forceMount>
              <Cues
                ref={composer}
                cut={cut}
                cues={cues}
                selected={selectedNote}
                onSelect={(id) => {
                  setSelectedNote(id);
                  const n = cues.find((x) => x.id === id);
                  if (n && Math.abs(n.displayT - controller.state.time) > 30) {
                    controller.pause();
                    controller.seek(n.displayT);
                  }
                }}
                onSeek={(ms) => {
                  controller.pause();
                  controller.seek(ms);
                }}
                now={time}
                range={loop}
                tool={tool}
                onTool={(t) => {
                  if (t) controller.pause();
                  setTool(t);
                }}
                pending={pending}
                onClearPending={() => setPending([])}
                captureMarked={captureMarked}
                toast={push}
              />
            </TabsContent>
            <TabsContent value="layers" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <Inspector cut={cut} time={time} paused={!playing} selected={selectedItem} onEdit={(r) => void edit(r)} />
            </TabsContent>
            <TabsContent value="history" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <History
                cut={cut}
                viewing={viewRev}
                onView={setViewRev}
                onCompare={(n) => toggleCompare(n)}
                onRevert={(n) => void run(() => api(`/api/cuts/${cut.id}/revert`, { body: { rev: n } }), `Restoring r${n} as a new revision`)}
                onApprove={(n) => void run(() => api(`/api/cuts/${cut.id}/approve`, { body: { rev: n } }), `Approved r${n}`)}
              />
            </TabsContent>
          </Tabs>
          {drafts > 0 && tab !== "cues" && (
            <button className="mx-4 mb-4 rounded-lg bg-raised px-3 py-2 text-left text-soft hover:text-text" onClick={() => setTab("cues")}>
              {drafts} {drafts === 1 ? "draft is" : "drafts are"} waiting to be sent
            </button>
          )}
        </aside>
      </div>

      <Filmstrip
        cut={cut}
        controller={controller}
        cues={cues}
        selectedNote={selectedNote}
        onSelectNote={(id) => {
          const n = cues.find((x) => x.id === id);
          setSelectedNote(id);
          setTab("cues");
          if (n) {
            controller.pause();
            controller.seek(n.displayT);
          }
        }}
        selectedLayer={selectedLayer}
        onSelectLayer={(id) => {
          setSelectedLayer(id);
          if (id !== undefined) setTab("layers");
        }}
        onRetime={(item, start, end) => void edit({ kind: "timing", layerId: item.id, start, end })}
      />

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cn("max-w-xl rounded-xl px-4 py-2.5 shadow-[0_10px_40px_rgba(0,0,0,.5)]", t.tone === "error" ? "bg-[#3a1f1c] text-[#ffd2cc]" : "bg-raised text-text")}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Clock({ controller, duration, rate }: { controller: PlayerController; duration: number; rate: number }) {
  const time = usePlayerSelect(controller, (s) => s.time);
  return (
    <div className="ml-3 flex shrink-0 items-baseline gap-2.5">
      <span className="text-[24px] leading-none font-semibold text-amber">{tc(time)}</span>
      <span className="whitespace-nowrap text-dim">
        frame {frameAt(time)} of {frameOf(duration)}
        {rate !== 1 && `, ${rate}x`}
      </span>
    </div>
  );
}
