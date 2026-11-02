import { ACCENT_CHOICES, THEME_CHOICES, type AccentChoice, type ThemeChoice } from "./themes";

export type Alert = "sound" | "silent" | "off";

export type Preferences = {
  theme: ThemeChoice;
  accent: AccentChoice;
  revisionAlerts: Alert;
  blockedAlerts: Alert;
  alertWhenFocused: boolean;
  followAgents: boolean;
  agentsPanel: boolean;
  closeAction: "tray" | "quit";
  autoRestart: boolean;
  autoplay: boolean;
  loopCut: boolean;
  safeZones: "off" | "portrait" | "always";
  showResolved: boolean;
  confirmRemove: boolean;
  confirmDelete: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "tide",
  accent: "theme",
  revisionAlerts: "sound",
  blockedAlerts: "sound",
  alertWhenFocused: false,
  followAgents: true,
  agentsPanel: false,
  closeAction: "tray",
  autoRestart: true,
  autoplay: false,
  loopCut: false,
  safeZones: "off",
  showResolved: false,
  confirmRemove: false,
  confirmDelete: false,
};

const CHOICES: { [K in keyof Preferences]?: readonly Preferences[K][] } = {
  theme: THEME_CHOICES,
  accent: ACCENT_CHOICES,
  revisionAlerts: ["sound", "silent", "off"],
  blockedAlerts: ["sound", "silent", "off"],
  closeAction: ["tray", "quit"],
  safeZones: ["off", "portrait", "always"],
};

export function cleanPreferences(raw: unknown, base: Preferences = DEFAULT_PREFERENCES): Preferences {
  const out: Preferences = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
    if (!(key in src)) continue;
    const value = src[key];
    const choices = CHOICES[key] as readonly unknown[] | undefined;
    if (choices ? choices.includes(value) : typeof value === typeof DEFAULT_PREFERENCES[key]) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export type SettingsSnapshot = {
  preferences: Preferences;
  startWithWindows: boolean;
  installed: boolean;
  appDir: string;
};
