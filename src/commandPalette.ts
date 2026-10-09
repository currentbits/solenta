/**
 * Command palette ranking and shortcut matching (#150).
 *
 * Keep this module free of React: the overlay imports it, and the unit
 * tests prove ranking without a DOM.
 */
import { bindingLabel, matchesBinding } from "./keybindings";

export type PaletteMode = "command" | "files" | "content";

export type PaletteItemKind =
  | "action"
  | "thread"
  | "project"
  | "file"
  | "content";

export type PaletteItem = {
  id: string;
  kind: PaletteItemKind;
  title: string;
  subtitle?: string;
  shortcut?: string;
  /** Path (file/content) or action/thread/project id payload. */
  target?: string;
  score: number;
};

export type PaletteAction = {
  id: string;
  title: string;
  subtitle?: string;
  /** Keybinding id whose (possibly remapped) chord is shown as the hint. */
  binding?: string;
  keywords?: string;
};

export type FileContentHit = {
  path: string;
  line: number;
  text: string;
};

const KIND_ORDER: readonly PaletteItemKind[] = [
  "action",
  "thread",
  "project",
  "file",
  "content",
];

/** Empty query still lists items; non-matches drop out. */
export function scoreMatch(query: string, ...fields: string[]): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best: number | null = null;
  for (const field of fields) {
    const t = String(field || "").toLowerCase();
    if (!t) continue;
    const idx = t.indexOf(q);
    if (idx < 0) continue;
    const boundary =
      idx === 0 || t[idx - 1] === "/" || t[idx - 1] === " " || t[idx - 1] === "-";
    const score = (boundary ? 200 : 100) - Math.min(idx, 99);
    if (best == null || score > best) best = score;
  }
  return best;
}

export function rankPaletteItems(
  items: Array<Omit<PaletteItem, "score"> & { haystack: string[] }>,
  query: string,
  limit: number,
): PaletteItem[] {
  const scored: Array<PaletteItem & { origin: number }> = [];
  items.forEach((item, origin) => {
    const score = scoreMatch(query, ...item.haystack, item.title);
    if (score == null) return;
    const { haystack: _h, ...rest } = item;
    scored.push({ ...rest, score, origin });
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.origin - b.origin;
  });
  return scored.slice(0, Math.max(0, limit)).map(({ origin: _o, ...item }) => item);
}

export function groupPaletteItems(
  items: readonly PaletteItem[],
): Array<{ kind: PaletteItemKind; label: string; items: PaletteItem[] }> {
  const labels: Record<PaletteItemKind, string> = {
    action: "Actions",
    thread: "Threads",
    project: "Projects",
    file: "Files",
    content: "In files",
  };
  const buckets = new Map<PaletteItemKind, PaletteItem[]>();
  for (const item of items) {
    const list = buckets.get(item.kind);
    if (list) list.push(item);
    else buckets.set(item.kind, [item]);
  }
  const groups: Array<{
    kind: PaletteItemKind;
    label: string;
    items: PaletteItem[];
  }> = [];
  for (const kind of KIND_ORDER) {
    const list = buckets.get(kind);
    if (list && list.length > 0) {
      groups.push({ kind, label: labels[kind], items: list });
    }
  }
  return groups;
}

/**
 * Cmd/Ctrl+K command palette, Cmd/Ctrl+P files, Cmd/Ctrl+Shift+F content,
 * or whatever the user remapped them to (src/keybindings.ts). Works from
 * inputs (the caller must not apply isShortcutBlocked).
 */
export function matchPaletteShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): PaletteMode | null {
  if (matchesBinding(e, "palette.command")) return "command";
  if (matchesBinding(e, "palette.files")) return "files";
  if (matchesBinding(e, "palette.content")) return "content";
  return null;
}

export function paletteActionShortcut(action: PaletteAction): string | undefined {
  return action.binding ? (bindingLabel(action.binding, true) ?? undefined) : undefined;
}

export function palettePlaceholder(mode: PaletteMode): string {
  if (mode === "files") return "Search files in this project";
  if (mode === "content") return "Search file contents";
  return "Search threads, projects, and actions";
}

export function paletteModeLabel(mode: PaletteMode): string {
  if (mode === "files") return "Files";
  if (mode === "content") return "Contents";
  return "Jump to";
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: "new-thread",
    title: "New thread",
    binding: "thread.new",
    keywords: "create",
  },
  {
    id: "settings",
    title: "Open settings",
    keywords: "preferences config",
  },
  {
    id: "search-files",
    title: "Search files",
    binding: "palette.files",
    keywords: "open file picker",
  },
  {
    id: "search-content",
    title: "Search in files",
    binding: "palette.content",
    keywords: "grep content",
  },
  { id: "kanban", title: "Open kanban", keywords: "board" },
  { id: "planboard", title: "Open planboard", keywords: "issues" },
  { id: "activity", title: "Open activity" },
  { id: "prs", title: "Open pull requests", keywords: "github pr" },
  { id: "usage", title: "Open usage", keywords: "spend cost" },
  { id: "fleet", title: "Open fleet" },
  { id: "insights", title: "Open insights" },
  { id: "digest", title: "Open digest" },
  { id: "add-project", title: "Add project" },
  {
    id: "toggle-agents",
    title: "Toggle agents panel",
    binding: "agents.toggle",
    keywords: "sidebar rail",
  },
  {
    id: "reopen-pane",
    title: "Reopen closed pane",
    binding: "pane.reopen",
    keywords: "restore undo close terminal git",
  },
];
