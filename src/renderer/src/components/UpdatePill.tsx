import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { UpdateState } from "../../../preload/api";
import { ago } from "@/lib/format";
import { Tip } from "./ui/button";

export function UpdatePill() {
  const [state, setState] = useState<UpdateState>();

  useEffect(() => {
    void window.dailies?.updateState?.().then(setState);
    return window.dailies?.onUpdate?.(setState);
  }, []);

  if (!state?.enabled || !state.running) return null;
  const { running, ready } = state;

  if (!ready) {
    return (
      <Tip label={`${running.subject} · built ${ago(running.builtAt)}`} side="bottom">
        <span className="no-drag rounded-md px-1.5 py-0.5 font-mono text-[11.5px] text-faint hover:text-dim">{running.short}</span>
      </Tip>
    );
  }

  return (
    <Tip label={`${ready.subject} · ${ready.author}, ${ago(ready.committedAt)}`} side="bottom">
      <button
        onClick={() => void window.dailies?.applyUpdate()}
        className="no-drag group flex h-[26px] items-center gap-2 rounded-full bg-amber/10 pr-1 pl-2.5 text-[12.5px] font-semibold text-amber ring-1 ring-amber/30 transition-colors ring-inset hover:bg-amber/15"
      >
        <i className="size-1.5 animate-pulse rounded-full bg-amber" />
        <span>
          <span className="font-mono">{ready.short}</span> ready
        </span>
        <span className="flex items-center gap-0.5 rounded-full bg-amber px-2 py-0.5 text-[11.5px] text-amber-ink group-hover:brightness-110">
          Restart
          <ArrowUpRight className="size-3" />
        </span>
      </button>
    </Tip>
  );
}
