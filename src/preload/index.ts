import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dailies", {
  initialTheme: ipcRenderer.sendSync("dailies:initialTheme"),
  connection: () => ipcRenderer.invoke("dailies:connection"),
  takeNavigation: () => ipcRenderer.invoke("dailies:takeNavigation"),
  openFile: () => ipcRenderer.invoke("dailies:openFile"),
  reveal: (path: string) => ipcRenderer.invoke("dailies:reveal", path),
  openExternal: (url: string) => ipcRenderer.invoke("dailies:openExternal", url),
  updateState: () => ipcRenderer.invoke("dailies:updateState"),
  applyUpdate: () => ipcRenderer.invoke("dailies:applyUpdate"),
  checkUpdates: () => ipcRenderer.invoke("dailies:checkUpdates"),
  rollback: () => ipcRenderer.invoke("dailies:rollback"),
  settings: () => ipcRenderer.invoke("dailies:settings"),
  setPreferences: (patch: unknown) => ipcRenderer.invoke("dailies:setPreferences", patch),
  setStartWithWindows: (on: boolean) => ipcRenderer.invoke("dailies:setStartWithWindows", on),
  pickFolder: () => ipcRenderer.invoke("dailies:pickFolder"),
  openFolder: (path: string) => ipcRenderer.invoke("dailies:openFolder", path),
  openLog: (which: string) => ipcRenderer.invoke("dailies:openLog", which),
  onSettings: (fn: (s: unknown) => void) => {
    const handler = (_e: unknown, s: unknown) => fn(s);
    ipcRenderer.on("dailies:settings", handler);
    return () => ipcRenderer.off("dailies:settings", handler);
  },
  onOpenSettings: (fn: (page?: string) => void) => {
    const handler = (_e: unknown, page?: string) => fn(page);
    ipcRenderer.on("dailies:openSettings", handler);
    return () => ipcRenderer.off("dailies:openSettings", handler);
  },
  onUpdate: (fn: (state: unknown) => void) => {
    const handler = (_e: unknown, state: unknown) => fn(state);
    ipcRenderer.on("dailies:update", handler);
    return () => ipcRenderer.off("dailies:update", handler);
  },
  onNavigate: (fn: (cutId: string) => void) => {
    const handler = (_e: unknown, cutId: string) => fn(cutId);
    ipcRenderer.on("dailies:navigate", handler);
    return () => ipcRenderer.off("dailies:navigate", handler);
  },
});
