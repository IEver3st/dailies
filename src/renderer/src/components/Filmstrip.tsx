import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CutDetail, Note, TrackItem } from "@/lib/api";
import { mediaUrl } from "@/lib/api";
import { usePlayerSelect, type PlayerController } from "@/lib/player";
import { cn, tc } from "@/lib/format";

const LANES: { key: string; label: string; test: (i: TrackItem) => boolean }[] = [
  { key: "text", label: "Captions", test: (i) => i.type !== "Audio" && (/^(caption|title|text|close: app)/i.test(i.name) || (!!i.text && i.type !== "Video")) },
  { key: "picture", label: "Footage", test: (i) => i.type === "Video" || i.type === "Image" || /^(hook|pre-roll|flipbook|b-roll|clip)/i.test(i.name) },
  { key: "graphics", label: "Graphics", test: (i) => i.type !== "Audio" },
  { key: "sfx", label: "Effects", test: (i) => i.type === "Audio" && !/^music/i.test(i.name) && i.end - i.start < 20000 },
  { key: "music", label: "Music", test: (i) => i.type === "Audio" },
];

function laneLayout(items: TrackItem[]) {
  const taken = new Set<number>();
  return LANES.map((lane) => {
    const mine = items.filter((i) => !taken.has(i.id) && lane.test(i)).sort((a, b) => a.start - b.start);
    mine.forEach((i) => taken.add(i.id));
    const rows: TrackItem[][] = [];
    for (const it of mine) {
      const row = rows.find((r) => r[r.length - 1].end <= it.start + 1);
      if (row) row.push(it);
      else rows.push([it]);
    }
    return { ...lane, rows };
  }).filter((l) => l.rows.length);
}

function shortName(n: string) {
  return n.replace(/^(caption|touch|close|review|hook|pre-roll): /i, "").replace(/ \(real app[^)]*\)/i, "");
}

const Thumb = memo(function Thumb({ cutId, s, rev, ready, version }: { cutId: string; s: number; rev?: number; ready: boolean; version: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!ready) return;
    if (rev === undefined) return;
    void mediaUrl(`/api/cuts/${cutId}/thumb?s=${s}&rev=${rev}&v=${version}-t240`).then(setSrc);
  }, [cutId, s, rev, ready, version]);
  return src ? <img src={src} className="absolute inset-0 size-full object-cover" draggable={false} onError={() => setSrc(undefined)} /> : null;
});

