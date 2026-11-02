import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dailies", {
  connection: () => ipcRenderer.invoke("dailies:connection"),
  takeNavigation: () => ipcRenderer.invoke("dailies:takeNavigation"),
  openFile: () => ipcRenderer.invoke("dailies:openFile"),
  reveal: (path: string) => ipcRenderer.invoke("dailies:reveal", path),
  openExternal: (url: string) => ipcRenderer.invoke("dailies:openExternal", url),
  onNavigate: (fn: (cutId: string) => void) => {
    const handler = (_e: unknown, cutId: string) => fn(cutId);
    ipcRenderer.on("dailies:navigate", handler);
    return () => ipcRenderer.off("dailies:navigate", handler);
  },
});
