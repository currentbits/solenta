/**
 * Model picker decisions. Pure so they can be tested without a DOM.
 *
 * Rules this encodes:
 * 1. One unified list: every provider's Default + models, grouped by provider.
 * 2. Always show ModelInfo.label (or the raw id when modelInfo is missing).
 * 3. Detail pane follows the highlighted row, falling back to the selected one.
 * 4. An empty efforts list means no reasoning control at all.
 * 5. Reasoning segments fill left-to-right up to the current level (none when null).
 * 6. Unavailable providers are listed but not selectable.
 * 7. With a sessionId, other providers' rows are locked; current provider stays open.
 */
import type {
  ModelInfo,
  ProviderInfo,
  ReasoningEffort,
} from "./shared/ipc";

/** One row in the left pane (null id = that provider's default). */
export interface ModelRow {
  /** Model override id; null means provider default. */
  id: string | null;
  label: string;
  vendor: string;
  description: string;
  providerId: string;
  providerName: string;
  /** Effort levels the row's provider advertises (for the detail meter). */
  efforts: readonly ReasoningEffort[];
  /** Provider CLI is not installed. */
  unavailable: boolean;
  /** Row cannot be chosen (unavailable or session-locked other provider). */
  disabled: boolean;
  /** title / aria explanation when disabled; null when selectable. */
  disabledReason: string | null;
  /**
   * Small provider heading rendered above this row (first row of each group).
   * Null for subsequent rows in the same provider.
   */
  groupHeading: string | null;
}

/** One segment of the reasoning meter. */
export interface EffortSegment {
  level: ReasoningEffort;
  /** True for every segment at or below the current level. */
  filled: boolean;
}

/** Stable key for React lists and selection compare. */
export function rowKey(row: Pick<ModelRow, "providerId" | "id">): string {
  return `${row.providerId}::${row.id ?? ""}`;
}

export function isRowSelected(
  row: Pick<ModelRow, "providerId" | "id">,
  providerId: string,
  modelId: string | null,
): boolean {
  return row.providerId === providerId && row.id === modelId;
}

/**
 * Copy for the session-lock case. Matches the old provider-pill explanation so
 * users hear one rule in both places.
 */
export function sessionLockReason(currentProviderName: string): string {
  return `Session started with ${currentProviderName}. New thread to switch.`;
}

/**
 * Rows for ONE provider: Default first, then models. Prefer modelInfo for
 * copy; fall back to the raw id when the provider has no modelInfo.
 *
 * Does not apply session lock (caller does via buildUnifiedModelRows).
 */
/** Sentinel row id: selecting it opens the free-text field, not a model. */
export const CUSTOM_MODEL_ID = "__custom__";

/**
 * The published list is a snapshot of the CLI's catalogue and goes stale the
 * moment a model ships. Without this row the "lists are suggestions" rule is
 * unreachable: no UI path could name an id the snapshot does not know.
 */
function customRow(
  base: Omit<ModelRow, "id" | "label" | "vendor" | "description" | "groupHeading">,
  providerName: string,
): ModelRow {
  return {
    ...base,
    id: CUSTOM_MODEL_ID,
    label: "Custom...",
    vendor: providerName,
    description: "Type a model id this list does not know yet",
    groupHeading: null,
  };
}

export function buildModelRows(
  provider: ProviderInfo | undefined | null,
): ModelRow[] {
  if (!provider) return [];

  const unavailable = provider.available === false;
  const disabledReason = unavailable ? "not installed" : null;
  const efforts = Array.isArray(provider.efforts) ? provider.efforts : [];
  const base = {
    providerId: provider.id,
    providerName: provider.name,
    efforts,
    unavailable,
    disabled: unavailable,
    disabledReason,
  };

  const rows: ModelRow[] = [
    {
      ...base,
      id: null,
      label: "Default",
      vendor: provider.name,
      description: "Use the provider default model",
      groupHeading: provider.name,
    },
  ];

  const infos = Array.isArray(provider.modelInfo) ? provider.modelInfo : [];
  const models = Array.isArray(provider.models) ? provider.models : [];

  if (infos.length > 0) {
    for (const info of infos) {
      rows.push({
        ...base,
        ...rowFromInfo(info),
        groupHeading: null,
      });
    }
    rows.push(customRow(base, provider.name));
    return rows;
  }

  for (const id of models) {
    rows.push({
      ...base,
      id,
      label: id,
      vendor: provider.name,
      description: "",
      groupHeading: null,
    });
  }
  rows.push(customRow(base, provider.name));
  return rows;
}

