/**
 * Nested split-tree layout for the thread pane workspace (issue #552).
 *
 * Binary tree, two orientations. Not a docking framework: every layout is
 * splits of splits. Persistence is UI chrome (localStorage), not store state.
 */

export const PANE_TYPES = [
  "chat",
  "diff",
  "terminal",
  "browser",
  "simulator",
  "files",
  "tasks",
  "subagent",
] as const;

export type PaneType = (typeof PANE_TYPES)[number];

export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export type PaneLeaf = {
  kind: "leaf";
  id: string;
  type: PaneType;
};

export type PaneSplit = {
  kind: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  /** First child's fraction of the split. Clamped to [MIN_RATIO, MAX_RATIO]. */
  ratio: number;
  children: [LayoutNode, LayoutNode];
};

export type LayoutNode = PaneLeaf | PaneSplit;

export type LayoutStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  key?(index: number): string | null;
  length?: number;
};

export const PANE_REGISTRY: Record<
  PaneType,
  { title: string; shipped: boolean; split: "horizontal" | "vertical" }
> = {
  chat: { title: "Chat", shipped: true, split: "horizontal" },
  diff: { title: "Git", shipped: true, split: "horizontal" },
  // Side-by-side, not a bottom drawer: the terminal is a pane like Git.
  terminal: { title: "Terminal", shipped: true, split: "horizontal" },
  browser: { title: "Browser", shipped: true, split: "horizontal" },
  simulator: { title: "iOS Simulator", shipped: true, split: "horizontal" },
  files: { title: "Files", shipped: false, split: "horizontal" },
  tasks: { title: "Tasks", shipped: false, split: "horizontal" },
  subagent: { title: "Subagent", shipped: false, split: "horizontal" },
};

export const MIN_RATIO = 0.18;
export const MAX_RATIO = 0.82;
const LAYOUT_KEY_PREFIX = "coder.paneLayout.";

export function paneTitle(type: PaneType): string {
  return PANE_REGISTRY[type].title;
}

export function isPaneType(value: unknown): value is PaneType {
  return (
    typeof value === "string" &&
    (PANE_TYPES as readonly string[]).includes(value)
  );
}

export function defaultPaneLayout(): LayoutNode {
  return { kind: "leaf", id: "pane-1", type: "chat" };
}

export function firstLeaf(node: LayoutNode): PaneLeaf {
  if (node.kind === "leaf") return node;
  return firstLeaf(node.children[0]);
}

export function firstLeafId(node: LayoutNode): string {
  return firstLeaf(node).id;
}

export function leaves(node: LayoutNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...leaves(node.children[0]), ...leaves(node.children[1])];
}

export function findLeaf(node: LayoutNode, id: string): PaneLeaf | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
}

export function leafByType(node: LayoutNode, type: PaneType): PaneLeaf | null {
  if (node.kind === "leaf") return node.type === type ? node : null;
  return leafByType(node.children[0], type) ?? leafByType(node.children[1], type);
}

export function hasPaneType(node: LayoutNode, type: PaneType): boolean {
  return leafByType(node, type) != null;
}

export function serializePaneLayout(node: LayoutNode): string {
  return JSON.stringify(node);
}

export function parsePaneLayout(raw: string | null | undefined): LayoutNode {
  if (raw == null || raw === "") return defaultPaneLayout();
  try {
    const parsed: unknown = JSON.parse(raw);
    const node = asLayoutNode(parsed);
    return node ?? defaultPaneLayout();
  } catch {
    return defaultPaneLayout();
  }
}

