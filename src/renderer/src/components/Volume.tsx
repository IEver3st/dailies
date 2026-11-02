import { useEffect, useRef, useState } from "react";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { Slider } from "radix-ui";
import type { PlayerController } from "@/lib/player";
import { usePlayerSelect } from "@/lib/player";
import { IconButton } from "./ui/button";
import { cn } from "@/lib/format";

export function VolumeControl({ controller }: { controller: PlayerController }) {
  const volume = usePlayerSelect(controller, (s) => s.volume);
  const muted = usePlayerSelect(controller, (s) => s.muted);
  const level = muted ? 0 : volume;
  const percent = Math.round(level * 100);
  const Icon = level === 0 ? VolumeX : level < 0.34 ? Volume : level < 0.67 ? Volume1 : Volume2;
  const [flash, setFlash] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [volume, muted]);

  return (
    <div className="group/volume no-drag flex items-center" onWheel={(e) => e.deltaY && controller.nudgeVolume(e.deltaY < 0 ? 0.05 : -0.05)}>
      <IconButton label={muted || volume === 0 ? "Unmute" : "Mute"} keys="M" active={muted || volume === 0} onClick={() => controller.setMuted(!(muted || volume === 0))}>
        <Icon />
      </IconButton>
      <Slider.Root
        value={[percent]}
        max={100}
        step={1}
        onValueChange={([v]) => controller.setVolume(v / 100)}
        onPointerUp={(e) => e.currentTarget.querySelector<HTMLElement>("[role=slider]")?.blur()}
        className="relative ml-1 flex h-8 w-24 cursor-pointer touch-none items-center select-none @max-[800px]:w-16"
        aria-label="Volume"
      >
        <Slider.Track className="relative h-1 grow overflow-hidden rounded-full bg-line">
          <Slider.Range className={cn("absolute h-full rounded-full transition-colors", muted ? "bg-faint" : "bg-soft group-hover/volume:bg-text")} />
        </Slider.Track>
        <Slider.Thumb aria-valuetext={`${percent}%`} className="block size-3 rounded-full bg-text shadow-[0_0_0_3px_var(--color-ink)] outline-none focus-visible:ring-2 focus-visible:ring-amber" />
        <span
          className={cn(
            "pointer-events-none absolute bottom-full mb-0.5 -translate-x-1/2 rounded-md bg-raised px-1.5 py-0.5 text-[11.5px] leading-none font-semibold text-text tabular-nums transition-opacity",
            flash ? "opacity-100" : "opacity-0 group-hover/volume:opacity-100",
          )}
          style={{ left: `calc(${percent}% + ${6 * (1 - percent / 50)}px)` }}
        >
          {percent}%
        </span>
      </Slider.Root>
    </div>
  );
}
