import { useSyncExternalStore } from "react";
import { resolveAccent, resolveTheme, themeCss, type AccentChoice, type AccentTone, type ThemeChoice, type ThemeId } from "../../../shared/themes";
import { preferences, subscribePreferences } from "./preferences";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
let applied: ThemeId | undefined;
let appliedAccent: AccentChoice | undefined;

function currentChoice(): ThemeChoice {
  return preferences().theme;
}

export function activeTheme() {
  return resolveTheme(currentChoice(), media.matches);
}

export function activeAccent(): AccentTone {
  return resolveAccent(preferences().accent, activeTheme());
}

function apply() {
  const theme = activeTheme();
  const accent = preferences().accent;
  if (theme.id === applied && accent === appliedAccent) return;
  applied = theme.id;
  appliedAccent = accent;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  if (accent === "theme") delete root.dataset.accent;
  else root.dataset.accent = accent;
  for (const l of listeners) l();
}

export function installTheme() {
  const style = document.createElement("style");
  style.id = "dailies-themes";
  style.textContent = themeCss();
  document.head.appendChild(style);
  apply();
  subscribePreferences(apply);
  media.addEventListener("change", apply);
}

export function useActiveTheme() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => applied ?? activeTheme().id,
  );
}

export function useActiveAccent() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => `${applied ?? activeTheme().id}/${appliedAccent ?? preferences().accent}`,
  );
}

export function useSystemDark() {
  return useSyncExternalStore(
    (fn) => {
      media.addEventListener("change", fn);
      return () => media.removeEventListener("change", fn);
    },
    () => media.matches,
  );
}
