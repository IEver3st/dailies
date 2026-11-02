import { useEffect, useState } from "react";
import { Eye, EyeOff, Minus, Plus } from "lucide-react";
import type { ContextLayer, CutDetail, TrackItem } from "@/lib/api";
import { api } from "@/lib/api";
import { cn, dbOf, tc } from "@/lib/format";
import { Button, IconButton } from "./ui/button";
import { Slider } from "./ui/slider";

export type EditRequest =
  | { kind: "text"; layerId: number; text: string }
  | { kind: "volume"; layerId: number; db: number }
  | { kind: "hide"; layerId: number; hidden: boolean }
  | { kind: "timing"; layerId: number; start: number; end: number };

const FRAME = 1000 / 60;

function TextField({ layer, onEdit }: { layer: ContextLayer; onEdit: (e: EditRequest) => void }) {
  const [value, setValue] = useState(layer.text ?? "");
  useEffect(() => setValue(layer.text ?? ""), [layer.text, layer.id]);
  const dirty = value !== (layer.text ?? "");
  return (
    <div className="mt-2 grid gap-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && dirty) {
            e.preventDefault();
            onEdit({ kind: "text", layerId: layer.id, text: value });
          }
          if (e.key === "Escape") setValue(layer.text ?? "");
        }}
        rows={Math.min(4, Math.max(1, Math.ceil(value.length / 34)))}
        className="w-full resize-none rounded-lg bg-ink px-2.5 py-2 outline-none focus:shadow-[inset_0_0_0_1px_var(--color-line)]"
      />
      {dirty && (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setValue(layer.text ?? "")}>
            Revert
          </Button>
          <Button size="sm" variant="primary" onClick={() => onEdit({ kind: "text", layerId: layer.id, text: value })}>
            Change text
          </Button>
        </div>
      )}
    </div>
  );
}

function VolumeField({ layer, onEdit }: { layer: ContextLayer; onEdit: (e: EditRequest) => void }) {
  const current = Math.round(dbOf(layer.volume) * 10) / 10;
  const [db, setDb] = useState(current);
  useEffect(() => setDb(current), [current, layer.id]);
  const dirty = Math.abs(db - current) > 0.05;
  const nudge = (d: number) => setDb((v) => Math.max(-60, Math.min(12, Math.round((v + d) * 10) / 10)));
  return (
    <div className="mt-2 flex items-center gap-2">
      <IconButton label="1 dB quieter" onClick={() => nudge(-1)}>
        <Minus />
      </IconButton>
      <Slider value={Math.max(-40, db)} min={-40} max={12} step={0.5} onChange={setDb} label="Volume in dB" />
      <IconButton label="1 dB louder" onClick={() => nudge(1)}>
        <Plus />
      </IconButton>
      <span className={cn("w-16 text-right", dirty ? "text-amber" : "text-soft")}>{db <= -60 ? "off" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`}</span>
      {dirty && (
        <Button size="sm" variant="primary" onClick={() => onEdit({ kind: "volume", layerId: layer.id, db })}>
          Set
        </Button>
      )}
    </div>
  );
}

function TimingField({ item, onEdit }: { item: TrackItem; onEdit: (e: EditRequest) => void }) {
  const [start, setStart] = useState(item.start);
  const [end, setEnd] = useState(item.end);
  useEffect(() => {
    setStart(item.start);
    setEnd(item.end);
  }, [item.start, item.end, item.id]);
  const dirty = Math.abs(start - item.start) > 0.5 || Math.abs(end - item.end) > 0.5;
  const row = (label: string, v: number, set: (n: number) => void) => (
    <div className="flex items-center gap-1.5">
      <span className="w-12 text-dim">{label}</span>
      <IconButton label="1 frame earlier" onClick={() => set(Math.max(0, v - FRAME))}>
        <Minus />
      </IconButton>
      <span className="w-16 text-center">{tc(v)}</span>
      <IconButton label="1 frame later" onClick={() => set(v + FRAME)}>
        <Plus />
      </IconButton>
    </div>
  );
  return (
    <div className="mt-2 grid gap-1">
      {row("Starts", start, (v) => {
        const len = end - start;
        setStart(v);
        if (item.type === "Group") setEnd(v + len);
      })}
      {row("Ends", end, (v) => setEnd(Math.max(start + FRAME, v)))}
      {dirty && (
        <div className="mt-1 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => (setStart(item.start), setEnd(item.end))}>
            Revert
          </Button>
          <Button size="sm" variant="primary" onClick={() => onEdit({ kind: "timing", layerId: item.id, start: Math.round(start), end: Math.round(end) })}>
            Retime
          </Button>
        </div>
      )}
    </div>
  );
}

export function Inspector({ cut, time, paused, selected, onEdit }: { cut: CutDetail; time: number; paused: boolean; selected?: TrackItem; onEdit: (e: EditRequest) => void }) {
  const [layers, setLayers] = useState<ContextLayer[]>([]);
  const [at, setAt] = useState<number>();
  const rounded = Math.round(time / FRAME);

  useEffect(() => {
    if (!paused) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      void api<{ layers: ContextLayer[] }>(`/api/cuts/${cut.id}/context?t=${Math.round(time)}${cut.rev !== undefined ? `&rev=${cut.rev}` : ""}`, { signal: ctrl.signal })
        .then((r) => {
          setLayers(r.layers);
          setAt(time);
        })
        .catch(() => {});
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [cut.id, cut.rev, rounded, paused, cut.movie?.key]);

  const latest = cut.rev === cut.latest?.n;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {!latest && <div className="mx-3 mt-2 rounded-lg bg-panel px-3 py-2 text-soft">You are viewing r{cut.rev}. Edits always apply to the latest revision.</div>}
      {selected && (
        <section className="mx-1 mt-2 rounded-xl bg-raised px-3 py-3">
          <div className="font-semibold">{selected.name}</div>
          <div className="text-[12.5px] text-dim">
            {selected.type}
            {selected.children ? `, ${selected.children} layers inside` : ""}
          </div>
          {selected.editable.timing ? <TimingField item={selected} onEdit={onEdit} /> : <div className="mt-2 text-[12.5px] text-dim">This layer has no timeline window to retime.</div>}
        </section>
      )}
      <div className="px-3 pt-4 pb-1 text-[12.5px] text-dim">{paused ? `On screen at ${tc(at ?? time)}` : "Pause to edit what is on screen"}</div>
      {paused &&
        layers.map((l) => (
          <section key={l.id} className={cn("mx-1 rounded-xl px-3 py-2.5", l.hidden && "opacity-60")}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{l.name}</div>
                <div className="truncate text-[12px] text-dim">
                  {l.type}
                  {l.path.length ? ` in ${l.path.join(" / ")}` : ""}
                  {l.sourceMs !== undefined ? `, source ${tc(l.sourceMs)}` : ""}
                </div>
              </div>
              <IconButton label={l.hidden ? "Show layer" : "Hide layer"} onClick={() => onEdit({ kind: "hide", layerId: l.id, hidden: !l.hidden })}>
                {l.hidden ? <EyeOff /> : <Eye />}
              </IconButton>
            </div>
            {l.type === "Text" && <TextField layer={l} onEdit={onEdit} />}
            {(l.type === "Audio" || l.type === "Video") && <VolumeField layer={l} onEdit={onEdit} />}
          </section>
        ))}
    </div>
  );
}
