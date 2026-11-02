import { useEffect, useState } from "react";
import type { UpdateState } from "../../../preload/api";
import { ago } from "@/lib/format";
import { Button, Tip } from "./ui/button";

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
    <div className="flex items-center gap-2.5">
      <Tip label={`${ready.subject} · ${ready.author}, ${ago(ready.committedAt)}`} side="bottom">
        <span className="no-drag text-[12.5px] text-soft">
          <span className="font-mono text-amber">{ready.short}</span> is ready
        </span>
      </Tip>
      <Button size="sm" variant="primary" onClick={() => void window.dailies?.applyUpdate()}>
        Restart
      </Button>
    </div>
  );
}
