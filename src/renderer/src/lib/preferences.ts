import { useSyncExternalStore } from "react";
import { cleanPreferences, DEFAULT_PREFERENCES, type Preferences, type SettingsSnapshot } from "../../../shared/preferences";

const LOCAL_KEY = "dailies-preferences";

const bridge = window.dailies;

let snap: SettingsSnapshot = {
  preferences: cleanPreferences({ ...readLocal(), ...(bridge?.initialTheme ? { theme: bridge.initialTheme } : {}) }),
  startWithWindows: false,
  installed: false,
  appDir: "",
};
const subs = new Set<() => void>();

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null");
  } catch {
    return undefined;
  }
}

function publish(next: SettingsSnapshot) {
  snap = next;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(next.preferences));
  for (const s of subs) s();
}

void bridge?.settings?.().then(publish);
bridge?.onSettings?.(publish);

export const preferences = () => snap.preferences;

export async function setPreferences(patch: Partial<Preferences>) {
  publish({ ...snap, preferences: cleanPreferences(patch, snap.preferences) });
  if (bridge?.setPreferences) publish(await bridge.setPreferences(patch));
}

export async function setStartWithWindows(on: boolean) {
  publish({ ...snap, startWithWindows: on });
  if (bridge?.setStartWithWindows) publish(await bridge.setStartWithWindows(on));
}

export function resetPreferences(keys: (keyof Preferences)[]) {
  const patch: Partial<Preferences> = {};
  for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULT_PREFERENCES[k];
  return setPreferences(patch);
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export const subscribePreferences = subscribe;

export function useSettingsSnapshot() {
  return useSyncExternalStore(subscribe, () => snap);
}

export function usePreference<K extends keyof Preferences>(key: K): Preferences[K] {
  return useSyncExternalStore(subscribe, () => snap.preferences[key]);
}

export { DEFAULT_PREFERENCES, type Preferences };
