import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import {
  Bot,
  Check,
  Copy,
  Cpu,
  Folder,
  FolderOpen,
  FolderTree,
  HardDrive,
  Info,
  Keyboard,
  MonitorPlay,
  Palette,
  Plug,
  RotateCcw,
  Search,
  SlidersHorizontal,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import type { UpdateState } from "../../../preload/api";
import { api, onEvent, type SetupState } from "@/lib/api";
import { connectPrompt, invitePrompt } from "@/lib/setup-prompt";
import { ago, cn, plural } from "@/lib/format";
import { DEFAULT_PREFERENCES, resetPreferences, setPreferences, setStartWithWindows, useSettingsSnapshot, type Preferences } from "@/lib/preferences";
import { Button, IconButton } from "./ui/button";
import { Select } from "./ui/select";
import { Switch } from "./ui/switch";
import { Mark } from "./Mark";
import { CHECK_CLIENT, clientLabel, openSetup } from "./Setup";
import { ACCENTS, THEMES, SYSTEM_THEMES, resolveAccent, resolveTheme, type AccentChoice, type ThemeChoice, type ThemeId } from "../../../shared/themes";
import { useActiveAccent, useActiveTheme, useSystemDark } from "@/lib/theme";

export type SettingsPage = "general" | "appearance" | "review" | "keyboard" | "agents" | "folders" | "rendering" | "storage" | "about";

const PAGES: SettingsPage[] = ["general", "appearance", "review", "keyboard", "agents", "folders", "rendering", "storage", "about"];
const linked = new URL(location.href).searchParams.get("settings");
let shown: { open: boolean; page: SettingsPage } = {
  open: linked !== null,
  page: PAGES.includes(linked as SettingsPage) ? (linked as SettingsPage) : "general",
};
const watchers = new Set<() => void>();

export function openSettings(page?: string) {
  shown = {
    open: true,
    page: PAGES.includes(page as SettingsPage) ? (page as SettingsPage) : shown.page,
  };
  for (const w of watchers) w();
}

function closeSettings() {
  shown = { ...shown, open: false };
  for (const w of watchers) w();
}

function useShown() {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => shown,
  );
}

type ServiceSettings = { cacheGb: number; renderSlots: number };
type ServiceState = {
  settings: ServiceSettings;
  defaults: ServiceSettings;
  choices: { cacheGb: number[]; renderSlots: number[] };
  roots: { path: string; exists: boolean; projects: number }[];
  cache: {
    dir: string;
    total: number;
    kinds: { id: string; label: string; bytes: number; files: number }[];
  };
  render: {
    resolution: string;
    fps: number;
    segmentMs: number;
    encoder: string;
    cli: string;
  };
  version: string;
  startedAt: string;
  trimmed?: { before: number; after: number; removed: number };
};

function useService(active: boolean) {
  const [state, setState] = useState<ServiceState>();
  const [error, setError] = useState<string>();
  const load = useCallback(
    () =>
      api<ServiceState>("/api/service")
        .then((s) => (setState(s), setError(undefined)))
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => {
    if (!active) return;
    void load();
    const off = onEvent((e) => {
      if (e.type === "service" || e.type === "library") void load();
    });
    return () => void off();
  }, [active, load]);
  const call = useCallback(async (path: string, body: unknown) => {
    try {
      const s = await api<ServiceState>(`/api/service${path}`, { body });
      setState(s);
      setError(undefined);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }, []);
  return { state, error, call };
}

function useUpdates(active: boolean) {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    if (!active) return;
    void window.dailies?.updateState?.().then(setState);
    return window.dailies?.onUpdate?.(setState);
  }, [active]);
  return state;
}