export function Filmstrip({
  cut,
  controller,
  cues,
  selectedNote,
  onSelectNote,
  selectedLayer,
  onSelectLayer,
  onRetime,
}: {
  cut: CutDetail;
  controller: PlayerController;
  cues: Note[];
  selectedNote?: string;
  onSelectNote: (id: string) => void;
  selectedLayer?: number;
  onSelectLayer: (id: number | undefined) => void;
  onRetime: (item: TrackItem, start: number, end: number) => void;
}) {
  const loop = usePlayerSelect(controller, (s) => s.loop);
  const rev = cut.revisions.find((r) => r.n === cut.rev);
  const duration = rev?.durationMs ?? cut.latest?.durationMs ?? 1;
  const seconds = cut.segments.length || Math.ceil(duration / 1000);
  const changed = new Set(cut.changedSegments.length === seconds && cut.rev === cut.revisions[0]?.n ? [] : cut.changedSegments);
  const stale = new Set(cut.movie && cut.movie.rev === cut.rev ? cut.movie.stale : []);
  const lanes = useMemo(() => laneLayout(cut.timeline), [cut.timeline]);
  const area = useRef<HTMLDivElement>(null);
  const [areaW, setAreaW] = useState(1200);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaW(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<{ id: number; start: number; end: number }>();
  const [scrubbing, setScrubbing] = useState(false);
  const prevStates = useRef<string[]>([]);
  const [landed, setLanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    const prev = prevStates.current;
    const fresh = new Set<number>();
    cut.segments.forEach((st, i) => {
      if (st === "ready" && prev[i] && prev[i] !== "ready") fresh.add(i);
    });
    prevStates.current = cut.segments;
    if (fresh.size) {
      setLanded(fresh);
      const t = setTimeout(() => setLanded(new Set()), 1000);
      return () => clearTimeout(t);
    }
  }, [cut.segments]);

  const pct = (ms: number) => `${(ms / duration) * 100}%`;
  const msAt = (clientX: number) => {
    const r = area.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const scrub = (e: React.PointerEvent, firstMs?: number) => {
    if (e.button !== 0) return;
    const r = area.current!.getBoundingClientRect();
    if (firstMs === undefined && (e.clientX < r.left - 6 || e.clientX > r.right + 20)) return;
    e.preventDefault();
    const wasPlaying = controller.state.playing;
    controller.pause();
    controller.seek(firstMs ?? msAt(e.clientX));
    setScrubbing(true);
    const move = (ev: PointerEvent) => controller.seek(msAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setScrubbing(false);
      if (wasPlaying) controller.play();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const grab = (e: React.PointerEvent, item: TrackItem, edge: "move" | "start" | "end") => {
    e.stopPropagation();
    if (selectedLayer !== item.id || !item.editable.timing) {
      onSelectLayer(item.id);
      scrub(e, Math.max(item.start, Math.min(item.end - 1, msAt(e.clientX))));
      return;
    }
    const x0 = e.clientX;
    const r = area.current!.getBoundingClientRect();
    const frame = 1000 / 60;
    let cur = { id: item.id, start: item.start, end: item.end };
    const move = (ev: PointerEvent) => {
      const d = Math.round((((ev.clientX - x0) / r.width) * duration) / frame) * frame;
      if (edge === "move") cur = { id: item.id, start: Math.max(0, item.start + d), end: Math.max(0, item.start + d) + (item.end - item.start) };
      else if (edge === "start") cur = { ...cur, start: Math.max(0, Math.min(item.end - frame, item.start + d)) };
      else cur = { ...cur, end: Math.max(item.start + frame, item.end + d) };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(undefined);
      if (Math.abs(cur.start - item.start) >= 1 || Math.abs(cur.end - item.end) >= 1) onRetime(item, Math.round(cur.start), Math.round(cur.end));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cellState = (s: number) => {
    const st = cut.segments[s];
    if (st === "rendering") return "rendering-cell";
    if (st === "queued") return "bg-raised";
    if (st === "failed") return "bg-red/70";
    if (st === "missing") return "bg-transparent";
    if (stale.has(s)) return "bg-faint/50";
    return changed.has(s) ? "bg-amber" : "bg-line";
  };

  const version = `${cut.rev}-${cut.movie?.key ?? ""}`;
  const labelW = 84;

  return (
    <div className="relative grid shrink-0 touch-none select-none bg-well pt-2 pb-3" style={{ gridTemplateColumns: `${labelW}px 1fr 20px` }} onPointerDown={(e) => scrub(e)}>
      <div />
      <div className="relative h-[22px] cursor-ew-resize">
        {Array.from({ length: seconds }, (_, s) => (
          <span key={s} className={cn("absolute top-0.5 text-[12px] font-semibold", changed.has(s) ? "text-amber" : "text-faint")} style={{ left: `calc(${pct(s * 1000)} + 4px)` }}>
            {String(s).padStart(2, "0")}
          </span>
        ))}
      </div>
      <div />

      <div className="flex items-center pl-5 text-[12px] text-dim">Render</div>
      <div className="grid h-2 cursor-ew-resize gap-[3px] py-px" style={{ gridTemplateColumns: `repeat(${seconds}, 1fr)` }}>
        {Array.from({ length: seconds }, (_, s) => (
          <i key={s} className={cn("rounded-[2px]", cellState(s), cut.segments[s] === "missing" && "outline outline-1 -outline-offset-1 outline-line")} />
        ))}
      </div>
      <div />

      <div />
      <div ref={area} className="relative mt-1.5 grid h-[clamp(52px,9vh,104px)] cursor-ew-resize gap-[3px]" style={{ gridTemplateColumns: `repeat(${seconds}, 1fr)` }}>
        {Array.from({ length: seconds }, (_, s) => (
          <div key={s} className={cn("relative overflow-hidden rounded-[3px] bg-panel", landed.has(s) && "landed")}>
            <Thumb cutId={cut.id} s={s} rev={cut.rev} ready={cut.segments[s] === "ready"} version={version} />
            {changed.has(s) && <div className="pointer-events-none absolute inset-0 z-[1] rounded-[3px] shadow-[inset_0_0_0_2px_var(--color-amber)]" />}
          </div>
        ))}
        {loop && <div className="pointer-events-none absolute inset-y-0 bg-amber/10 shadow-[inset_2px_0_0_var(--color-amber),inset_-2px_0_0_var(--color-amber)]" style={{ left: pct(loop.in), width: pct(loop.out - loop.in) }} />}
      </div>
      <div />

      <div className="col-span-3 mt-2 grid" style={{ gridTemplateColumns: `${labelW}px 1fr 20px` }}>
        {lanes.map((lane) => (
          <div key={lane.key} className="contents">
            <div className="flex items-start pt-[3px] pl-5 text-[12px] text-dim">{lane.label}</div>
            <div className="relative mb-[3px] cursor-ew-resize" style={{ height: lane.rows.length * 19 - 3 }}>
              {lane.rows.map((row, ri) =>
                row.map((it) => {
                  const d = drag?.id === it.id ? drag : undefined;
                  const start = d?.start ?? it.start;
                  const end = d?.end ?? it.end;
                  const sel = selectedLayer === it.id;
                  const label = shortName(it.name);
                  const roomy = ((end - start) / duration) * areaW >= 40;
                  return (
                    <div
                      key={it.id}
                      onPointerDown={(e) => grab(e, it, "move")}
                      title={`${it.name}\n${tc(start)} to ${tc(end)}`}
                      className={cn(
                        "absolute flex h-4 items-center overflow-hidden rounded-[4px] px-1.5 text-[11px] leading-none whitespace-nowrap",
                        lane.key === "text" ? "bg-text text-ink" : lane.key === "picture" ? "bg-[#2a4245] text-[#cfe0dd]" : lane.key === "graphics" ? "bg-[#233a3d] text-soft" : "bg-[#1d3134] text-dim",
                        it.hidden && "opacity-40",
                        sel && "shadow-[0_0_0_2px_var(--color-amber)]",
                        sel && it.editable.timing ? "cursor-grab" : "cursor-pointer",
                      )}
                      style={{ left: pct(start), width: pct(end - start), top: ri * 19 }}
                    >
                      {roomy && <span className="truncate leading-[14px]">{label}</span>}
                      {sel && it.editable.timing && (
                        <>
                          <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-amber" onPointerDown={(e) => grab(e, it, "start")} />
                          <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-amber" onPointerDown={(e) => grab(e, it, "end")} />
                        </>
                      )}
                    </div>
                  );
                }),
              )}
            </div>
            <div />
          </div>
        ))}
      </div>

      <div className="pointer-events-none absolute inset-y-1.5" style={{ left: labelW, right: 20 }}>
        <Playhead controller={controller} duration={duration} scrubbing={scrubbing} />
        {cues.map((n, i) => (
          <button
            key={n.id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSelectNote(n.id)}
            className={cn(
              "pointer-events-auto absolute top-[32px] grid size-[18px] -translate-x-1/2 place-items-center rounded-full text-[10.5px] font-bold",
              n.status === "draft" ? "bg-well text-amber shadow-[inset_0_0_0_2px_var(--color-amber)]" : n.status === "resolved" || n.status === "addressed" || n.status === "wontfix" ? "bg-raised text-soft" : "bg-amber text-amber-ink",
              selectedNote === n.id && "ring-2 ring-white",
            )}
            style={{ left: pct(n.displayT) }}
          >
            {i + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

function Playhead({ controller, duration, scrubbing }: { controller: PlayerController; duration: number; scrubbing: boolean }) {
  const time = usePlayerSelect(controller, (s) => s.time);
  const x = (Math.min(duration, time) / duration) * 100;
  return (
    <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35)]" style={{ left: `${x}%` }}>
      <div className="pointer-events-auto absolute -top-1.5 left-1/2 h-[18px] w-[11px] -translate-x-1/2 cursor-ew-resize rounded-[3px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35)]" />
      {scrubbing && (
        <span className={cn("absolute -top-1.5 rounded-[4px] bg-white px-1.5 text-[11.5px] leading-[18px] font-semibold text-ink tabular-nums shadow-[0_0_0_1px_rgba(0,0,0,.35)]", x > 88 ? "right-[9px]" : "left-[9px]")}>{tc(time)}</span>
      )}
    </div>
  );
}
