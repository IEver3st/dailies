import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const appDir = process.env.DAILIES_HOME ? resolve(process.env.DAILIES_HOME) : join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Dailies");

function daemonTarget() {
  try {
    const { port } = JSON.parse(readFileSync(join(appDir, "daemon.json"), "utf8"));
    if (port) return `http://127.0.0.1:${port}`;
  } catch {}
  return `http://127.0.0.1:${process.env.DAILIES_PORT ?? 47800}`;
}

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve("src/main/index.ts") } },
  },
  preload: {
    build: { rollupOptions: { input: resolve("src/preload/index.ts"), output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: resolve("src/renderer"),
    resolve: { alias: { "@": resolve("src/renderer/src") } },
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          get target() {
            return daemonTarget();
          },
          ws: false,
        },
      },
    },
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