/**
 * Every provider's rows in registry order. Applies session lock: when
 * sessionLocked, rows whose providerId differs from currentProviderId are
 * disabled with the lock explanation; the current provider stays selectable
 * (unless its CLI is missing).
 */
export function buildUnifiedModelRows(
  providers: readonly ProviderInfo[],
  currentProviderId: string,
  sessionLocked: boolean,
  currentProviderName?: string,
): ModelRow[] {
  const list = Array.isArray(providers) ? providers : [];
  const lockName =
    currentProviderName ??
    list.find((p) => p.id === currentProviderId)?.name ??
    currentProviderId;
  const lockReason = sessionLockReason(lockName);

  const out: ModelRow[] = [];
  for (const provider of list) {
    const group = buildModelRows(provider);
    for (const row of group) {
      if (
        sessionLocked &&
        row.providerId !== currentProviderId &&
        !row.unavailable
      ) {
        out.push({
          ...row,
          disabled: true,
          disabledReason: lockReason,
        });
      } else if (sessionLocked && row.providerId !== currentProviderId) {
        // Unavailable AND locked: keep unavailable copy (not installed).
        out.push(row);
      } else {
        out.push(row);
      }
    }
  }
  return out;
}

function rowFromInfo(info: ModelInfo): Pick<
  ModelRow,
  "id" | "label" | "vendor" | "description"
> {
  return {
    id: info.id,
    label: info.label,
    vendor: info.vendor,
    description: info.description,
  };
}

/**
 * Label for the composer trigger pill. Never invents a label from thin air:
 * modelInfo.label when present, otherwise the raw id (or "Default" for null).
 */
export function modelTriggerLabel(
  model: string | null,
  provider: ProviderInfo | undefined | null,
): string {
  if (model == null || model === "") return "Default";
  const infos = provider?.modelInfo;
  if (Array.isArray(infos)) {
    const hit = infos.find((m) => m.id === model);
    if (hit) return hit.label;
  }
  return model;
}

/**
 * Which row the right pane describes. Highlight index wins when provided;
 * otherwise the selected (provider, model). Falls back to the first row so
 * the pane is never empty.
 */
export function detailModelRow(
  rows: readonly ModelRow[],
  selectedProviderId: string,
  selectedModelId: string | null,
  highlightIndex?: number | null,
): ModelRow {
  if (
    highlightIndex != null &&
    highlightIndex >= 0 &&
    highlightIndex < rows.length
  ) {
    return rows[highlightIndex]!;
  }
  const bySelected = rows.find((r) =>
    isRowSelected(r, selectedProviderId, selectedModelId),
  );
  if (bySelected) return bySelected;
  return (
    rows[0] ?? {
      id: null,
      label: "Default",
      vendor: "",
      description: "",
      providerId: selectedProviderId,
      providerName: "",
      efforts: [],
      unavailable: false,
      disabled: false,
      disabledReason: null,
      groupHeading: null,
    }
  );
}

/** Index of the row to highlight; clamps into range. */
export function clampHighlightIndex(
  rows: readonly ModelRow[],
  index: number,
): number {
  if (rows.length === 0) return 0;
  if (index < 0) return 0;
  if (index >= rows.length) return rows.length - 1;
  return index;
}

/**
 * Move highlight by delta, skipping disabled rows. Stays put when nothing
 * further in that direction is selectable.
 */