export function openPane(
  layout: LayoutNode,
  type: PaneType,
  focusedId: string | null,
): { layout: LayoutNode; focusId: string } {
  const existing = leafByType(layout, type);
  if (existing) return { layout, focusId: existing.id };
  const focus =
    (focusedId ? findLeaf(layout, focusedId) : null) ?? firstLeaf(layout);
  const paneId = freshId([layout], "pane-");
  const splitId = freshId([layout], "split-");
  const fresh: PaneLeaf = { kind: "leaf", id: paneId, type };
  const split: PaneSplit = {
    kind: "split",
    id: splitId,
    orientation: PANE_REGISTRY[type].split,
    ratio: 0.5,
    children: [focus, fresh],
  };
  return { layout: replaceLeaf(layout, focus.id, split), focusId: paneId };
}

export function closePane(
  layout: LayoutNode,
  id: string,
): { layout: LayoutNode; closed: boolean; focusId: string } {
  if (layout.kind === "leaf") {
    return { layout, closed: false, focusId: layout.id };
  }
  const extracted = extract(layout, id);
  if (!extracted || extracted.rest == null) {
    return { layout, closed: false, focusId: firstLeafId(layout) };
  }
  return {
    layout: extracted.rest,
    closed: true,
    focusId: firstLeafId(extracted.rest),
  };
}

export function resizeSplit(
  layout: LayoutNode,
  splitId: string,
  ratio: number,
): LayoutNode {
  const clamped = clampRatio(ratio);
  return mapSplits(layout, (split) =>
    split.id === splitId ? { ...split, ratio: clamped } : split,
  );
}

export function movePane(
  layout: LayoutNode,
  sourceId: string,
  targetId: string,
  edge: DropEdge,
): LayoutNode {
  if (sourceId === targetId) return layout;
  const source = findLeaf(layout, sourceId);
  const target = findLeaf(layout, targetId);
  if (!source || !target) return layout;
  if (edge === "center") {
    return swapTypes(layout, sourceId, targetId);
  }
  const extracted = extract(layout, sourceId);
  if (!extracted || extracted.rest == null) return layout;
  const rest = extracted.rest;
  const liveTarget = findLeaf(rest, targetId);
  if (!liveTarget) return layout;
  const orientation: PaneSplit["orientation"] =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const first =
    edge === "left" || edge === "top" ? extracted.taken : liveTarget;
  const second =
    edge === "left" || edge === "top" ? liveTarget : extracted.taken;
  const split: PaneSplit = {
    kind: "split",
    id: freshId([rest, extracted.taken], "split-"),
    orientation,
    ratio: 0.5,
    children: [first, second],
  };
  return replaceLeaf(rest, targetId, split);
}

export function hydratePaneLayout(
  threadId: string | null,
  opts?: { openDiff?: boolean },
): { layout: LayoutNode; focusId: string } {
  let layout = threadId ? loadPaneLayout(threadId) : defaultPaneLayout();
  if (opts?.openDiff && !hasPaneType(layout, "diff")) {
    layout = openPane(layout, "diff", firstLeafId(layout)).layout;
  }
  return {
    layout,
    focusId:
      (opts?.openDiff && leafByType(layout, "diff")?.id) || firstLeafId(layout),
  };
}