function useSetupState(active: boolean) {
  const [state, setState] = useState<SetupState>();
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () =>
      api<SetupState>("/api/setup")
        .then((s) => alive && setState(s))
        .catch(() => alive && setState(undefined));
    void load();
    const off = onEvent((e) => {
      if (e.type === "setup" || e.type === "reconnect") void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [active]);
  const saveOwner = useCallback(async (name: string) => {
    setState(await api<SetupState>("/api/settings", { body: { owner: name } }));
  }, []);
  return { state, saveOwner };
}

function CopyButton({ text, label, icon: Icon }: { text: () => string; label: string; icon: LucideIcon }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      className="min-w-[124px]"
      onClick={async () => {
        await navigator.clipboard.writeText(text());
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2200);
      }}
    >
      {copied ? <Check className="size-4" strokeWidth={2.6} /> : <Icon className="size-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function ConnectedAgents({ s }: { s: SetupState }) {
  const agents = s.clients.filter((c) => c.id !== CHECK_CLIENT);
  if (!agents.length)
    return (
      <div className="flex items-center gap-4 py-1.5">
        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-raised text-dim">
          <Bot className="size-5" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">No agents connected yet</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-dim">Connect Claude Code, Codex or T3 Code. The agent installs the Dailies tools and shows up here.</div>
        </div>
        <Button variant="primary" onClick={() => openSetup()}>
          <Plug className="size-4" />
          Connect an agent
        </Button>
      </div>
    );
  return (
    <div className="-my-1 grid">
      {agents.map((c) => {
        const live = Date.now() - Date.parse(c.lastAt) < 10 * 60_000;
        return (
          <div key={c.id} className="flex items-center gap-3 py-2">
            <div className="relative grid size-8 shrink-0 place-items-center rounded-full bg-raised text-soft">
              <Bot className="size-4" strokeWidth={1.9} />
              <i className={cn("absolute -right-px -bottom-px size-2.5 rounded-full shadow-[0_0_0_2px_var(--color-panel)]", live ? "bg-teal" : "bg-faint")} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium [overflow-wrap:anywhere]">
                {clientLabel(c)}
                {c.version && <span className="ml-2 text-[12.5px] font-normal text-dim">{c.version}</span>}
                {c.t3 && <span className="ml-2 rounded bg-raised px-1.5 py-px text-[11.5px] font-medium text-soft">via T3 Code</span>}
              </div>
              <div className="text-[12.5px] text-dim">
                {live ? "Active now" : `Last seen ${ago(c.lastAt)}`}, connected {ago(c.firstAt)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function bytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function encoderName(e: string) {
  if (e === "h264_amf") return "AMD hardware";
  if (e === "h264_nvenc") return "NVIDIA hardware";
  if (e === "h264_qsv") return "Intel hardware";
  if (e === "libx264") return "Software";
  return e || "Detecting";
}

type Entry = {
  id: string;
  page: SettingsPage;
  section: string;
  title: string;
  description?: ReactNode;
  keywords?: string;
  control?: ReactNode;
  block?: ReactNode;
  keys?: string[][];
  prefs?: (keyof Preferences)[];
  service?: (keyof ServiceSettings)[];
};

const NAV: {
  label?: string;
  items: { id: SettingsPage; title: string; icon: LucideIcon }[];
}[] = [
  {
    items: [
      { id: "general", title: "General", icon: SlidersHorizontal },
      { id: "appearance", title: "Appearance", icon: Palette },
      { id: "review", title: "Review", icon: MonitorPlay },
      { id: "keyboard", title: "Keyboard", icon: Keyboard },
      { id: "agents", title: "Agents", icon: Bot },
    ],
  },
  {
    label: "Library",
    items: [{ id: "folders", title: "Project folders", icon: FolderTree }],
  },
  {
    label: "Render service",
    items: [
      { id: "rendering", title: "Rendering", icon: Cpu },
      { id: "storage", title: "Storage", icon: HardDrive },
    ],
  },
  { items: [{ id: "about", title: "About", icon: Info }] },
];

const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.title]))) as Record<SettingsPage, string>;

const ALERTS = [
  { value: "sound", label: "With sound" },
  { value: "silent", label: "Silent" },
  { value: "off", label: "Off" },
] as const;

const SHORTCUTS: { section: string; title: string; keys: string[][] }[] = [
  { section: "Playback", title: "Play or pause", keys: [["Space"], ["K"]] },
  { section: "Playback", title: "Back half a second", keys: [["J"]] },
  {
    section: "Playback",
    title: "Play faster, press again to speed up",
    keys: [["L"]],
  },
  {
    section: "Playback",
    title: "Previous or next frame",
    keys: [["←"], ["→"], [","], ["."]],
  },
  {
    section: "Playback",
    title: "Back or forward one second",
    keys: [
      ["Shift", "←"],
      ["Shift", "→"],
    ],
  },
  {
    section: "Playback",
    title: "Jump to start or end",
    keys: [["Home"], ["End"]],
  },
  { section: "Playback", title: "Volume up or down", keys: [["↑"], ["↓"]] },
  { section: "Playback", title: "Mute", keys: [["M"]] },
  { section: "Loop", title: "Set loop in", keys: [["I"]] },
  { section: "Loop", title: "Set loop out", keys: [["O"]] },
  { section: "Loop", title: "Clear loop", keys: [["X"]] },
  { section: "Draw on the frame", title: "Box", keys: [["R"]] },
  { section: "Draw on the frame", title: "Arrow", keys: [["A"]] },
  { section: "Draw on the frame", title: "Freehand", keys: [["D"]] },
  { section: "Draw on the frame", title: "Pin", keys: [["P"]] },
  {
    section: "Draw on the frame",
    title: "Cancel the tool, then the drawing",
    keys: [["Esc"]],
  },
  {
    section: "Notes",
    title: "Write a note at the playhead",
    keys: [["N"], ["Enter"]],
  },
  {
    section: "Notes",
    title: "Send notes to the agent",
    keys: [["Ctrl", "Enter"]],
  },
  { section: "Notes", title: "Previous or next note", keys: [["["], ["]"]] },
  { section: "View", title: "Phone safe zones", keys: [["S"]] },
  { section: "View", title: "Compare with an earlier revision", keys: [["C"]] },
  { section: "View", title: "Full screen", keys: [["F"]] },
  {
    section: "Anywhere",
    title: "Search projects",
    keys: [["Ctrl", "F"], ["/"]],
  },
  { section: "Anywhere", title: "Settings", keys: [["Ctrl", ","]] },
  {
    section: "Home screen",
    title: "Show or hide the agents panel",
    keys: [["Ctrl", "B"]],
  },
];

function Keys({ keys }: { keys: string[][] }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {keys.map((combo, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="mr-0.5 text-[12px] text-faint">or</span>}
          {combo.map((k) => (
            <kbd key={k} className="inline-grid h-6 min-w-6 place-items-center rounded-md bg-raised px-1.5 font-sans text-[12px] font-semibold text-soft">
              {k}
            </kbd>
          ))}
        </span>
      ))}
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-right text-[13px] font-medium text-soft">{children}</span>;
}

function NameField({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  useEffect(() => setText(value), [value]);
  const commit = async () => {
    if (text.trim() === value) return;
    setState("saving");
    try {
      await onSave(text.trim());
      setState("saved");
      setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {state === "saved" && <span className="text-[12.5px] text-teal">Saved</span>}
      {state === "failed" && <span className="text-[12.5px] text-red">Not saved</span>}
      <input
        value={text}
        maxLength={40}
        placeholder="Your name"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape" && text !== value) {
            e.stopPropagation();
            e.preventDefault();
            setText(value);
          }
        }}
        className="h-8 w-56 rounded-lg bg-raised px-3 text-[13px] font-medium text-text outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-amber/70"
      />
    </div>
  );
}

function CacheMeter({ s }: { s: ServiceState }) {
  const limit = s.settings.cacheGb * 1e9;
  const tones = ["bg-amber", "bg-teal", "bg-soft", "bg-dim"];
  const over = s.cache.total > limit;
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[22px] leading-none font-semibold">{bytes(s.cache.total)}</span>
          <span className="text-dim">of {s.settings.cacheGb} GB</span>
        </div>
        {over && <span className="text-[12.5px] text-amber">Over the limit, trims within the hour</span>}
      </div>
      <div className="mt-3 flex h-2 gap-[2px] overflow-hidden rounded-full bg-line">
        {s.cache.kinds.map((k, i) =>
          k.bytes > 0 ? (
            <i
              key={k.id}
              className={cn("h-full min-w-[3px]", tones[i])}
              style={{
                width: `${Math.min(100, (k.bytes / Math.max(limit, s.cache.total)) * 100)}%`,
              }}
            />
          ) : null,
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
        {s.cache.kinds.map((k, i) => (
          <div key={k.id} className="flex items-center gap-2 text-[12.5px]">
            <i className={cn("size-2 shrink-0 rounded-full", tones[i])} />
            <span className="text-soft">{k.label}</span>
            <span className="ml-auto text-dim tabular-nums">{bytes(k.bytes)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Folders({ s, onRemove }: { s: ServiceState; onRemove: (path: string) => void }) {
  if (!s.roots.length) return <p className="py-1 text-soft">No folders yet. Projects only show up when an agent opens them or you open one yourself.</p>;
  return (
    <div className="-my-1 grid">
      {s.roots.map((r) => (
        <div key={r.path} className="group flex items-center gap-3 py-2">
          <Folder className={cn("size-[17px] shrink-0", r.exists ? "text-amber" : "text-faint")} strokeWidth={1.8} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium [overflow-wrap:anywhere]">{r.path}</div>
            <div className={cn("text-[12.5px]", r.exists ? "text-dim" : "text-red")}>{r.exists ? plural(r.projects, "project") : "Folder is missing"}</div>
          </div>
          {r.exists && (
            <IconButton label="Show in Explorer" onClick={() => void window.dailies?.openFolder?.(r.path)}>
              <FolderOpen />
            </IconButton>
          )}
          <IconButton label="Stop watching this folder" onClick={() => onRemove(r.path)}>
            <X />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

function SettingsBody({ page, setPage, escape }: { page: SettingsPage; setPage: (p: SettingsPage) => void; escape: MutableRefObject<() => boolean> }) {
  const snap = useSettingsSnapshot();
  const p = snap.preferences;
  const service = useService(true);
  const updates = useUpdates(true);
  const setup = useSetupState(true);
  const agentsSetup = setup.state;
  const [q, setQ] = useState("");
  const [freed, setFreed] = useState<string>();
  const [freeing, setFreeing] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const s = service.state;
  const set = (patch: Partial<Preferences>) => void setPreferences(patch);
  const toggle = (key: keyof Preferences, label: string) => <Switch label={label} checked={p[key] as boolean} onChange={(v) => set({ [key]: v })} />;

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [page, q]);
  escape.current = () => {
    if (!q) return false;
    setQ("");
    return true;
  };

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    const add = (e: Entry) => list.push(e);

    if (agentsSetup)
      add({
        id: "owner",
        page: "general",
        section: "You",
        title: "Your name",
        description: "Agents see it on your notes, edits and approvals.",
        keywords: "owner profile name",
        control: <NameField value={agentsSetup.owner ?? ""} onSave={setup.saveOwner} />,
      });
    add({
      id: "theme",
      page: "appearance",
      section: "Theme",
      title: "Theme",
      keywords: `color colour scheme palette dark light mode appearance system windows ${THEMES.map((t) => t.name).join(" ")}`,
      prefs: ["theme"],
      block: <ThemePicker value={p.theme} onChange={(theme) => set({ theme })} />,
    });
    add({
      id: "accent",
      page: "appearance",
      section: "Theme",
      title: "Accent",
      description: "The highlight color on buttons, notes, the playhead and your drawings.",
      keywords: `accent highlight color colour pastel yellow amber ${ACCENTS.map((a) => a.name).join(" ")}`,
      prefs: ["accent"],
      control: <AccentPicker value={p.accent} onChange={(accent) => set({ accent })} />,
    });
    add({
      id: "revisionAlerts",
      page: "general",
      section: "Notifications",
      title: "New revisions",
      description: "When an agent publishes a revision of a cut.",
      keywords: "notify alert sound publish",
      prefs: ["revisionAlerts"],
      control: <Select label="New revision notifications" value={p.revisionAlerts} options={[...ALERTS]} onChange={(v) => set({ revisionAlerts: v })} />,
    });
    add({
      id: "blockedAlerts",
      page: "general",
      section: "Notifications",
      title: "Agent needs you",
      description: "When an agent reports it is blocked and waiting on you.",
      keywords: "notify alert sound blocked",
      prefs: ["blockedAlerts"],
      control: <Select label="Agent needs you notifications" value={p.blockedAlerts} options={[...ALERTS]} onChange={(v) => set({ blockedAlerts: v })} />,
    });
    add({
      id: "alertWhenFocused",
      page: "general",
      section: "Notifications",
      title: "Notify while focused",
      description: "Otherwise notifications only appear while Dailies is in the background.",
      keywords: "notify alert foreground",
      prefs: ["alertWhenFocused"],
      control: toggle("alertWhenFocused", "Notify while focused"),
    });
    if (agentsSetup) {
      add({
        id: "connected",
        page: "agents",
        section: "Connected",
        title: "Connected agents",
        keywords: "connect agent claude codex t3 mcp clients",
        block: <ConnectedAgents s={agentsSetup} />,
      });
      if (agentsSetup.clients.some((c) => c.id !== CHECK_CLIENT))
        add({
          id: "connect",
          page: "agents",
          section: "Connect",
          title: "Connect another agent",
          description: "Guided setup: your name, Tesseract and ffmpeg, and the agent connection.",
          keywords: "connect agent setup onboarding wizard mcp install",
          control: (
            <Button onClick={() => openSetup()}>
              <Plug className="size-4" />
              Open setup
            </Button>
          ),
        });
      add({
        id: "connectPrompt",
        page: "agents",
        section: "Connect",
        title: "Connect prompt",
        description: agentsSetup.mcp.exists ? "Paste it into Claude Code, Codex or T3 Code to register the Dailies tools." : "This development build has no agent tools. Install the app first.",
        keywords: "connect agent prompt copy mcp claude codex",
        control: <CopyButton text={() => connectPrompt(agentsSetup)} label="Copy prompt" icon={Copy} />,
      });
      add({
        id: "invite",
        page: "agents",
        section: "Connect",
        title: "Invite someone else",
        description: "A prompt for someone else's Windows PC. They need read access to the Dailies repo.",
        keywords: "invite share collaborator friend",
        control: <CopyButton text={() => invitePrompt(agentsSetup)} label="Copy invite" icon={UserPlus} />,
      });
    }
    add({
      id: "agentsPanel",
      page: "agents",
      section: "Home screen",
      title: "Agents panel",
      description: "Show agents and recent activity beside your projects. Ctrl B toggles it.",
      keywords: "rail sidebar activity feed panel collapse",
      prefs: ["agentsPanel"],
      control: toggle("agentsPanel", "Agents panel"),
    });
    add({
      id: "followAgents",
      page: "agents",
      section: "Behavior",
      title: "Follow agents",
      description: "Jump to a cut when an agent opens it for review with dailies_open.",
      keywords: "focus navigate open",
      prefs: ["followAgents"],
      control: toggle("followAgents", "Follow agents"),
    });
    add({
      id: "startWithWindows",
      page: "general",
      section: "Window",
      title: "Start with Windows",
      description: snap.installed ? "Open into the tray when you sign in, so renders are ready before you look." : "Available in the installed app.",
      keywords: "login startup boot tray",
      control: <Switch label="Start with Windows" checked={snap.startWithWindows} disabled={!snap.installed} onChange={(v) => void setStartWithWindows(v)} />,
    });
    add({
      id: "closeAction",
      page: "general",
      section: "Window",
      title: "Close button",
      description: p.closeAction === "tray" ? "Hidden in the tray, Dailies keeps rendering and notifying you." : "Closing the window stops rendering and notifications.",
      keywords: "quit exit tray minimize",
      prefs: ["closeAction"],
      control: (
        <Select
          label="Close button"
          value={p.closeAction}
          options={[
            { value: "tray", label: "Hide to tray" },
            { value: "quit", label: "Quit Dailies" },
          ]}
          onChange={(v) => set({ closeAction: v })}
        />
      ),
    });
    add({
      id: "confirmRemove",
      page: "general",
      section: "Confirmations",
      title: "Remove confirmation",
      description: "Require a second click before a project is removed from Dailies.",
      keywords: "confirm ask remove close project",
      prefs: ["confirmRemove"],
      control: toggle("confirmRemove", "Remove confirmation"),
    });
    add({
      id: "confirmDelete",
      page: "general",
      section: "Confirmations",
      title: "Delete confirmation",
      description: "Require a second click before a note is deleted.",
      keywords: "confirm ask delete note cue",
      prefs: ["confirmDelete"],
      control: toggle("confirmDelete", "Delete confirmation"),
    });

    add({
      id: "autoplay",
      page: "review",
      section: "Player",
      title: "Autoplay",
      description: "Start playing as soon as a cut opens.",
      keywords: "play start open",
      prefs: ["autoplay"],
      control: toggle("autoplay", "Autoplay"),
    });
    add({
      id: "loopCut",
      page: "review",
      section: "Player",
      title: "Loop the cut",
      description: "Start over when playback reaches the end. An I/O range always loops on its own.",
      keywords: "repeat loop",
      prefs: ["loopCut"],
      control: toggle("loopCut", "Loop the cut"),
    });
    add({
      id: "safeZones",
      page: "review",
      section: "Player",
      title: "Phone safe zones",
      description: "Shown when a cut opens. Press S to toggle them any time.",
      keywords: "tiktok shorts overlay guides portrait",
      prefs: ["safeZones"],
      control: (
        <Select
          label="Phone safe zones"
          value={p.safeZones}
          options={[
            { value: "off", label: "Off" },
            { value: "portrait", label: "Portrait cuts" },
            { value: "always", label: "Always" },
          ]}
          onChange={(v) => set({ safeZones: v })}
        />
      ),
    });
    add({
      id: "showResolved",
      page: "review",
      section: "Notes",
      title: "Show resolved notes",
      description: "Keep resolved and won't-fix notes in the Cues list.",
      keywords: "cues done wontfix hidden",
      prefs: ["showResolved"],
      control: toggle("showResolved", "Show resolved notes"),
    });

    for (const k of SHORTCUTS)
      add({
        id: `key:${k.title}`,
        page: "keyboard",
        section: k.section,
        title: k.title,
        keys: k.keys,
        keywords: `shortcut hotkey ${k.keys.flat().join(" ")}`,
      });

    if (s) {
      add({
        id: "roots",
        page: "folders",
        section: "Watched folders",
        title: "Watched folders",
        keywords: s.roots.map((r) => r.path).join(" "),
        block: <Folders s={s} onRemove={(path) => void service.call("/roots", { remove: path })} />,
      });
      add({
        id: "addRoot",
        page: "folders",
        section: "Watched folders",
        title: "Add a folder",
        description: "Dailies lists every .tsrct up to two folders deep, grouped by the first folder.",
        keywords: "library scan directory tesseract",
        control: (
          <Button
            onClick={async () => {
              const dir = await window.dailies?.pickFolder?.();
              if (dir) void service.call("/roots", { add: dir });
            }}
          >
            <FolderOpen className="size-4" />
            Add folder
          </Button>
        ),
      });

      add({
        id: "renderSlots",
        page: "rendering",
        section: "Renders",
        title: "Parallel renders",
        description: "Exports running at once. Fewer keeps the machine responsive while you work in other apps.",
        keywords: "concurrency jobs cpu gpu speed",
        service: ["renderSlots"],
        control: (
          <Select
            label="Parallel renders"
            className="min-w-24"
            value={String(s.settings.renderSlots)}
            options={s.choices.renderSlots.map((n) => ({
              value: String(n),
              label: n === s.defaults.renderSlots ? `${n}, default` : String(n),
            }))}
            onChange={(v) => void service.call("", { renderSlots: Number(v) })}
          />
        ),
      });
      add({
        id: "encoder",
        page: "rendering",
        section: "Renders",
        title: "Encoder",
        description: "Picked when the service starts, from what this machine supports.",
        keywords: "gpu amf nvenc x264 hardware",
        control: <Value>{`${encoderName(s.render.encoder)}${s.render.encoder ? `, ${s.render.encoder}` : ""}`}</Value>,
      });
      add({
        id: "quality",
        page: "rendering",
        section: "Renders",
        title: "Preview quality",
        description: "Only the seconds that changed re-render between revisions.",
        keywords: "resolution fps segments",
        control: <Value>{`${s.render.resolution} at ${s.render.fps} fps, ${s.render.segmentMs / 1000} s segments`}</Value>,
      });
      add({
        id: "cli",
        page: "rendering",
        section: "Tools",
        title: "Tesseract CLI",
        description: "Renders every revision with tsrct export.",
        keywords: "tsrct version",
        control: <Value>{s.render.cli === "missing" ? <span className="text-red">Not installed</span> : s.render.cli.split(" ")[0] || "Unknown"}</Value>,
      });
      add({
        id: "serviceLog",
        page: "rendering",
        section: "Tools",
        title: "Service log",
        description: `Running since ${ago(s.startedAt)}. Render failures and cache trims are written here.`,
        keywords: "daemon log errors",
        control: window.dailies?.openLog && <Button onClick={() => void window.dailies?.openLog?.("daemon")}>Open log</Button>,
      });

      add({
        id: "meter",
        page: "storage",
        section: "Render cache",
        title: "Cache usage",
        keywords: "disk space size",
        block: <CacheMeter s={s} />,
      });
      add({
        id: "cacheGb",
        page: "storage",
        section: "Render cache",
        title: "Cache limit",
        description: "The oldest renders go first. The latest and approved revision of every cut always stay.",
        keywords: "disk space size gb",
        service: ["cacheGb"],
        control: (
          <Select
            label="Cache limit"
            className="min-w-28"
            value={String(s.settings.cacheGb)}
            options={s.choices.cacheGb.map((n) => ({
              value: String(n),
              label: `${n} GB`,
            }))}
            onChange={(v) => void service.call("", { cacheGb: Number(v) })}
          />
        ),
      });
      add({
        id: "trim",
        page: "storage",
        section: "Render cache",
        title: "Clear old renders",
        description: freed ?? "Removes renders of older revisions. The latest and approved revisions, and anything used in the last 10 minutes, stay.",
        keywords: "free space delete purge clean",
        control: (
          <Button
            disabled={freeing}
            onClick={async () => {
              setFreeing(true);
              const r = await service.call("/trim", { all: true });
              setFreeing(false);
              if (r?.trimmed)
                setFreed(r.trimmed.removed ? `Freed ${bytes(r.trimmed.before - r.trimmed.after)} from ${plural(r.trimmed.removed, "file")}.` : "Nothing to clear. Everything left is in use.");
            }}
          >
            {freeing ? "Clearing" : "Free up space"}
          </Button>
        ),
      });
      add({
        id: "cacheDir",
        page: "storage",
        section: "Location",
        title: "Cache folder",
        description: <span className="[overflow-wrap:anywhere]">{s.cache.dir}</span>,
        keywords: "path folder location",
        control: window.dailies?.openFolder && <Button onClick={() => void window.dailies?.openFolder?.(s.cache.dir)}>Open</Button>,
      });
    }

    if (updates?.enabled && updates.running) {
      const { running, ready, failure, previous } = updates;
      add({
        id: "updateStatus",
        page: "about",
        section: "Updates",
        title: ready ? `${ready.short} is ready` : failure ? `${failure.short} did not build` : "Up to date",
        description: ready
          ? `${ready.subject}. Restart to switch over.`
          : failure
            ? `Failed at ${failure.step}. Still running ${running.short}.`
            : `Follows GitHub main.${updates.lastCheck ? ` Checked ${ago(updates.lastCheck)}.` : ""}`,
        keywords: "version upgrade release check",
        control: ready ? (
          <Button variant="primary" onClick={() => void window.dailies?.applyUpdate()}>
            Restart
          </Button>
        ) : (
          <Button disabled={updates.checking} onClick={() => void window.dailies?.checkUpdates?.()}>
            {updates.checking ? "Checking" : "Check now"}
          </Button>
        ),
      });
      add({
        id: "autoRestart",
        page: "about",
        section: "Updates",
        title: "Restart into updates",
        description: "When an update is ready and the window is hidden, switch to it right away. Otherwise wait for Restart.",
        keywords: "automatic update",
        prefs: ["autoRestart"],
        control: toggle("autoRestart", "Restart into updates"),
      });
      if (previous && !ready)
        add({
          id: "rollback",
          page: "about",
          section: "Updates",
          title: "Roll back",
          description: `Go back to ${previous.short}: ${previous.subject}`,
          keywords: "revert previous version downgrade",
          control: <Button onClick={() => void window.dailies?.rollback?.()}>Roll back</Button>,
        });
      add({
        id: "updateLog",
        page: "about",
        section: "Updates",
        title: "Update log",
        description: "Every fetch, build and restart.",
        keywords: "log",
        control: <Button onClick={() => void window.dailies?.openLog?.("updates")}>Open log</Button>,
      });
    } else if (window.dailies) {
      add({
        id: "devBuild",
        page: "about",
        section: "Updates",
        title: "Development build",
        description: "Running from a working tree. Updates only apply to the installed app.",
        keywords: "version",
      });
    }
    if (snap.appDir)
      add({
        id: "appDir",
        page: "about",
        section: "Data",
        title: "Data folder",
        description: <span className="[overflow-wrap:anywhere]">{snap.appDir}</span>,
        keywords: "path registry preferences",
        control: <Button onClick={() => void window.dailies?.openFolder?.(snap.appDir)}>Open</Button>,
      });
    return list;
  }, [p, snap, s, updates, agentsSetup, freed, freeing]);

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = terms.length
    ? entries.filter((e) => terms.every((t) => `${e.title} ${typeof e.description === "string" ? e.description : ""} ${e.section} ${TITLES[e.page]} ${e.keywords ?? ""}`.toLowerCase().includes(t)))
    : undefined;
  const visible = hits ?? entries.filter((e) => e.page === page);
  const counts = hits ? hits.reduce<Record<string, number>>((m, e) => ((m[e.page] = (m[e.page] ?? 0) + 1), m), {}) : undefined;

  const pagePrefs = [...new Set(visible.flatMap((e) => e.prefs ?? []))];
  const pageService = [...new Set(visible.flatMap((e) => e.service ?? []))];
  const changed = !hits && (pagePrefs.some((k) => p[k] !== DEFAULT_PREFERENCES[k]) || (s && pageService.some((k) => s.settings[k] !== s.defaults[k])));

  const restore = () => {
    if (pagePrefs.length) void resetPreferences(pagePrefs);
    if (s && pageService.length) void service.call("", Object.fromEntries(pageService.map((k) => [k, s.defaults[k]])));
  };

  const groups: {
    key: string;
    page: SettingsPage;
    section: string;
    items: Entry[];
  }[] = [];
  for (const e of visible) {
    const key = `${e.page}/${e.section}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.items.push(e);
    else groups.push({ key, page: e.page, section: e.section, items: [e] });
  }

  return (
    <div
      className="grid h-full min-h-0 grid-cols-[252px_minmax(0,1fr)]"
      onKeyDown={(e) => {
        e.stopPropagation();
        const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
        if (e.key === "/" && !typing) {
          e.preventDefault();
          search.current?.focus();
        }
        if (e.ctrlKey && e.key === ",") {
          e.preventDefault();
          closeSettings();
        }
      }}
    >
      <nav className="flex min-h-0 flex-col bg-well px-3 pt-3 pb-3">
        <label className="flex h-9 items-center gap-2 rounded-[9px] bg-panel px-3 text-faint focus-within:text-soft focus-within:ring-2 focus-within:ring-amber/60">
          <Search className="size-[15px] shrink-0" />
          <input
            ref={search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-faint"
          />
          {q ? (
            <button onClick={() => setQ("")} aria-label="Clear search" className="grid size-5 place-items-center rounded text-dim hover:text-text">
              <X className="size-3.5" />
            </button>
          ) : (
            <kbd className="rounded bg-raised px-1.5 font-sans text-[11.5px] text-dim">/</kbd>
          )}
        </label>
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto">
          {NAV.map((g, gi) => (
            <div key={gi} className={cn("grid gap-0.5", gi > 0 && "mt-4", gi === NAV.length - 1 && "mt-auto pt-4")}>
              {g.label && <div className="px-2.5 pb-1 text-[12px] font-medium text-faint">{g.label}</div>}
              {g.items.map((it) => {
                const active = !hits && page === it.id;
                const n = counts?.[it.id] ?? 0;
                return (
                  <button
                    key={it.id}
                    onClick={() => {
                      setQ("");
                      setPage(it.id);
                    }}
                    className={cn(
                      "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] font-medium transition-colors",
                      active ? "bg-raised text-text" : "text-soft hover:bg-panel hover:text-text",
                      hits && !n && "text-faint",
                    )}
                  >
                    <it.icon className={cn("size-4 shrink-0", active ? "text-amber" : "text-dim")} strokeWidth={1.9} />
                    <span className="flex-1">{it.title}</span>
                    {hits && n > 0 && <span className="text-[12px] text-dim">{n}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>

      <section className="flex min-h-0 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 pr-3 pl-10">
          <D.Title className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px]">
            <span className="text-dim">Settings</span>
            <span className="text-faint">/</span>
            <span className="truncate font-semibold">{hits ? `Results for “${q.trim()}”` : TITLES[page]}</span>
          </D.Title>
          <D.Description className="sr-only">Preferences for Dailies, its render service and updates.</D.Description>
          {changed && (
            <Button variant="ghost" size="sm" onClick={restore}>
              <RotateCcw className="size-3.5" />
              Restore defaults
            </Button>
          )}
          <D.Close asChild>
            <IconButton label="Close settings" keys="Esc" side="bottom">
              <X />
            </IconButton>
          </D.Close>
        </header>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[780px] px-10 pt-2 pb-14">
            {page === "about" && !hits && <About version={s?.version} />}
            {service.error && !s && ["folders", "rendering", "storage"].includes(page) && !hits && (
              <p className="rounded-xl bg-panel px-4 py-3.5 text-soft">The render service did not answer: {service.error}</p>
            )}
            {hits && !hits.length && <p className="pt-16 text-center text-soft">No settings match “{q.trim()}”.</p>}
            {groups.map((g, i) => (
              <div key={g.key} className={cn(i > 0 && "mt-8")}>
                <h3 className="mb-2.5 flex items-baseline gap-2 text-[15px] font-semibold">
                  {hits && (
                    <>
                      <button className="text-dim hover:text-text" onClick={() => (setQ(""), setPage(g.page))}>
                        {TITLES[g.page]}
                      </button>
                      <span className="text-faint">/</span>
                    </>
                  )}
                  {g.section}
                </h3>
                <div className="divide-y divide-line/80 rounded-xl bg-panel">
                  {g.items.map((e) => (
                    <Row key={e.id} e={e} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function Swatch({ id }: { id: ThemeId }) {
  return (
    <div data-theme={id} className="absolute inset-0 bg-ink">
      <div className="absolute inset-y-0 left-0 flex w-[27%] flex-col gap-[5px] bg-well px-[7px] pt-[9px]">
        <div className="mb-[3px] flex items-center gap-[4px]">
          <div className="size-[7px] rounded-full bg-amber" />
          <div className="h-[4px] w-[22px] rounded-full bg-soft/70" />
        </div>
        <div className="flex h-[13px] items-center gap-[4px] rounded-[3px] bg-raised px-[4px]">
          <div className="h-[3px] w-[60%] rounded-full bg-text/80" />
        </div>
        {[72, 54, 64].map((w) => (
          <div key={w} className="flex h-[13px] items-center px-[4px]">
            <div className="h-[3px] rounded-full bg-dim/70" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <div className="absolute top-[9px] right-[9px] left-[calc(27%+9px)] flex h-[52%] gap-[6px]">
        <div className="relative flex-1 overflow-hidden rounded-[3px] bg-black">
          <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_30%_100%,#3b2a4a_0%,#14161c_55%,#000_100%)]" />
          <div className="absolute top-[28%] left-[34%] h-[30%] w-[30%] rounded-[2px] border-[1.5px] border-amber" />
        </div>
        <div className="flex w-[30%] flex-col gap-[4px] rounded-[3px] bg-panel p-[5px]">
          <div className="flex items-center gap-[3px]">
            <div className="grid size-[8px] place-items-center rounded-full bg-amber" />
            <div className="h-[3px] flex-1 rounded-full bg-text/70" />
          </div>
          <div className="h-[3px] w-[80%] rounded-full bg-dim/70" />
          <div className="h-[3px] w-[55%] rounded-full bg-dim/70" />
          <div className="mt-auto h-[9px] rounded-[2px] bg-amber" />
        </div>
      </div>
      <div className="absolute right-[9px] bottom-[9px] left-[calc(27%+9px)] h-[30%] rounded-[3px] bg-panel px-[5px] pt-[6px]">
        <div className="relative grid gap-[3px]">
          <div className="ml-[8%] h-[5px] w-[30%] rounded-[1.5px] bg-text" />
          <div className="flex gap-[2px]">
            <div className="h-[5px] w-[44%] rounded-[1.5px] bg-lane-picture" />
            <div className="h-[5px] w-[38%] rounded-[1.5px] bg-lane-picture" />
          </div>
          <div className="ml-[20%] h-[5px] w-[50%] rounded-[1.5px] bg-lane-graphics" />
          <div className="absolute -top-[3px] left-[58%] h-[calc(100%+6px)] w-[1.5px] bg-playhead" />
          <div className="absolute -top-[5px] left-[30%] size-[6px] rounded-full bg-amber" />
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ choice, selected, onPick }: { choice: ThemeChoice; selected: boolean; onPick: () => void }) {
  const dark = useSystemDark();
  const theme = THEMES.find((t) => t.id === choice);
  const name = theme?.name ?? "Match Windows";
  const blurb =
    theme?.blurb ?? `${THEMES.find((t) => t.id === SYSTEM_THEMES.dark)!.name} in dark mode, ${THEMES.find((t) => t.id === SYSTEM_THEMES.light)!.name} in light. Now ${dark ? "dark" : "light"}.`;
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={cn("group flex flex-col gap-2.5 rounded-xl p-2 text-left transition-colors", selected ? "bg-raised" : "hover:bg-hover/60")}
    >
      <div className={cn("relative aspect-[16/10] w-full overflow-hidden rounded-lg shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-shadow", selected && "shadow-[0_0_0_2px_var(--color-amber)]")}>
        {theme ? (
          <Swatch id={theme.id} />
        ) : (
          <>
            <Swatch id={SYSTEM_THEMES.dark} />
            <div className="absolute inset-0 [clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]">
              <Swatch id={SYSTEM_THEMES.light} />
            </div>
          </>
        )}
      </div>
      <div className="flex items-start gap-2 px-1 pb-1">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">{name}</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-dim">{blurb}</div>
        </div>
        <div className={cn("mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full transition-opacity", selected ? "bg-amber text-amber-ink" : "opacity-0")}>
          <Check className="size-3" strokeWidth={3} />
        </div>
      </div>
    </button>
  );
}

function ThemePicker({ value, onChange }: { value: ThemeChoice; onChange: (v: ThemeChoice) => void }) {
  useActiveTheme();
  const choices: ThemeChoice[] = [...THEMES.map((t) => t.id), "system"];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="-mx-2 grid grid-cols-3 gap-1"
      onKeyDown={(e) => {
        const step = {
          ArrowRight: 1,
          ArrowDown: 3,
          ArrowLeft: -1,
          ArrowUp: -3,
        }[e.key];
        if (!step) return;
        e.preventDefault();
        const i = Math.min(choices.length - 1, Math.max(0, choices.indexOf(value) + step));
        onChange(choices[i]);
        (e.currentTarget.children[i] as HTMLElement | undefined)?.focus();
      }}
    >
      {choices.map((c) => (
        <ThemeCard key={c} choice={c} selected={value === c} onPick={() => onChange(c)} />
      ))}
    </div>
  );
}

function AccentPicker({ value, onChange }: { value: AccentChoice; onChange: (v: AccentChoice) => void }) {
  useActiveAccent();
  const dark = useSystemDark();
  const theme = resolveTheme(useSettingsSnapshot().preferences.theme, dark);
  const choices: AccentChoice[] = ["theme", ...ACCENTS.map((a) => a.id)];
  const nameOf = (c: AccentChoice) => ACCENTS.find((a) => a.id === c)?.name ?? `${theme.name} default`;
  return (
    <div className="flex items-center gap-3">
      <span className="text-[12.5px] text-dim tabular-nums">{nameOf(value)}</span>
      <div
        role="radiogroup"
        aria-label="Accent"
        className="flex items-center gap-1"
        onKeyDown={(e) => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (!step) return;
          e.preventDefault();
          const i = Math.min(choices.length - 1, Math.max(0, choices.indexOf(value) + step));
          onChange(choices[i]);
          (e.currentTarget.children[i] as HTMLElement | undefined)?.focus();
        }}
      >
        {choices.map((c) => {
          const tone = resolveAccent(c, theme);
          const selected = value === c;
          return (
            <button
              key={c}
              role="radio"
              aria-checked={selected}
              aria-label={nameOf(c)}
              title={nameOf(c)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(c)}
              className={cn("group grid size-7 place-items-center rounded-full transition-colors hover:bg-hover", selected && "bg-raised")}
            >
              <span
                className={cn("grid size-[18px] place-items-center rounded-full transition-[scale,box-shadow] duration-150 group-hover:scale-110", selected && "scale-110")}
                style={{ background: tone.fill, color: tone.ink, boxShadow: selected ? `0 0 0 2px var(--color-panel), 0 0 0 3.5px ${tone.fill}` : undefined }}
              >
                {selected && <Check className="size-2.5" strokeWidth={3.5} />}
                {!selected && c === "theme" && <span className="size-[6px] rounded-full" style={{ background: tone.ink, opacity: 0.6 }} />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Row({ e }: { e: Entry }) {
  if (e.block) return <div className="px-4 py-3.5">{e.block}</div>;
  if (e.keys)
    return (
      <div className="flex min-h-12 items-center gap-6 px-4 py-2">
        <div className="min-w-0 flex-1 text-[13.5px] text-text">{e.title}</div>
        <Keys keys={e.keys} />
      </div>
    );
  return (
    <div className="flex min-h-[62px] items-center gap-6 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">{e.title}</div>
        {e.description && <div className="mt-0.5 text-[12.5px] leading-snug text-dim">{e.description}</div>}
      </div>
      {e.control}
    </div>
  );
}

function About({ version }: { version?: string }) {
  const [u, setU] = useState<UpdateState>();
  useEffect(() => {
    void window.dailies?.updateState?.().then(setU);
    return window.dailies?.onUpdate?.(setU);
  }, []);
  const r = u?.running;
  return (
    <div className="mb-8 flex items-center gap-4 rounded-xl bg-panel px-5 py-5">
      <Mark size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="text-[18px] font-semibold">Dailies</span>
          <span className="text-dim">
            {version ?? "0.1.0"}
            {r && <span className="font-mono text-[12.5px]">, {r.short}</span>}
          </span>
        </div>
        <div className="mt-0.5 text-[13px] text-soft">{r ? `${r.subject}. Built ${ago(r.builtAt)}.` : "Review room for agent-made Tesseract videos."}</div>
      </div>
    </div>
  );
}

export function SettingsHost() {
  const { open, page } = useShown();
  const escape = useRef<() => boolean>(() => false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    const off = window.dailies?.onOpenSettings?.((p) => openSettings(p));
    return () => {
      window.removeEventListener("keydown", onKey);
      off?.();
    };
  }, []);
  return (
    <D.Root open={open} onOpenChange={(o) => (o ? openSettings() : closeSettings())}>
      <D.Portal>
        <D.Overlay className="settings-overlay no-drag fixed inset-0 z-40 bg-[#040a0b]/70 backdrop-blur-[3px]" />
        <D.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => escape.current() && e.preventDefault()}
          className="settings-panel no-drag fixed top-1/2 left-1/2 z-50 h-[min(800px,calc(100vh-72px))] w-[min(1180px,calc(100vw-72px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-ink shadow-[0_0_0_1px_rgba(255,255,255,.04),0_30px_120px_rgba(0,0,0,.65)] outline-none"
        >
          <SettingsBody page={page} setPage={(p) => openSettings(p)} escape={escape} />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
