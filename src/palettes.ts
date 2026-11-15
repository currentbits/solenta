export const PALETTE_ROLES = [
  "bg", "bg-elevated", "panel", "card", "card-hover", "border", "border-soft",
  "text", "text-body", "text-muted", "text-dim", "text-on-accent",
  "accent", "accent-hover", "accent-edge",
] as const;

type PaletteColors = Record<(typeof PALETTE_ROLES)[number], string>;
export type Palette = {
  format: "solenta-palette";
  version: 1;
  id: string;
  name: string;
  light: PaletteColors;
  dark: PaletteColors;
};
export type PaletteLibrary = { version: 1; selected: string; custom: Palette[] };
export const PALETTE_STORAGE_KEY = "solenta-palettes";
export const PALETTE_FILE_LIMIT = 16_384;
export const PALETTE_LIBRARY_LIMIT = 20;

export const BUILTIN_PALETTES: Palette[] = [
  {
    format: "solenta-palette", version: 1, id: "solenta", name: "Solenta",
    dark: {
      bg: "#111010", "bg-elevated": "#1b1a18", panel: "#171614", card: "#1c1b19", "card-hover": "#252420",
      border: "#2d2b27", "border-soft": "#221f1c", text: "#ecebe6", "text-body": "#dedbd3",
      "text-muted": "#aeaba3", "text-dim": "#8f8c84", "text-on-accent": "#191918",
      accent: "#f2e51f", "accent-hover": "#f7ed4a", "accent-edge": "#f2e51f",
    },
    light: {
      bg: "#fafaf7", "bg-elevated": "#ffffff", panel: "#efeee9", card: "#f6f5f1", "card-hover": "#ecebe6",
      border: "#e0dfd8", "border-soft": "#eae9e3", text: "#1c1b19", "text-body": "#292823",
      "text-muted": "#53514b", "text-dim": "#6b6862", "text-on-accent": "#191918",
      accent: "#f2e51f", "accent-hover": "#e6d90f", "accent-edge": "#857c00",
    },
  },
  {
    format: "solenta-palette", version: 1, id: "midnight", name: "Midnight",
    dark: {
      bg: "#0e1420", "bg-elevated": "#192335", panel: "#131c2b", card: "#182234", "card-hover": "#222f43",
      border: "#34465f", "border-soft": "#26364e", text: "#edf3ff", "text-body": "#dce6f7",
      "text-muted": "#b2c2dc", "text-dim": "#9caccc", "text-on-accent": "#101a2b",
      accent: "#a5c6ff", "accent-hover": "#c0d7ff", "accent-edge": "#a5c6ff",
    },
    light: {
      bg: "#f5f8ff", "bg-elevated": "#ffffff", panel: "#e8eef9", card: "#eff4fc", "card-hover": "#e3ebf8",
      border: "#bdcbe0", "border-soft": "#d3deef", text: "#17243b", "text-body": "#263750",
      "text-muted": "#415575", "text-dim": "#536583", "text-on-accent": "#101a2b",
      accent: "#b8d0ff", "accent-hover": "#a3c1f5", "accent-edge": "#284e91",
    },
  },
  {
    format: "solenta-palette", version: 1, id: "forest", name: "Forest",
    dark: {
      bg: "#101914", "bg-elevated": "#1b2a22", panel: "#142019", card: "#19271f", "card-hover": "#23362a",
      border: "#365242", "border-soft": "#293d31", text: "#edf7ef", "text-body": "#dceade",
      "text-muted": "#b8ccbd", "text-dim": "#a0b7a6", "text-on-accent": "#10221a",
      accent: "#92e0bf", "accent-hover": "#b1edd3", "accent-edge": "#92e0bf",
    },
    light: {
      bg: "#f4faf5", "bg-elevated": "#ffffff", panel: "#e5f1e9", card: "#edf6ef", "card-hover": "#e0eee4",
      border: "#b9ccc1", "border-soft": "#d0e1d5", text: "#182b20", "text-body": "#293e31",
      "text-muted": "#435d4d", "text-dim": "#53695b", "text-on-accent": "#10221a",
      accent: "#92e0bf", "accent-hover": "#78cfa9", "accent-edge": "#0b6245",
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isColors(value: unknown): value is PaletteColors {
  return isRecord(value) && Object.keys(value).length === PALETTE_ROLES.length &&
    PALETTE_ROLES.every((role) => typeof value[role] === "string" && /^#[0-9a-f]{6}$/i.test(value[role]));
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Status/syntax hues stay with appearance in this stage; imported surfaces must keep them readable.
const STATUS_COLORS = {
  light: ["#1e40af", "#065f46", "#78350f", "#9a3412", "#5b21b6", "#991b1b"],
  dark: ["#7aa2e3", "#63c49a", "#fbbf24", "#fb923c", "#a78bfa", "#f87171"],
};

function parseDefinition(value: unknown): Palette {
  if (!isRecord(value) || value.format !== "solenta-palette" || value.version !== 1 ||
      typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(value.id) ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 60 ||
      Object.keys(value).some((k) => !["format", "version", "id", "name", "light", "dark"].includes(k)) ||
      !isColors(value.light) || !isColors(value.dark)) {
    throw new Error("Use a version 1 Solenta palette with a name, id, and every light/dark color role as #RRGGBB. CSS is not supported.");
  }
  for (const [mode, colors] of [["light", value.light], ["dark", value.dark]] as const) {
    for (const surface of ["bg", "bg-elevated", "panel", "card", "card-hover"] as const) {
      if (STATUS_COLORS[mode].some((foreground) => contrast(foreground, colors[surface]) < 4.5)) {
        throw new Error(`${mode}: ${surface} needs at least 4.5:1 contrast with the built-in status colors.`);
      }
      for (const text of ["text", "text-body", "text-muted", "text-dim"] as const) {
        if (contrast(colors[text], colors[surface]) < 4.5) {
          throw new Error(`${mode}: ${text} needs at least 4.5:1 contrast against ${surface}.`);
        }
      }
      if (contrast(colors["accent-edge"], colors[surface]) < 3) {
        throw new Error(`${mode}: accent-edge needs at least 3:1 contrast against ${surface}.`);
      }
    }
    if ([colors.accent, colors["accent-hover"]].some((bg) => contrast(colors["text-on-accent"], bg) < 4.5)) {
      throw new Error(`${mode}: text-on-accent needs at least 4.5:1 contrast against accent and accent-hover.`);
    }
  }
  return { format: "solenta-palette", version: 1, id: value.id, name: value.name.trim(), light: value.light, dark: value.dark };
}

export function parsePalette(text: string): Palette {
  if (text.length > PALETTE_FILE_LIMIT) throw new Error("Palette JSON must be 16 KB or smaller.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid palette JSON."); }
  return parseDefinition(value);
}

export function exportPalette(palette: Palette): string {
  return JSON.stringify(parseDefinition(palette), null, 2) + "\n";
}

export function selectedPalette(library: PaletteLibrary): Palette {
  return library.custom.find((p) => `custom:${p.id}` === library.selected) ??
    BUILTIN_PALETTES.find((p) => p.id === library.selected) ?? BUILTIN_PALETTES[0];
}

function parseLibrary(value: unknown): PaletteLibrary {
  if (!isRecord(value) || value.version !== 1 || typeof value.selected !== "string" ||
      !Array.isArray(value.custom) || value.custom.length > PALETTE_LIBRARY_LIMIT) {
    throw new Error("Invalid palette library.");
  }
  const custom = value.custom.map(parseDefinition);
  if (new Set(custom.map((p) => p.id)).size !== custom.length) throw new Error("Duplicate palette ids.");
  const selected = BUILTIN_PALETTES.some((p) => p.id === value.selected) || custom.some((p) => `custom:${p.id}` === value.selected)
    ? value.selected : "solenta";
  return { version: 1, selected, custom };
}

export function readPaletteLibrary(storage?: Pick<Storage, "getItem">): PaletteLibrary {
  try {
    const raw = (storage ?? window.localStorage).getItem(PALETTE_STORAGE_KEY);
    if (raw && raw.length <= PALETTE_FILE_LIMIT * PALETTE_LIBRARY_LIMIT) return parseLibrary(JSON.parse(raw));
  } catch { /* Corrupt or unavailable storage falls back to the shipped palette. */ }
  return { version: 1, selected: "solenta", custom: [] };
}

export function savePaletteLibrary(library: PaletteLibrary, storage?: Pick<Storage, "setItem">): void {
  const valid = parseLibrary(library);
  const text = JSON.stringify(valid);
  if (text.length > PALETTE_FILE_LIMIT * PALETTE_LIBRARY_LIMIT) throw new Error("Palette library is too large.");
  try { (storage ?? window.localStorage).setItem(PALETTE_STORAGE_KEY, text); }
  catch { throw new Error("Could not save palettes on this device. Free storage and try again, or cancel the preview."); }
}

function declarations(colors: PaletteColors): string {
  const entries = PALETTE_ROLES.map((role) => `--${role}:${colors[role]};`).join("");
  return entries + `--accent-soft:${colors.accent}26;--accent-border:${colors["accent-edge"]}99;` +
    `--mark:${colors.accent}33;--accent-dot:${colors["accent-edge"]};--focus-ring-color:${colors["accent-edge"]};`;
}

export function applyPalette(library: PaletteLibrary, doc: Document = document): void {
  const palette = selectedPalette(library);
  let sheet = doc.getElementById("solenta-palette-colors");
  if (!sheet) {
    sheet = doc.createElement("style");
    sheet.id = "solenta-palette-colors";
    doc.head.append(sheet);
  }
  // High contrast uses the shipped surfaces too, so its fixed text colors stay legible.
  sheet.textContent = library.selected === "solenta" ? "" : `@media (prefers-contrast: no-preference) {
    :root:not([data-contrast="high"]) {${declarations(palette.dark)}}
    :root[data-theme="light"]:not([data-contrast="high"]) {${declarations(palette.light)}}
  }`;
  doc.documentElement.setAttribute("data-palette", library.selected);
}
