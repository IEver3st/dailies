export type DailiesBridge = {
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
