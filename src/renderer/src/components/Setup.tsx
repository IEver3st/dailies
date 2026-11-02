import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { Check, Copy, UserPlus, X } from "lucide-react";
import { api, onEvent, type AgentClient, type CutSummary, type SetupState } from "@/lib/api";
import { connectPrompt, invitePrompt } from "@/lib/setup-prompt";
import { ago, cn } from "@/lib/format";
import { Button, IconButton } from "./ui/button";

export const CHECK_CLIENT = "dailies-check";

let shown = false;
const watchers = new Set<() => void>();

export function openSetup() {
  shown = true;
  for (const w of watchers) w();
}

function closeSetup() {
  shown = false;
  for (const w of watchers) w();
  void api("/api/settings", { body: { onboarded: true } }).catch(() => {});
}

export function SetupHost() {
  const open = useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => shown,
  );
  useEffect(() => {
    void api<SetupState>("/api/setup")
      .then((s) => !s.onboardedAt && openSetup())
      .catch(() => {});
  }, []);
  return <Setup open={open} onClose={closeSetup} />;
}

export function clientLabel(c: AgentClient) {
  const n = c.name.toLowerCase();
  if (n.includes("claude")) return "Claude Code";
  if (n.includes("codex")) return "Codex";
  if (n.includes("cursor")) return "Cursor";
  if (n.includes("opencode")) return "OpenCode";
  return c.name;
}

const older = (a: string, b: string) => {
  const x = a.split(/[.-]/).map(Number);
  const y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

function listed(parts: string[]) {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

type State = "done" | "current" | "todo" | "agent";

function Step({ n, state, title, detail, action, children }: { n: number; state: State; title: ReactNode; detail?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cn("grid grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-x-3.5 px-6 transition-colors", state === "current" ? "bg-raised py-4" : "py-3")}>
      <span
        className={cn(
          "grid size-[26px] place-items-center rounded-full text-[12px] font-bold",
          state === "done" && "bg-hover text-teal",
          state === "current" && "bg-amber text-amber-ink",
          state === "agent" && "text-amber shadow-[inset_0_0_0_2px_var(--color-amber)]",
          state === "todo" && "text-faint shadow-[inset_0_0_0_2px_var(--color-line)]",
        )}
      >
        {state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0">
        <div className={cn("[overflow-wrap:anywhere]", state === "done" ? "text-soft" : state === "todo" ? "font-semibold text-faint" : "font-semibold")}>{title}</div>
        {detail && <div className={cn("text-[12.5px] leading-snug [overflow-wrap:anywhere]", state === "todo" ? "text-faint" : state === "agent" ? "text-amber" : "text-soft")}>{detail}</div>}
      </div>
      <div>{action}</div>
      {children && <div className="col-start-2 col-end-4 mt-3">{children}</div>}
    </div>
  );
}

function useCopied() {
  const [copied, setCopied] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(undefined), 2200);
  };
  return [copied, copy] as const;
}

function Listening({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5 text-[12.5px] text-amber">
      <span className="size-[13px] animate-spin rounded-full border-2 border-amber border-r-transparent motion-reduce:animate-none" />
      {children}
    </span>
  );
}

