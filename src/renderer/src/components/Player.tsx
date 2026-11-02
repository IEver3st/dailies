import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PlayerController } from "@/lib/player";
import { usePlayerSelect } from "@/lib/player";
import { cn } from "@/lib/format";

export type CompareMode = "wipe" | "side" | "diff";

function once(el: HTMLElement, event: string, timeoutMs = 8000) {
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      el.removeEventListener(event, on);
      clearTimeout(timer);
      resolve(ok);
    };
    const on = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    el.addEventListener(event, on);
  });
}

function nextFrameAt(v: HTMLVideoElement, target: number) {
  return new Promise<void>((resolve) => {
    const until = performance.now() + 1500;
    const tick = () => {
      if (v.paused || v.currentTime >= target || performance.now() > until) resolve();
      else v.requestVideoFrameCallback(tick);
    };
    tick();
  });
}

function useFit(aspect: number, count: number, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, cw: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const availW = (r.width - gap * (count - 1)) / count;
      const availH = r.height;
      let h = availH;
      let w = h * aspect;
      if (w > availW) {
        w = availW;
        h = w / aspect;
      }
      setSize({ w: Math.floor(w), h: Math.floor(h), cw: r.width });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, count, gap]);
  return { ref, size };
}

export function Player({
  src,
  controller,
  aspect,
  overlay,
  compare,
  revLabel,
  onGutter,
}: {
  src?: string;
  controller: PlayerController;
  aspect: number;
  overlay?: ReactNode;
  compare?: { src?: string; label: string; mode: CompareMode; pos: number; onPos: (p: number) => void };
  revLabel: string;
  onGutter?: (px: number) => void;
}) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const cmp = useRef<HTMLVideoElement>(null);
  const front = useRef<0 | 1>(0);
  const [frontIdx, setFrontIdx] = useState<0 | 1>(0);
  const loaded = useRef<string | undefined>(undefined);
  const playing = usePlayerSelect(controller, (s) => s.playing);
  const side = compare?.mode === "side";
  const { ref: stageRef, size } = useFit(aspect, side ? 2 : 1, 12);
  useEffect(() => {
    if (size.cw) onGutter?.((size.cw - size.w * (side ? 2 : 1) - (side ? 12 : 0)) / 2);
  }, [size, side, onGutter]);

  useEffect(() => {
    if (!src || src === loaded.current) return;
    const vids = [a.current!, b.current!];
    const cur = vids[front.current];
    const next = vids[1 - front.current];
    if (!loaded.current) {
      loaded.current = src;
      cur.src = src;
      controller.attach(cur);
      void once(cur, "loadedmetadata").then(() => {
        if (controller.state.time > 0) cur.currentTime = Math.min(controller.state.time / 1000, cur.duration - 0.001);
      });
      return;
    }
    loaded.current = src;
    let cancelled = false;
    (async () => {
      next.muted = true;
      next.src = src;
      if (!(await once(next, "loadedmetadata")) || cancelled) return;
      const wasPlaying = !cur.paused;
      const lead = wasPlaying ? 0.3 * cur.playbackRate : 0;
      const target = Math.min(cur.currentTime + lead, next.duration - 0.001);
      next.currentTime = target;
      if (!(await once(next, "seeked")) || cancelled) return;
      if (wasPlaying) {
        await nextFrameAt(cur, target);
        if (cancelled) return;
        next.playbackRate = cur.playbackRate;
        await next.play().catch(() => {});
      } else if (Math.abs(next.currentTime - cur.currentTime) > 0.001) {
        next.currentTime = cur.currentTime;
        await once(next, "seeked", 2000);
      }
      if (cancelled) return;
      controller.applyAudio(next);
      front.current = (1 - front.current) as 0 | 1;
      setFrontIdx(front.current);
      controller.attach(next);
      cur.muted = true;
      cur.pause();
      setTimeout(() => {
        if (vids[front.current] !== cur) {
          cur.removeAttribute("src");
          cur.load();
        }
      }, 400);
    })();
    return () => {
      cancelled = true;
    };
  }, [src, controller]);

  useEffect(() => {
    const c = cmp.current!;
    if (compare?.src) {
      if (c.src !== compare.src) {
        c.src = compare.src;
        c.muted = true;
        void once(c, "loadedmetadata").then(() => controller.syncCompare(true));
      }
      controller.compare = c;
    } else {
      controller.compare = undefined;
      c.removeAttribute("src");
      c.load();
    }
  }, [compare?.src, side, controller]);

  const dragWipe = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!compare) return;
    const box = e.currentTarget.getBoundingClientRect();
    const move = (ev: PointerEvent) => compare.onPos(Math.max(0, Math.min(100, ((ev.clientX - box.left) / box.width) * 100)));
    move(e.nativeEvent);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const showCompare = !!compare?.src && (compare.mode !== "diff" || !playing);
  const videoClass = "absolute inset-0 size-full object-contain";

  return (
    <div ref={stageRef} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center gap-3">
      {side && (
        <div className="relative shrink-0 overflow-hidden rounded-md bg-black" style={{ width: size.w, height: size.h }}>
          <video ref={cmp} className={videoClass} playsInline preload="auto" />
          <Tag side="left">{compare!.label}</Tag>
        </div>
      )}
      <div className="relative shrink-0 overflow-hidden rounded-md bg-black" style={{ width: size.w, height: size.h }}>
        <video ref={a} className={cn(videoClass, frontIdx === 0 ? "z-[1]" : "z-0 opacity-0")} playsInline preload="auto" />
        <video ref={b} className={cn(videoClass, frontIdx === 1 ? "z-[1]" : "z-0 opacity-0")} playsInline preload="auto" />
        {!side && (
          <video
            ref={cmp}
            className={cn(videoClass, "z-[2]", !showCompare && "opacity-0")}
            style={compare?.mode === "wipe" ? { clipPath: `inset(0 ${100 - compare.pos}% 0 0)` } : compare?.mode === "diff" ? { mixBlendMode: "difference" } : undefined}
            playsInline
            preload="auto"
          />
        )}
        <div className="absolute inset-0 z-[3]">{overlay}</div>
        {compare?.src && compare.mode === "wipe" && (
          <div className="absolute inset-0 z-[4] cursor-ew-resize" onPointerDown={dragWipe}>
            <div className="absolute inset-y-0 w-0.5 bg-amber shadow-[0_0_0_1px_rgba(0,0,0,.4)]" style={{ left: `${compare.pos}%` }}>
              <div className="absolute top-1/2 left-1/2 grid size-7 -translate-1/2 place-items-center rounded-full bg-amber text-[11px] font-bold text-amber-ink">{"<>"}</div>
            </div>
            <Tag side="left">{compare.label}</Tag>
            <Tag side="right">{revLabel}</Tag>
          </div>
        )}
        {compare?.src && compare.mode === "diff" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[4] text-center text-[12.5px] text-soft">
            {playing ? "Difference shows while paused" : `Difference between ${compare.label} and ${revLabel}: black means unchanged`}
          </div>
        )}
        {side && <Tag side="left">{revLabel}</Tag>}
      </div>
    </div>
  );
}

function Tag({ side, children }: { side: "left" | "right"; children: ReactNode }) {
  return <div className={cn("pointer-events-none absolute top-2.5 z-[5] rounded-md bg-ink/85 px-2 py-0.5 text-[12px] font-semibold", side === "left" ? "left-2.5" : "right-2.5")}>{children}</div>;
}
