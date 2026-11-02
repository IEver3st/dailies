import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { CutDetail, RevisionInfo } from "@/lib/api";
import { ago, cn } from "@/lib/format";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/menu";

function Changed({ rev, seconds }: { rev: RevisionInfo; seconds: number }) {
  const set = new Set(rev.changedSeconds);
  return (
    <div className="mt-2 grid h-1 gap-[2px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, seconds)}, 1fr)` }}>
      {Array.from({ length: seconds }, (_, s) => (
        <i key={s} className={cn("rounded-[1px]", set.has(s) ? "bg-amber" : "bg-line")} />
      ))}
    </div>
  );
}

export function History({
  cut,
  viewing,
  onView,
  onCompare,
  onRevert,
  onApprove,
}: {
  cut: CutDetail;
  viewing?: number;
  onView: (n?: number) => void;
  onCompare: (n: number) => void;
  onRevert: (n: number) => void;
  onApprove: (n: number) => void;
}) {
  const [open, setOpen] = useState<number>();
  const revs = [...cut.revisions].reverse();
  const latest = cut.revisions.at(-1)?.n;
  const seconds = Math.ceil((cut.latest?.durationMs ?? 1000) / 1000);
  const activity = [...cut.activity].reverse().filter((a) => a.kind !== "render").slice(0, 60);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <div className="px-3 pt-3 pb-1 text-[12.5px] text-dim">Revisions</div>
      {revs.map((r) => {
        const isViewing = (viewing ?? latest) === r.n;
        return (
          <div key={r.n} className={cn("mx-1 grid grid-cols-[40px_1fr_auto] gap-x-2 rounded-xl px-3 py-2.5", isViewing ? "bg-raised" : "hover:bg-panel/60")}>
            <button className={cn("text-left text-[19px] leading-tight font-semibold", isViewing ? "text-text" : "text-faint")} onClick={() => onView(r.n === latest ? undefined : r.n)}>
              r{r.n}
            </button>
            <button className="min-w-0 text-left" onClick={() => setOpen(open === r.n ? undefined : r.n)}>
              <div className="flex items-baseline gap-2">
                <span className={cn("font-semibold", r.authorKind === "agent" ? "text-teal" : r.authorKind === "you" ? "text-amber" : "text-text")}>{r.author}</span>
                <span className="text-[12px] text-faint">{ago(r.at)}</span>
                {cut.approvedRev === r.n && <span className="text-[12px] font-semibold text-teal">Approved</span>}
              </div>
              <div className="text-soft">{r.summary}</div>
              {r.n !== cut.revisions[0]?.n && <Changed rev={r} seconds={seconds} />}
              {open === r.n && r.changes.length > 0 && (
                <ul className="mt-2 grid gap-1 text-[12.5px] text-soft">
                  {r.changes.map((c) => (
                    <li key={`${c.kind}${c.id}`}>
                      <span className={c.kind === "added" ? "text-teal" : c.kind === "removed" ? "text-red" : "text-text"}>{c.kind === "added" ? "Added" : c.kind === "removed" ? "Removed" : "Changed"}</span> {c.name}
                      {c.fields?.length ? `: ${c.fields.join(", ")}` : ""}
                      {c.detail ? ` (${c.detail})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </button>
            <Menu>
              <MenuTrigger asChild>
                <button className="grid size-7 place-items-center rounded-md text-dim hover:bg-hover hover:text-text" aria-label={`Actions for r${r.n}`}>
                  <MoreHorizontal className="size-4" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => onView(r.n === latest ? undefined : r.n)}>Watch r{r.n}</MenuItem>
                {r.n !== latest && <MenuItem onSelect={() => onCompare(r.n)}>Compare with r{latest}</MenuItem>}
                <MenuItem onSelect={() => onApprove(r.n)}>Approve r{r.n}</MenuItem>
                {r.n !== latest && (
                  <MenuItem disabled={!r.restorable} onSelect={() => onRevert(r.n)}>
                    {r.restorable ? `Restore r${r.n} as a new revision` : `r${r.n} is no longer kept on disk`}
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
        );
      })}
      <div className="px-3 pt-5 pb-1 text-[12.5px] text-dim">Activity</div>
      {activity.map((a) => (
        <div key={a.id} className="mx-1 grid grid-cols-[1fr_auto] gap-x-3 px-3 py-1.5">
          <div className="min-w-0">
            <span className={cn("mr-1.5 font-semibold", a.author.kind === "agent" ? "text-teal" : a.author.kind === "you" ? "text-amber" : "text-text")}>{a.author.name}</span>
            <span className="text-soft">{a.text.startsWith(a.author.name) ? a.text.slice(a.author.name.length).trim() : a.text}</span>
          </div>
          <span className="text-[12px] text-faint">{ago(a.at)}</span>
        </div>
      ))}
    </div>
  );
}