function Setup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [s, setS] = useState<SetupState>();
  const [cuts, setCuts] = useState(0);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [copied, copy] = useCopied();
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      Promise.all([api<SetupState>("/api/setup"), api<{ cuts: CutSummary[] }>("/api/state")])
        .then(([next, state]) => {
          if (!alive) return;
          setS(next);
          setCuts(state.cuts.length);
          setError(undefined);
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const off = onEvent((e) => {
      if (e.type === "setup" || e.type === "reconnect" || e.type === "cuts") void load();
    });
    const tick = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      off();
      clearInterval(tick);
    };
  }, [open]);

  const typed = name.replace(/\s+/g, " ").trim();
  const owner = renaming || !s?.owner ? typed || s?.owner : s.owner;

  const saveName = async () => {
    if (!typed || typed === s?.owner) {
      setRenaming(false);
      return true;
    }
    try {
      setS(await api<SetupState>("/api/settings", { body: { owner: typed } }));
      cancelRename();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  function cancelRename() {
    setRenaming(false);
    setName("");
    setSaveFailed(false);
  }

  const close = async () => {
    const editing = renaming || !s?.owner;
    if (!editing || saveFailed || (await saveName())) {
      cancelRename();
      onClose();
    } else setSaveFailed(true);
  };

  const escape = () => {
    if (!renaming) return false;
    cancelRename();
    return true;
  };

  if (!s)
    return (
      <Shell open={open} onClose={close} meta={error ? <span className="text-red">{error}</span> : undefined}>
        <div className="h-[260px]" />
      </Shell>
    );

  const prompts = { ...s, owner };
  const agents = s.clients.filter((c) => c.id !== CHECK_CLIENT);
  const checked = s.clients.find((c) => c.id === CHECK_CLIENT);
  const stale = !!s.tsrct.version && older(s.tsrct.version, s.tsrct.wanted);
  const toolsReady = s.tsrct.found && !stale && s.ffmpeg.found;
  const missing = [!s.tsrct.found && "Tesseract", stale && `Tesseract ${s.tsrct.wanted}`, !s.ffmpeg.found && "ffmpeg"].filter((x): x is string => !!x);
  const named = !!s.owner;
  const connected = agents.length > 0;
  const wanted: State[] = [named ? "done" : "current", toolsReady ? "done" : "agent", connected ? "done" : "current", cuts > 0 ? "done" : "current"];
  const step = wanted.findIndex((x) => x === "current");
  const states = wanted.map((x, i) => (x === "current" && i !== step ? "todo" : x));
  const allSet = states.every((x) => x === "done");

  return (
    <Shell
      open={open}
      onClose={close}
      onEscape={escape}
      meta={error ? <span className="text-red">{error}</span> : allSet ? <span className="text-teal">All set</span> : step >= 0 ? `Step ${step + 1} of 4` : <span className="text-amber">Video tools missing</span>}
    >
      {named && !renaming ? (
        <Step
          n={1}
          state="done"
          title={
            <>
              Agents call you <b className="font-semibold text-text">{s.owner}</b>
            </>
          }
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(s.owner ?? "");
                setRenaming(true);
                requestAnimationFrame(() => nameInput.current?.select());
              }}
            >
              Change
            </Button>
          }
        />
      ) : (
        <Step n={1} state={named ? "done" : "current"} title="What should agents call you?" detail="They use it in notes, messages and their instructions.">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input
              ref={nameInput}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="Your first name"
              className="h-[34px] w-[240px] rounded-lg bg-ink px-3 outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--color-line)]"
            />
            <Button type="submit" variant="primary" disabled={!typed}>
              {renaming ? "Save" : "Continue"}
            </Button>
            {renaming && (
              <Button type="button" variant="ghost" onClick={cancelRename}>
                Cancel
              </Button>
            )}
          </form>
        </Step>
      )}

      <Step
        n={2}
        state={states[1]}
        title={toolsReady ? `${[`Tesseract ${s.tsrct.version ?? ""}`.trim(), `ffmpeg ${s.ffmpeg.version ?? ""}`.trim()].join(" and ")} are ready` : "Video tools"}
        detail={
          toolsReady
            ? undefined
            : `${listed(missing)} ${missing.length > 1 ? "aren't" : "isn't"} installed yet. ${connected ? `Paste the prompt again to install ${missing.length > 1 ? "them" : "it"}.` : `The prompt in the next step installs ${missing.length > 1 ? "them" : "it"}.`}`
        }
        action={
          connected &&
          !toolsReady && (
            <Button size="sm" variant="ghost" onClick={() => void copy("agent", connectPrompt(prompts))}>
              {copied === "agent" ? "Copied" : "Copy prompt"}
            </Button>
          )
        }
      />

      <Step
        n={3}
        state={states[2]}
        title={connected ? `${listed([...new Set(agents.map(clientLabel))])} connected` : "Connect your agent"}
        detail={connected ? `Last seen ${ago(agents[0].lastAt)}` : states[2] === "current" ? "Paste the prompt into Claude Code, Codex or T3 Code." : undefined}
        action={
          connected &&
          toolsReady && (
            <Button size="sm" variant="ghost" onClick={() => void copy("agent", connectPrompt(prompts))}>
              {copied === "agent" ? "Copied" : "Copy prompt"}
            </Button>
          )
        }
      >
        {states[2] === "current" && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button variant="primary" onClick={() => void copy("agent", connectPrompt(prompts))} className="min-w-[128px]">
              {copied === "agent" ? <Check className="size-4" strokeWidth={2.6} /> : <Copy className="size-4" />}
              {copied === "agent" ? "Copied" : "Copy prompt"}
            </Button>
            {!s.mcp.exists ? (
              <span className="text-[12.5px] text-amber">This development build has no agent tools. Install the app first.</span>
            ) : checked ? (
              <Listening>Setup check ran {ago(checked.lastAt)}. Start a new agent session to finish.</Listening>
            ) : (
              <Listening>Listening for your agent</Listening>
            )}
          </div>
        )}
      </Step>

      <Step n={4} state={states[3]} title={cuts > 0 ? "Your cuts are coming in" : "First cut"} detail={cuts > 0 ? undefined : "Your agent opens its first video here."} />

      <footer className="flex items-center justify-between px-6 pt-4">
        <Button variant="ghost" title="A prompt for someone else's Windows PC. They need read access to the Dailies repo." onClick={() => void copy("invite", invitePrompt(s))}>
          {copied === "invite" ? <Check className="size-4" strokeWidth={2.6} /> : <UserPlus className="size-4" />}
          {copied === "invite" ? "Invite prompt copied" : "Invite someone else"}
        </Button>
        <Button variant={allSet ? "primary" : "quiet"} onClick={close}>
          {allSet ? "Done" : "Later"}
        </Button>
      </footer>
    </Shell>
  );
}

function Shell({ open, onClose, onEscape, meta, children }: { open: boolean; onClose: () => void; onEscape?: () => boolean; meta?: ReactNode; children: ReactNode }) {
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="no-drag fixed inset-0 z-40 bg-[#050b0c]/70" />
        <D.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (onEscape?.()) e.preventDefault();
          }}
          onOpenAutoFocus={(e) => {
            if (!(e.currentTarget as HTMLElement).querySelector("input")) e.preventDefault();
          }}
          className="no-drag fixed top-[max(24px,calc(50vh-250px))] left-1/2 z-50 max-h-[calc(100vh-48px)] w-[min(600px,calc(100vw-48px))] -translate-x-1/2 overflow-y-auto rounded-[18px] bg-panel pt-6 pb-[18px] shadow-[0_30px_90px_rgba(0,0,0,.6)] outline-none"
        >
          <header className="flex items-center gap-3 pr-4 pb-3 pl-6">
            <D.Title className="flex-1 text-[19px] font-semibold">Set up Dailies</D.Title>
            {meta && <span className="text-[12.5px] text-dim">{meta}</span>}
            <D.Close asChild>
              <IconButton label="Close" side="left" className="size-7 [&_svg]:size-4">
                <X />
              </IconButton>
            </D.Close>
          </header>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
