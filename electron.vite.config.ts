import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
    server: { port: 5173, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${process.env.DAILIES_PORT ?? 47800}`, ws: false } } },
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
