import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanPreferences, type Preferences } from "../shared/preferences";

export function createPreferences(appDir: string) {
  const file = join(appDir, "preferences.json");
  let current = cleanPreferences(read());
  const listeners = new Set<(p: Preferences) => void>();

  function read() {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  function write() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(current, null, 2));
    renameSync(tmp, file);
  }

  return {
    get: () => current,
    set(patch: unknown) {
      const next = cleanPreferences(patch, current);
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      current = next;
      write();
      for (const l of listeners) l(current);
      return current;
    },
    onChange(fn: (p: Preferences) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
