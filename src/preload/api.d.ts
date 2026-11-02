import type { Preferences, SettingsSnapshot } from "../shared/preferences";
import type { ThemeChoice } from "../shared/themes";

export type UpdateRelease = { sha: string; short: string; subject: string; author: string; committedAt: string; builtAt: string };

export type UpdateState = {
  enabled: boolean;
  running?: UpdateRelease;
  ready?: UpdateRelease;
  previous?: UpdateRelease;
  checking: boolean;
  lastCheck?: string;
  failure?: { short: string; step: string; error: string };
};

export type DailiesBridge = {
  initialTheme?: ThemeChoice;
  updateState?(): Promise<UpdateState>;
  applyUpdate(): Promise<void>;
  checkUpdates?(): Promise<void>;
  rollback?(): Promise<void>;
  settings?(): Promise<SettingsSnapshot>;
  setPreferences?(patch: Partial<Preferences>): Promise<SettingsSnapshot>;
  setStartWithWindows?(on: boolean): Promise<SettingsSnapshot>;
  pickFolder?(): Promise<string | undefined>;
  openFolder?(path: string): Promise<void>;
  openLog?(which: "updates" | "daemon"): Promise<void>;
  onSettings?(fn: (s: SettingsSnapshot) => void): () => void;
  onOpenSettings?(fn: (page?: string) => void): () => void;
  onUpdate?(fn: (state: UpdateState) => void): () => void;
  connection(): Promise<{ base: string; token: string }>;
  takeNavigation(): Promise<string | undefined>;
  openFile(): Promise<string[]>;
  reveal(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onNavigate(fn: (cutId: string) => void): () => void;
};

declare global {
  interface Window {
    dailies?: DailiesBridge;
  }
}
