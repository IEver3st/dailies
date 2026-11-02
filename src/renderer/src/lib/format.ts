export const FPS = 60;

export function tc(ms: number) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

export function frameAt(ms: number) {
  return Math.floor((ms / 1000) * FPS + 0.01);
}

export function frameOf(ms: number) {
  return Math.round((ms / 1000) * FPS);
}

export function ago(iso: string, now = Date.now()) {
  const d = Math.max(0, now - Date.parse(iso)) / 1000;
  if (d < 45) return "just now";
  if (d < 90) return "a minute ago";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 5400) return "an hour ago";
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  const days = Math.round(d / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function dbOf(volume: number | undefined) {
  if (volume === undefined) return 0;
  if (volume <= 0) return -60;
  return 20 * Math.log10(volume);
}
