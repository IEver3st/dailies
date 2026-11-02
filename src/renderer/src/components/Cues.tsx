import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { MoreHorizontal, Square, ArrowUpRight, PenLine, MapPin, X, CornerDownRight } from "lucide-react";
import type { Annotation, CutDetail, Note } from "@/lib/api";
import { api, mediaUrl } from "@/lib/api";
import { ago, cn, tc } from "@/lib/format";
import { Button, IconButton } from "./ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import type { Tool } from "./Sketch";
import { preferences } from "@/lib/preferences";

const statusText: Record<Note["status"], string> = {
  draft: "Draft",
  open: "Sent",
  claimed: "Agent is on it",
  addressed: "Addressed",
  resolved: "Resolved",
  wontfix: "Won't fix",
};

function statusTone(n: Note) {
  if (n.kind === "edit" && n.overwrittenIn && n.status !== "resolved" && n.status !== "wontfix") return "text-red";
  if (n.status === "addressed") return "text-teal";
  if (n.status === "claimed") return "text-teal";
  if (n.status === "draft") return "text-dim";
  if (n.status === "resolved" || n.status === "wontfix") return "text-faint";
  return "text-amber";
}

function MarkedFrame({ path }: { path: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    void mediaUrl(path).then(setSrc);
  }, [path]);
  return src ? <img src={src} className="mt-2 h-32 w-auto rounded-md" draggable={false} /> : null;
}

