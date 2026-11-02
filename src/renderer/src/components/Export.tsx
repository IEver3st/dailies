import { useEffect, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { api, type CutDetail, type ExportJob, type ExportRecord } from "@/lib/api";
import { ago, cn, megabytes } from "@/lib/format";
import { Button, Tip } from "./ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";

const WIDTH = "w-[154px]";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function remaining(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s left`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")} left`;
}

function useLiveProgress(job: ExportJob | undefined) {
  const [now, setNow] = useState(Date.now());
  const moving = job?.phase === "rendering" && !!job.rate && !!job.reportedAt;
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [moving]);
  if (!job) return { progress: 0, etaMs: undefined };
  if (!moving || !job.total) return { progress: job.progress, etaMs: job.etaMs };
  const since = Math.max(0, now - job.reportedAt!) / 1000;
  const frames = Math.min(job.completed + job.rate! * since, job.completed + job.rate! * 6, job.total * 0.99);
  const etaMs = job.etaMs !== undefined ? Math.max(1000, job.etaMs - since * 1000) : ((job.total - frames) / job.rate!) * 1000;
  return { progress: Math.max(job.progress, frames / job.total), etaMs };
}

function Running({ cut, job, onCancel }: { cut: CutDetail; job: ExportJob; onCancel: () => void }) {
  const { progress, etaMs } = useLiveProgress(job);
  const pct = Math.floor(progress * 100);
  const label =
    job.phase === "waiting" ? `Queued r${job.rev}` : job.phase === "starting" ? `Starting r${job.rev}` : job.phase === "finishing" ? `Finishing r${job.rev}` : `Exporting r${job.rev}`;
  const tip =
    job.phase === "waiting"
      ? `Waiting for ${job.ahead === 1 ? "another export" : `${job.ahead} other exports`} to finish`
      : job.phase === "starting"
        ? `Loading ${cut.name} r${job.rev} for a 4K60 render`
        : job.phase === "finishing"
          ? "Writing the file"
          : `${job.completed} of ${job.total} frames${etaMs !== undefined ? `, about ${remaining(etaMs)}` : ""}`;
  return (
    <Tip label={tip} side="bottom">
      <div className={cn("no-drag relative flex h-8 shrink-0 items-center overflow-hidden rounded-lg bg-raised", WIDTH)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        {job.phase === "starting" || job.phase === "waiting" ? (
          <div className={cn("absolute inset-0 opacity-25", job.phase === "starting" && "rendering-cell")} />
        ) : (
          <div className="absolute inset-y-0 left-0 bg-amber/25 transition-[width] duration-200 ease-linear" style={{ width: `${Math.max(2, progress * 100)}%` }} />
        )}
        <span className="relative min-w-0 flex-1 truncate pl-3 text-[13.5px] font-semibold">{label}</span>
        {job.phase === "rendering" && <span className="relative pr-1 text-[12.5px] font-semibold text-amber tabular-nums">{pct}%</span>}
        <button
          onClick={onCancel}
          aria-label="Cancel export"
          className="relative mr-1 grid size-6 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-text"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </Tip>
  );
}

function Done({ record, onReveal, onAgain, fresh }: { record: ExportRecord; onReveal: () => void; onAgain: () => void; fresh: boolean }) {
  const detail = `${megabytes(record.bytes)}, ${ago(record.at)}`;
  return (
    <div className={cn("no-drag flex h-8 shrink-0 items-center rounded-lg bg-raised", WIDTH, fresh && "landed")}>
      <Tip label={`${fileName(record.file)}, ${detail}`} side="bottom">
        <button onClick={onReveal} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-lg pl-3 text-left hover:bg-hover">
          <span className="text-[13.5px] font-semibold whitespace-nowrap">r{record.rev} exported</span>
        </button>
      </Tip>
      <span className="h-4 w-px bg-line" />
      <Menu>
        <MenuTrigger asChild>
          <button aria-label="Export options" className="grid h-full w-7 shrink-0 place-items-center rounded-r-lg text-dim hover:bg-hover hover:text-text">
            <ChevronDown className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <div className="px-2.5 pt-1.5 pb-1 text-[12.5px] text-dim">
            {fileName(record.file)}
            <br />
            {record.width && record.height ? `${record.width}x${record.height}, ` : ""}
            {detail}
          </div>
          <MenuSeparator />
          <MenuItem onSelect={onReveal}>Show in Explorer</MenuItem>
          <MenuItem onSelect={() => void navigator.clipboard.writeText(record.file)}>Copy file path</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={onAgain}>Export r{record.rev} again</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

export function ExportControl({ cut, viewing, toast }: { cut: CutDetail; viewing: number | undefined; toast: (text: string, tone?: "error") => void }) {
  const state = cut.export;
  const [fresh, setFresh] = useState<string>();
  const [starting, setStarting] = useState(false);
  const lastDone = state?.history.find((r) => r.rev === viewing && r.exists);
  useEffect(() => {
    if (!lastDone || Date.now() - Date.parse(lastDone.at) > 4000) return;
    setFresh(lastDone.id);
    const t = setTimeout(() => setFresh(undefined), 1200);
    return () => clearTimeout(t);
  }, [lastDone?.id]);
  if (!state || viewing === undefined) return null;

  const start = async () => {
    setStarting(true);
    try {
      await api(`/api/cuts/${cut.id}/export`, { body: { rev: viewing } });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setStarting(false);
    }
  };
  const cancel = async () => {
    try {
      await api(`/api/cuts/${cut.id}/export/cancel`, { body: {} });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const reveal = (file: string) => {
    if (window.dailies) void window.dailies.reveal(file);
    else void navigator.clipboard.writeText(file).then(() => toast("Copied the file path"));
  };

  if (state.job) return <Running cut={cut} job={state.job} onCancel={() => void cancel()} />;
  if (lastDone) return <Done record={lastDone} fresh={fresh === lastDone.id} onReveal={() => reveal(lastDone.file)} onAgain={() => void start()} />;

  const rev = cut.revisions.find((r) => r.n === viewing);
  const blocked = !state.ready.ok ? state.ready.reason : rev && rev.exportable === false ? `r${viewing} is no longer kept on disk, so it cannot be exported` : undefined;
  const failed = state.failure?.rev === viewing ? state.failure : undefined;
  const deleted = state.history.find((r) => r.rev === viewing && !r.exists);
  const tip = blocked ?? (failed ? `Last try failed: ${failed.error}` : deleted ? `The last export of r${viewing} was moved or deleted. Render it again at 3840x2160, 60 fps.` : `Render r${viewing} at 3840x2160, 60 fps, into the project folder`);
  return (
    <Tip label={tip} side="bottom">
      <span className={cn("no-drag inline-flex shrink-0", WIDTH)}>
        <Button variant={failed && !blocked ? "danger" : "quiet"} disabled={!!blocked || starting} onClick={() => void start()} className="w-full">
          {failed ? "Retry export" : "Export 4K60"}
        </Button>
      </span>
    </Tip>
  );
}
