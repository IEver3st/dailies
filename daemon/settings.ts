import { join } from "node:path";
import { APP_DIR, readJson, writeJsonAtomic } from "./paths";
import { emit } from "./events";

export type Settings = { owner?: string; onboardedAt?: string };
export type AgentClient = { id: string; name: string; version?: string; t3?: boolean; firstAt: string; lastAt: string };

export const SETTINGS_FILE = join(APP_DIR, "settings.json");
const CLIENTS_FILE = join(APP_DIR, "clients.json");
const SEEN_WRITE_MS = 60_000;

let settings = readJson<Settings>(SETTINGS_FILE, {});
let clients = readJson<Record<string, AgentClient>>(CLIENTS_FILE, {});

export const getSettings = (): Settings => settings;
export const agentClients = (): AgentClient[] => Object.values(clients).sort((a, b) => b.lastAt.localeCompare(a.lastAt));

export function owner(fallback = "The user") {
  return settings.owner ?? fallback;
}

export function updateSettings(patch: { owner?: unknown; onboarded?: unknown }): Settings {
  const next: Settings = { ...settings };
  if (typeof patch.owner === "string") {
    const name = patch.owner.replace(/\s+/g, " ").trim().slice(0, 40);
    if (name) next.owner = name;
    else delete next.owner;
  }
  if (patch.onboarded === true) next.onboardedAt ??= new Date().toISOString();
  if (patch.onboarded === false) delete next.onboardedAt;
  settings = next;
  writeJsonAtomic(SETTINGS_FILE, settings);
  emit({ type: "setup" });
  return settings;
}

export function seeClient(header: string | null, t3: boolean) {
  const raw = header?.trim().slice(0, 80);
  if (!raw) return;
  const slash = raw.lastIndexOf("/");
  const name = slash > 0 ? raw.slice(0, slash) : raw;
  const version = slash > 0 ? raw.slice(slash + 1) : undefined;
  const id = name.toLowerCase();
  const prev = clients[id];
  const now = new Date().toISOString();
  if (prev && prev.version === version && (prev.t3 || !t3) && Date.now() - Date.parse(prev.lastAt) < SEEN_WRITE_MS) return;
  clients = { ...clients, [id]: { id, name, version, t3: !!prev?.t3 || t3, firstAt: prev?.firstAt ?? now, lastAt: now } };
  writeJsonAtomic(CLIENTS_FILE, clients);
  emit({ type: "setup" });
}