function CueCard({
  cut,
  note,
  index,
  selected,
  onSelect,
  onSeek,
  agentName,
  toast,
}: {
  cut: CutDetail;
  note: Note;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onSeek: (ms: number) => void;
  agentName?: string;
  toast: (msg: string, tone?: "error") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const done = note.status === "resolved" || note.status === "wontfix";

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  useEffect(() => setText(note.text), [note.text]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const patch = (body: Record<string, unknown>) => api(`/api/cuts/${cut.id}/notes/${note.id}`, { method: "PATCH", body });
  const sendReply = (status?: string) =>
    run(async () => {
      if (!replyText.trim() && !status) return;
      await api(`/api/cuts/${cut.id}/notes/${note.id}/reply`, { body: { text: replyText.trim(), status } });
      setReplyText("");
      setReplying(false);
    });

  const edit = note.kind === "edit";
  const queued = edit && note.applied === false;

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={cn("grid grid-cols-[24px_1fr] gap-x-3 gap-y-1.5 rounded-xl px-3 py-3 transition-colors", selected ? "bg-raised" : "hover:bg-panel/60", done && !selected && "opacity-60")}
    >
      <div
        className={cn(
          "mt-px grid size-6 place-items-center rounded-full text-[12px] font-bold",
          note.status === "draft" ? "text-amber shadow-[inset_0_0_0_2px_var(--color-amber)]" : done || note.status === "addressed" ? "bg-hover text-soft" : "bg-amber text-amber-ink",
        )}
      >
        {index + 1}
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <button
          className="font-semibold text-amber hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onSeek(note.displayT);
          }}
        >
          {tc(note.displayT)}
          {note.end !== undefined && note.end > note.t && <span className="font-normal text-dim"> to {tc(note.end + (note.displayT - note.t))}</span>}
        </button>
        {edit && <span className="text-[12.5px] text-soft">Edit</span>}
        <span className={cn("ml-auto shrink-0 text-[12.5px]", statusTone(note))}>
          {edit && note.overwrittenIn && !done ? `Overwritten in r${note.overwrittenIn}` : queued ? `Waiting for ${agentName ?? "the agent"}` : edit && note.status === "open" ? "Applied" : statusText[note.status]}
        </span>
        <Menu onOpenChange={(o) => !o && setArmed(false)}>
          <MenuTrigger asChild>
            <button className="-my-1 grid size-6 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-text" aria-label="Note actions" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent>
            {note.status === "draft" && <MenuItem onSelect={() => setEditing(true)}>Edit text</MenuItem>}
            {edit && queued && <MenuItem onSelect={() => void run(() => api(`/api/cuts/${cut.id}/edits/${note.id}/apply`, { body: {} }), "Edit applied")}>Apply now</MenuItem>}
            {edit && note.overwrittenIn && !done && <MenuItem onSelect={() => void run(() => api(`/api/cuts/${cut.id}/edits/${note.id}/apply`, { body: {} }), "Edit re-applied")}>Re-apply edit</MenuItem>}
            {edit && !queued && note.status !== "wontfix" && <MenuItem onSelect={() => void run(() => api(`/api/cuts/${cut.id}/edits/${note.id}/undo`, { body: {} }), "Edit undone")}>Undo edit</MenuItem>}
            {!done && note.status !== "draft" && <MenuItem onSelect={() => void run(() => patch({ status: "resolved" }))}>Resolve</MenuItem>}
            {(done || note.status === "addressed") && <MenuItem onSelect={() => void run(() => patch({ status: "open" }))}>Reopen</MenuItem>}
            <MenuItem onSelect={() => void navigator.clipboard.writeText(note.id)}>Copy note id</MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onSelect={(e) => {
                if (preferences().confirmDelete && !armed) {
                  e.preventDefault();
                  setArmed(true);
                  return;
                }
                void run(() => api(`/api/cuts/${cut.id}/notes/${note.id}`, { method: "DELETE" }));
              }}
            >
              {armed ? "Click again to delete" : "Delete"}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="col-start-2 min-w-0">
        {editing ? (
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void run(() => patch({ text })).then(() => setEditing(false));
              }
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={() => {
              if (text !== note.text) void run(() => patch({ text }));
              setEditing(false);
            }}
            className="w-full resize-none rounded-lg bg-ink px-2.5 py-2 outline-none"
            rows={Math.min(6, Math.max(2, Math.ceil(text.length / 38)))}
          />
        ) : (
          <div className="break-words whitespace-pre-wrap" onDoubleClick={() => note.status === "draft" && setEditing(true)}>
            {note.text}
          </div>
        )}
        {note.moved && <div className="mt-1 text-[12px] text-dim">Moved with its layer from {tc(note.t)}</div>}
        {note.anchorGone && <div className="mt-1 text-[12px] text-red">The layer this note was on is gone</div>}
        {note.annotatedFrame && (selected || note.status === "draft") && <MarkedFrame path={note.annotatedFrame} />}
        {note.thread.length > 0 && (
          <div className="mt-2 grid gap-1.5">
            {note.thread.map((t) => (
              <div key={t.id} className="flex gap-2 text-soft">
                <CornerDownRight className="mt-[3px] size-3.5 shrink-0 text-faint" />
                <div className="min-w-0">
                  <span className={cn("mr-1.5 font-semibold", t.author.kind === "agent" ? "text-teal" : "text-text")}>{t.author.name}</span>
                  {t.text}
                  <span className="ml-1.5 text-[12px] text-faint">{ago(t.at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {selected && note.status !== "draft" && !replying && (
          <div className="mt-2.5 flex gap-1.5">
            <Button size="sm" variant="quiet" onClick={() => setReplying(true)}>
              Reply
            </Button>
            {note.status === "addressed" && (
              <Button size="sm" variant="quiet" onClick={() => void run(() => patch({ status: "resolved" }))}>
                Looks good
              </Button>
            )}
            {(note.status === "addressed" || done) && (
              <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
                Not yet
              </Button>
            )}
          </div>
        )}
        {replying && (
          <div className="mt-2.5 grid gap-2">
            <textarea
              autoFocus
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendReply(note.status === "addressed" || done ? "open" : undefined);
                }
                if (e.key === "Escape") setReplying(false);
              }}
              placeholder={note.status === "addressed" || done ? "What still needs to change?" : "Reply"}
              className="w-full resize-none rounded-lg bg-ink px-2.5 py-2 outline-none placeholder:text-faint"
              rows={2}
            />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={!replyText.trim()} onClick={() => void sendReply(note.status === "addressed" || done ? "open" : undefined)}>
                {note.status === "addressed" || done ? "Reopen" : "Reply"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export type ComposerHandle = { focus: () => void; send: () => void };

export const Cues = forwardRef<
  ComposerHandle,
  {
    cut: CutDetail;
    cues: Note[];
    selected?: string;
    onSelect: (id: string) => void;
    onSeek: (ms: number) => void;
    now: number;
    range?: { in: number; out: number };
    tool?: Tool;
    onTool: (t?: Tool) => void;
    pending: Annotation[];
    onClearPending: () => void;
    captureMarked: () => string | undefined;
    toast: (msg: string, tone?: "error") => void;
  }
>(function Cues({ cut, cues, selected, onSelect, onSeek, now, range, tool, onTool, pending, onClearPending, captureMarked, toast }, ref) {
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(() => preferences().showResolved);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const drafts = cues.filter((n) => n.status === "draft");
  const done = cues.filter((n) => n.status === "resolved" || n.status === "wontfix");
  const visible = showDone ? cues : cues.filter((n) => !done.includes(n));
  const agentName = cut.collaborators.at(-1)?.agent ?? cut.agent?.name;
  const at = range ? range.in : now;
  const sendCount = drafts.length + (text.trim() || pending.length ? 1 : 0);

  const add = async () => {
    if (!text.trim() && !pending.length) return;
    setBusy(true);
    try {
      const marked = pending.length ? captureMarked() : undefined;
      const n = await api<Note>(`/api/cuts/${cut.id}/notes`, {
        body: { t: Math.round(at), end: range ? Math.round(range.out) : undefined, rev: cut.rev, text: text.trim() || "See the marked frame", annotations: pending, annotatedFrame: marked },
      });
      setText("");
      onClearPending();
      onTool(undefined);
      onSelect(n.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (text.trim() || pending.length) await add();
    try {
      const r = await api<{ published: number; delivered: string[] }>(`/api/cuts/${cut.id}/publish`, { body: {} });
      if (!r.published) return;
      toast(r.delivered.length ? `Sent ${r.published} ${r.published === 1 ? "note" : "notes"} to ${agentName ?? "the agent"}` : `Sent ${r.published} ${r.published === 1 ? "note" : "notes"}. No agent thread is linked, so they wait in dailies_feedback`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), send: () => void send() }));

  const tools: { t: Tool; label: string; keys: string; icon: React.ReactNode }[] = [
    { t: "rect", label: "Box", keys: "R", icon: <Square /> },
    { t: "arrow", label: "Arrow", keys: "A", icon: <ArrowUpRight /> },
    { t: "pen", label: "Draw", keys: "D", icon: <PenLine /> },
    { t: "pin", label: "Pin", keys: "P", icon: <MapPin /> },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {visible.length === 0 && (
          <div className="px-4 pt-8 text-soft">
            <div className="font-semibold text-text">Nothing noted yet</div>
            <p className="mt-1">Pause where something is off, write what to change, and draw on the frame if it helps. Notes stay drafts until you send them.</p>
          </div>
        )}
        {visible.map((n) => (
          <CueCard key={n.id} cut={cut} note={n} index={cues.indexOf(n)} selected={selected === n.id} onSelect={() => onSelect(n.id)} onSeek={onSeek} agentName={agentName} toast={toast} />
        ))}
        {done.length > 0 && (
          <button className="mx-3 mt-1 text-[12.5px] text-dim hover:text-text" onClick={() => setShowDone(!showDone)}>
            {showDone ? "Hide resolved" : `Show ${done.length} resolved`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 px-4 pt-3 pb-4">
        <div className="rounded-xl bg-ink px-3 pt-2.5 pb-2 focus-within:shadow-[inset_0_0_0_1px_var(--color-line)]">
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className="font-semibold text-amber">{range ? `${tc(range.in)} to ${tc(range.out)}` : tc(now)}</span>
            {pending.length > 0 && (
              <span className="flex items-center gap-1 text-soft">
                {pending.length} {pending.length === 1 ? "mark" : "marks"}
                <button aria-label="Clear marks" className="grid size-4 place-items-center rounded text-dim hover:text-text" onClick={onClearPending}>
                  <X className="size-3" />
                </button>
              </span>
            )}
          </div>
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void add();
              } else if (e.key === "Escape") input.current?.blur();
            }}
            placeholder={range ? "Note this range" : "Note this frame"}
            rows={2}
            className="mt-1 w-full resize-none bg-transparent outline-none placeholder:text-faint"
          />
        </div>
        <div className="flex items-center gap-1">
          {tools.map((x) => (
            <IconButton key={x.t} label={x.label} keys={x.keys} active={tool === x.t} onClick={() => onTool(tool === x.t ? undefined : x.t)}>
              {x.icon}
            </IconButton>
          ))}
          <div className="flex-1" />
          <Button variant="quiet" disabled={busy || (!text.trim() && !pending.length)} onClick={() => void add()}>
            Add
          </Button>
          <Button
            variant="primary"
            className="min-w-0 !shrink !gap-1"
            title={sendCount && agentName ? `Send ${sendCount} to ${agentName}` : undefined}
            disabled={!sendCount}
            onClick={() => void send()}
          >
            <span className="shrink-0">{sendCount ? `Send ${sendCount}` : "Send"}</span>
            {sendCount > 0 && agentName && <span className="min-w-0 truncate">to {agentName}</span>}
          </Button>
        </div>
      </div>
    </div>
  );
});