export function stepHighlightIndex(
  rows: readonly ModelRow[],
  from: number,
  delta: number,
): number {
  if (rows.length === 0) return 0;
  if (delta === 0) return clampHighlightIndex(rows, from);
  let i = from + delta;
  while (i >= 0 && i < rows.length) {
    if (!rows[i]!.disabled) return i;
    i += delta;
  }
  return clampHighlightIndex(rows, from);
}

/** First selectable index at or after start; then any index; else 0. */
export function firstSelectableIndex(
  rows: readonly ModelRow[],
  start = 0,
): number {
  if (rows.length === 0) return 0;
  for (let i = Math.max(0, start); i < rows.length; i++) {
    if (!rows[i]!.disabled) return i;
  }
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]!.disabled) return i;
  }
  return 0;
}

/** Last selectable index at or before start. */
export function lastSelectableIndex(
  rows: readonly ModelRow[],
  start?: number,
): number {
  if (rows.length === 0) return 0;
  const from =
    start == null ? rows.length - 1 : Math.min(start, rows.length - 1);
  for (let i = from; i >= 0; i--) {
    if (!rows[i]!.disabled) return i;
  }
  return firstSelectableIndex(rows);
}

/** Initial highlight index when the popover opens (selected row, else first selectable). */
export function initialHighlightIndex(
  rows: readonly ModelRow[],
  selectedProviderId: string,
  selectedModelId: string | null,
): number {
  const idx = rows.findIndex((r) =>
    isRowSelected(r, selectedProviderId, selectedModelId),
  );
  if (idx >= 0) return idx;
  return firstSelectableIndex(rows);
}

/**
 * True only when the provider advertises at least one effort level.
 * Empty list → hide the control entirely (not a disabled stub).
 */
export function showReasoningControl(
  efforts: readonly ReasoningEffort[] | undefined | null,
): boolean {
  return Array.isArray(efforts) && efforts.length > 0;
}

/**
 * Segment meter: every level at or below the current one is filled.
 * Null current means no segments filled (provider default).
 */
export function effortSegments(
  efforts: readonly ReasoningEffort[],
  current: ReasoningEffort | null,
): EffortSegment[] {
  const idx =
    current == null ? -1 : efforts.findIndex((e) => e === current);
  return efforts.map((level, i) => ({
    level,
    filled: idx >= 0 && i <= idx,
  }));
}

/**
 * Human labels for each CLI effort token. One entry per ReasoningEffort so the
 * meter text is readable but still maps 1:1 onto ProviderInfo.efforts (never a
 * parallel scale like Brief/Balanced/Detailed).
 */
const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Display label for the accent effort text next to REASONING. */
export function effortDisplayLabel(current: ReasoningEffort | null): string {
  if (current == null) return "Default";
  return EFFORT_LABELS[current] ?? current;
}

/** One provider row in the drill-down's first level. */
export interface ProviderRow {
  id: string;
  name: string;
  /** e.g. "4 models" or "Default only". */
  summary: string;
  /** How many selectable models it offers, excluding Default and Custom. */
  modelCount: number;
  disabled: boolean;
  /** Full explanation for the tooltip, or null. */
  disabledReason: string | null;
  /**
   * Short text for the row's second line. The full lock reason is a sentence
   * and wrapped to three lines per row, which made the list unreadable exactly
   * when every row was locked.
   */
  badge: string;
  unavailable: boolean;
  /** True for the provider the thread is currently on. */
  current: boolean;
}

/**
 * First level of the picker: providers, not models.
 *
 * A flat list of every provider's models ran to 26 rows, which is more than a
 * popover can show and more than a user wants to read. Drilling means five rows
 * to start, and the models of exactly one harness after that.
 */