export function clearPaneLayouts(
  storage: LayoutStorage | null = resolveStorage(),
): void {
  if (!storage || typeof storage.key !== "function" || storage.length == null) {
    return;
  }
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(LAYOUT_KEY_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem?.(key);
}

export function loadPaneLayout(
  threadId: string,
  storage: LayoutStorage | null = resolveStorage(),
): LayoutNode {
  if (!storage || !threadId) return defaultPaneLayout();
  try {
    return parsePaneLayout(storage.getItem(LAYOUT_KEY_PREFIX + threadId));
  } catch {
    return defaultPaneLayout();
  }
}

export function savePaneLayout(
  threadId: string,
  layout: LayoutNode,
  storage: LayoutStorage | null = resolveStorage(),
): void {
  if (!storage || !threadId) return;
  try {
    storage.setItem(LAYOUT_KEY_PREFIX + threadId, serializePaneLayout(layout));
  } catch {
    // Private mode / quota: layout just stops persisting.
  }
}

function resolveStorage(): LayoutStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore
  }
  return null;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function asLayoutNode(value: unknown): LayoutNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as { kind?: unknown };
  if (node.kind === "leaf") {
    const leaf = value as { id?: unknown; type?: unknown };
    if (typeof leaf.id !== "string" || leaf.id.length === 0) return null;
    if (!isPaneType(leaf.type)) return null;
    return { kind: "leaf", id: leaf.id, type: leaf.type };
  }
  if (node.kind === "split") {
    const split = value as {
      id?: unknown;
      orientation?: unknown;
      ratio?: unknown;
      children?: unknown;
    };
    if (typeof split.id !== "string" || split.id.length === 0) return null;
    if (split.orientation !== "horizontal" && split.orientation !== "vertical") {
      return null;
    }
    if (!Array.isArray(split.children) || split.children.length !== 2) {
      return null;
    }
    const a = asLayoutNode(split.children[0]);
    const b = asLayoutNode(split.children[1]);
    if (!a || !b) return null;
    return {
      kind: "split",
      id: split.id,
      orientation: split.orientation,
      ratio: clampRatio(typeof split.ratio === "number" ? split.ratio : 0.5),
      children: [a, b],
    };
  }
  return null;
}

function collectIds(node: LayoutNode, into: Set<string>): void {
  into.add(node.id);
  if (node.kind === "split") {
    collectIds(node.children[0], into);
    collectIds(node.children[1], into);
  }
}

function freshId(nodes: LayoutNode[], prefix: string): string {
  const used = new Set<string>();
  for (const node of nodes) collectIds(node, used);
  let i = 1;
  while (used.has(`${prefix}${i}`)) i += 1;
  return `${prefix}${i}`;
}

function replaceLeaf(
  node: LayoutNode,
  id: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.kind === "leaf") return node.id === id ? replacement : node;
  const a = replaceLeaf(node.children[0], id, replacement);
  const b = replaceLeaf(node.children[1], id, replacement);
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

function mapSplits(
  node: LayoutNode,
  fn: (split: PaneSplit) => PaneSplit,
): LayoutNode {
  if (node.kind === "leaf") return node;
  const mapped = fn(node);
  const a = mapSplits(mapped.children[0], fn);
  const b = mapSplits(mapped.children[1], fn);
  if (
    mapped === node &&
    a === node.children[0] &&
    b === node.children[1]
  ) {
    return node;
  }
  return { ...mapped, children: [a, b] };
}

function swapTypes(
  node: LayoutNode,
  aId: string,
  bId: string,
): LayoutNode {
  const a = findLeaf(node, aId);
  const b = findLeaf(node, bId);
  if (!a || !b) return node;
  const aType = a.type;
  const bType = b.type;
  return mapLeaves(node, (leaf) => {
    if (leaf.id === aId) return { ...leaf, type: bType };
    if (leaf.id === bId) return { ...leaf, type: aType };
    return leaf;
  });
}

function mapLeaves(
  node: LayoutNode,
  fn: (leaf: PaneLeaf) => PaneLeaf,
): LayoutNode {
  if (node.kind === "leaf") return fn(node);
  const a = mapLeaves(node.children[0], fn);
  const b = mapLeaves(node.children[1], fn);
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

function extract(
  node: LayoutNode,
  id: string,
): { taken: LayoutNode; rest: LayoutNode | null } | null {
  if (node.kind === "leaf") {
    return node.id === id ? { taken: node, rest: null } : null;
  }
  const left = extract(node.children[0], id);
  if (left) {
    if (left.rest == null) return { taken: left.taken, rest: node.children[1] };
    return {
      taken: left.taken,
      rest: { ...node, children: [left.rest, node.children[1]] },
    };
  }
  const right = extract(node.children[1], id);
  if (right) {
    if (right.rest == null) return { taken: right.taken, rest: node.children[0] };
    return {
      taken: right.taken,
      rest: { ...node, children: [node.children[0], right.rest] },
    };
  }
  return null;
}
