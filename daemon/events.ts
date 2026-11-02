export type DailiesEvent =
  | { type: "cuts" }
  | { type: "cut"; cutId: string }
  | { type: "revision"; cutId: string; n: number }
  | { type: "segments"; cutId: string; rev: number; changed: number[] }
  | { type: "render"; cutId: string; rev: number; span: [number, number]; progress: number; state: "rendering" | "done" | "failed"; error?: string }
  | { type: "notes"; cutId: string; noteId?: string }
  | { type: "activity"; cutId: string }
  | { type: "mix"; cutId: string; rev: number }
  | { type: "export"; cutId: string; cut: string; rev: number; state: "queued" | "running" | "done" | "failed" | "cancelled"; progress: number; phase: string; file?: string; bytes?: number; error?: string }
  | { type: "focus"; cutId: string; t?: number; noteId?: string }
  | { type: "agent"; cutId: string; cut: string; name: string; state: string; text: string }
  | { type: "library" }
  | { type: "service" }
  | { type: "setup" };

type Listener = (e: DailiesEvent) => void;
const listeners = new Set<Listener>();

export function emit(e: DailiesEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch {}
  }
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
