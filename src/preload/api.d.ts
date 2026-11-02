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
  updateState?(): Promise<UpdateState>;
  applyUpdate(): Promise<void>;
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
