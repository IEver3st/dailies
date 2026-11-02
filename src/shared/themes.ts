export type ThemeId = "tide" | "graphite" | "nocturne" | "ember" | "paper";
export type ThemeChoice = ThemeId | "system";
export type AccentId = "teal" | "mint" | "sage" | "sky" | "lavender" | "lilac" | "rose" | "peach" | "lemon";
export type AccentChoice = "theme" | AccentId;

export type AccentTone = { fill: string; ink: string };
export type Accent = { id: AccentId; name: string; dark: AccentTone; light: AccentTone };

export type Palette = {
  ink: string;
  well: string;
  panel: string;
  raised: string;
  hover: string;
  line: string;
  text: string;
  soft: string;
  dim: string;
  faint: string;
  amber: string;
  "amber-ink": string;
  teal: string;
  red: string;
  playhead: string;
  "lane-picture": string;
  "lane-picture-text": string;
  "lane-graphics": string;
  "lane-other": string;
  "error-bg": string;
  "error-text": string;
};

export type Theme = {
  id: ThemeId;
  name: string;
  blurb: string;
  scheme: "dark" | "light";
  symbol: string;
  palette: Palette;
};

export const THEMES: Theme[] = [
  {
    id: "tide",
    name: "Tide",
    blurb: "Deep teal with amber. The original.",
    scheme: "dark",
    symbol: "#8aa3a0",
    palette: {
      ink: "#0f1b1d",
      well: "#0b1517",
      panel: "#132225",
      raised: "#1b2f32",
      hover: "#213739",
      line: "#22363a",
      text: "#e2ebe9",
      soft: "#a9bfbc",
      dim: "#7f9a97",
      faint: "#4f6b68",
      amber: "#ffb238",
      "amber-ink": "#241703",
      teal: "#5fc9b5",
      red: "#ff6b5e",
      playhead: "#ffffff",
      "lane-picture": "#2a4245",
      "lane-picture-text": "#cfe0dd",
      "lane-graphics": "#233a3d",
      "lane-other": "#1d3134",
      "error-bg": "#3a1f1c",
      "error-text": "#ffd2cc",
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    blurb: "True neutral grey, so nothing tints how a cut reads.",
    scheme: "dark",
    symbol: "#9a9a9a",
    palette: {
      ink: "#161616",
      well: "#0f0f0f",
      panel: "#1c1c1c",
      raised: "#262626",
      hover: "#2e2e2e",
      line: "#2c2c2c",
      text: "#ececec",
      soft: "#b6b6b6",
      dim: "#8c8c8c",
      faint: "#5c5c5c",
      amber: "#f2c14e",
      "amber-ink": "#231a04",
      teal: "#6cc6a6",
      red: "#ff6b5e",
      playhead: "#ffffff",
      "lane-picture": "#383838",
      "lane-picture-text": "#e0e0e0",
      "lane-graphics": "#2e2e2e",
      "lane-other": "#252525",
      "error-bg": "#3b1e1c",
      "error-text": "#ffd3cd",
    },
  },
  {
    id: "nocturne",
    name: "Nocturne",
    blurb: "Blue-black with a periwinkle accent.",
    scheme: "dark",
    symbol: "#8a91b4",
    palette: {
      ink: "#0e1120",
      well: "#0a0c18",
      panel: "#131729",
      raised: "#1b2036",
      hover: "#222842",
      line: "#232a44",
      text: "#e4e7f5",
      soft: "#aab0cf",
      dim: "#7d84a8",
      faint: "#4c5378",
      amber: "#9aa8ff",
      "amber-ink": "#10143a",
      teal: "#63d2c0",
      red: "#ff6f82",
      playhead: "#ffffff",
      "lane-picture": "#2b3254",
      "lane-picture-text": "#d6dbf5",
      "lane-graphics": "#242a47",
      "lane-other": "#1d223b",
      "error-bg": "#3a1d2a",
      "error-text": "#ffd0dc",
    },
  },
  {
    id: "ember",
    name: "Ember",
    blurb: "Warm umber with a burnt orange accent.",
    scheme: "dark",
    symbol: "#a89585",
    palette: {
      ink: "#19130f",
      well: "#120d0a",
      panel: "#201913",
      raised: "#2b221a",
      hover: "#342920",
      line: "#33281f",
      text: "#f1e8e0",
      soft: "#c4b4a6",
      dim: "#978576",
      faint: "#635347",
      amber: "#ff8f4a",
      "amber-ink": "#2a1003",
      teal: "#7fcfa5",
      red: "#ff5f7a",
      playhead: "#ffffff",
      "lane-picture": "#443629",
      "lane-picture-text": "#f0e0d0",
      "lane-graphics": "#382c22",
      "lane-other": "#2c231b",
      "error-bg": "#3d1c22",
      "error-text": "#ffd0d8",
    },
  },
  {
    id: "paper",
    name: "Paper",
    blurb: "Warm daylight with ink and a rust accent.",
    scheme: "light",
    symbol: "#6a645a",
    palette: {
      ink: "#f2efe8",
      well: "#ebe7de",
      panel: "#fbfaf6",
      raised: "#dfd9cc",
      hover: "#d5cebf",
      line: "#dad4c7",
      text: "#1d1b17",
      soft: "#4b4740",
      dim: "#6f695f",
      faint: "#a29b8f",
      amber: "#cf5409",
      "amber-ink": "#fff8f1",
      teal: "#0c8a72",
      red: "#c8372a",
      playhead: "#1d1b17",
      "lane-picture": "#d3cbbb",
      "lane-picture-text": "#2b2822",
      "lane-graphics": "#dfd8ca",
      "lane-other": "#e9e4d8",
      "error-bg": "#fbe0dc",
      "error-text": "#8a231a",
    },
  },
];

export const THEME_CHOICES: ThemeChoice[] = ["system", ...THEMES.map((t) => t.id)];

export const ACCENTS: Accent[] = [
  { id: "teal", name: "Teal", dark: { fill: "#7fdccb", ink: "#062923" }, light: { fill: "#0f8c78", ink: "#f2fffc" } },
  { id: "mint", name: "Mint", dark: { fill: "#a6e9bd", ink: "#082b16" }, light: { fill: "#1f8a48", ink: "#f1fff5" } },
  { id: "sage", name: "Sage", dark: { fill: "#c3d9a6", ink: "#1b2a0c" }, light: { fill: "#5a7f2e", ink: "#f8fff0" } },
  { id: "sky", name: "Sky", dark: { fill: "#93ccf6", ink: "#07243a" }, light: { fill: "#1d72bf", ink: "#f2f9ff" } },
  { id: "lavender", name: "Lavender", dark: { fill: "#b9b4f7", ink: "#171340" }, light: { fill: "#5f4fcf", ink: "#f6f4ff" } },
  { id: "lilac", name: "Lilac", dark: { fill: "#dcb6f2", ink: "#2b1038" }, light: { fill: "#8a3fb8", ink: "#fbf4ff" } },
  { id: "rose", name: "Rose", dark: { fill: "#f7afc8", ink: "#3b0d1f" }, light: { fill: "#c1356c", ink: "#fff3f8" } },
  { id: "peach", name: "Peach", dark: { fill: "#ffc09a", ink: "#361606" }, light: { fill: "#cf5a1e", ink: "#fff6f0" } },
  { id: "lemon", name: "Lemon", dark: { fill: "#f4e48d", ink: "#2b2404" }, light: { fill: "#9a7a08", ink: "#fffbe8" } },
];

export const ACCENT_CHOICES: AccentChoice[] = ["theme", ...ACCENTS.map((a) => a.id)];

export function resolveAccent(choice: AccentChoice, theme: Theme): AccentTone {
  const accent = ACCENTS.find((a) => a.id === choice);
  if (!accent) return { fill: theme.palette.amber, ink: theme.palette["amber-ink"] };
  return accent[theme.scheme];
}

export const SYSTEM_THEMES: Record<"dark" | "light", ThemeId> = { dark: "tide", light: "paper" };

export function resolveTheme(choice: ThemeChoice, dark: boolean): Theme {
  const id = choice === "system" ? SYSTEM_THEMES[dark ? "dark" : "light"] : choice;
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function themeCss() {
  const themes = THEMES.map((t) => {
    const vars = Object.entries(t.palette)
      .map(([k, v]) => `--color-${k}:${v};`)
      .join("");
    return `[data-theme="${t.id}"]{${vars}color-scheme:${t.scheme};}`;
  });
  const accents = ACCENTS.flatMap((a) =>
    THEMES.map((t) => {
      const tone = a[t.scheme];
      return `[data-accent="${a.id}"][data-theme="${t.id}"],[data-accent="${a.id}"] [data-theme="${t.id}"]{--color-amber:${tone.fill};--color-amber-ink:${tone.ink};}`;
    }),
  );
  return [...themes, ...accents].join("\n");
}