export function buildProviderRows(
  providers: readonly ProviderInfo[],
  currentProviderId: string,
  sessionLocked: boolean,
  currentProviderName?: string,
): ProviderRow[] {
  const list = Array.isArray(providers) ? providers : [];
  const lockName =
    currentProviderName ??
    list.find((p) => p.id === currentProviderId)?.name ??
    currentProviderId;
  const lockReason = sessionLockReason(lockName);

  return list.map((p) => {
    const unavailable = p.available === false;
    const models = Array.isArray(p.models) ? p.models : [];
    const isCurrent = p.id === currentProviderId;
    // A locked thread may still browse its OWN provider's models; entering
    // another harness would break a session that can be resumed.
    const locked = sessionLocked && !isCurrent && !unavailable;
    const summary =
      models.length === 0
        ? "Default only"
        : `${models.length} model${models.length === 1 ? "" : "s"}`;
    return {
      id: p.id,
      name: p.name,
      // "locked" alone read as broken (why is Codex locked?); say the action.
      badge: unavailable
        ? "not installed"
        : locked
          ? "new thread to switch"
          : summary,
      summary,
      modelCount: models.length,
      disabled: unavailable || locked,
      disabledReason: unavailable
        ? "not installed"
        : locked
          ? lockReason
          : null,
      unavailable,
      current: isCurrent,
    };
  });
}

/** Index of the first provider row a keyboard user can enter, or -1. */
export function firstSelectableProvider(rows: readonly ProviderRow[]): number {
  return rows.findIndex((r) => !r.disabled);
}

/** Move within the provider list, skipping rows that cannot be entered. */
export function stepProviderIndex(
  rows: readonly ProviderRow[],
  from: number,
  delta: number,
): number {
  if (rows.length === 0) return 0;
  let i = from;
  for (let hops = 0; hops < rows.length; hops += 1) {
    const next = i + delta;
    if (next < 0 || next >= rows.length) return i;
    i = next;
    if (!rows[i]!.disabled) return i;
  }
  return from;
}

/** Where the drill-down should start: the provider the thread is on. */
export function initialProviderIndex(
  rows: readonly ProviderRow[],
  currentProviderId: string,
): number {
  const at = rows.findIndex((r) => r.id === currentProviderId);
  // Only land there if it can actually be entered: a thread whose provider is
  // no longer installed would otherwise open on a dead row.
  if (at >= 0 && !rows[at]!.disabled) return at;
  const first = firstSelectableProvider(rows);
  return first >= 0 ? first : 0;
}

/** What the right pane shows while the picker is on the provider level. */
export interface ProviderDetail {
  providerId: string;
  label: string;
  /** Second line: the vendor slot is meaningless for a provider, so state goes here. */
  vendor: string;
  description: string;
  efforts: ReasoningEffort[];
}

/**
 * Detail for the highlighted PROVIDER.
 *
 * The pane used to index the flat model list with the model-level highlight,
 * so at the provider level it described an arbitrary model: a Grok thread
 * showed "Fable, Anthropic". A pane that confidently describes something the
 * user is not pointing at is worse than an empty one.
 */
export function providerDetail(
  rows: readonly ProviderRow[],
  index: number,
  providers: readonly ProviderInfo[],
): ProviderDetail | null {
  const row = rows[index] ?? rows.find((r) => !r.disabled) ?? rows[0];
  if (!row) return null;
  const info = providers.find((p) => p.id === row.id);
  const count = row.modelCount;
  const models =
    count === 0
      ? "No model choice; uses the provider default."
      : `${count} model${count === 1 ? "" : "s"} to choose from.`;
  const state = row.unavailable
    ? " CLI not found on this machine."
    : row.disabled
      ? " Locked: this thread already has a session."
      : row.current
        ? " Current harness for this thread."
        : "";
  return {
    providerId: row.id,
    label: row.name,
    vendor: row.unavailable
      ? "not installed"
      : row.current
        ? "current harness"
        : "harness",
    description: `${models}${state}`,
    efforts: Array.isArray(info?.efforts) ? info.efforts : [],
  };
}
