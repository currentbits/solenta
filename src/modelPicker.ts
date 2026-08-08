/**
 * Model picker decisions. Pure so they can be tested without a DOM.
 *
 * Rules this encodes:
 * 1. Always show ModelInfo.label (or the raw id when modelInfo is missing).
 * 2. Detail pane follows the highlighted row, falling back to the selected one.
 * 3. An empty efforts list means no reasoning control at all.
 * 4. Reasoning segments fill left-to-right up to the current level (none when null).
 */
import type {
  ModelInfo,
  ProviderInfo,
  ReasoningEffort,
} from "./shared/ipc";

/** One row in the left pane (null id = provider default). */
export interface ModelRow {
  id: string | null;
  label: string;
  vendor: string;
  description: string;
}

/** One segment of the reasoning meter. */
export interface EffortSegment {
  level: ReasoningEffort;
  /** True for every segment at or below the current level. */
  filled: boolean;
}

/**
 * Rows for the left pane: Default first, then each model. Prefer modelInfo
 * for copy; fall back to the raw id when the provider has no modelInfo.
 */
export function buildModelRows(
  provider: ProviderInfo | undefined | null,
): ModelRow[] {
  const rows: ModelRow[] = [
    {
      id: null,
      label: "Default",
      vendor: "",
      description: "Use the provider default model",
    },
  ];
  if (!provider) return rows;

  const infos = Array.isArray(provider.modelInfo) ? provider.modelInfo : [];
  const models = Array.isArray(provider.models) ? provider.models : [];

  if (infos.length > 0) {
    for (const info of infos) {
      rows.push(rowFromInfo(info));
    }
    return rows;
  }

  for (const id of models) {
    rows.push({
      id,
      label: id,
      vendor: "",
      description: "",
    });
  }
  return rows;
}

function rowFromInfo(info: ModelInfo): ModelRow {
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
 * Which row the right pane describes. Highlight wins when set; otherwise the
 * selected model. Falls back to the first row so the pane is never empty.
 */
export function detailModelRow(
  rows: readonly ModelRow[],
  selectedId: string | null,
  highlightId: string | null | undefined,
): ModelRow {
  const target = highlightId !== undefined ? highlightId : selectedId;
  const byHighlight = rows.find((r) => r.id === target);
  if (byHighlight) return byHighlight;
  const bySelected = rows.find((r) => r.id === selectedId);
  if (bySelected) return bySelected;
  return (
    rows[0] ?? {
      id: null,
      label: "Default",
      vendor: "",
      description: "",
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

/** Initial highlight index when the popover opens (selected row, else 0). */
export function initialHighlightIndex(
  rows: readonly ModelRow[],
  selectedId: string | null,
): number {
  const idx = rows.findIndex((r) => r.id === selectedId);
  return idx >= 0 ? idx : 0;
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
