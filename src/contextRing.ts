import type { ProviderInfo } from "./shared/ipc";

/**
 * Context-window fill ring (the "47.2%" from the reference UI). Pure so the
 * hide/clamp rules are testable.
 *
 * Rules:
 * 1. Never invent a denominator: no ring without a documented window size.
 * 2. Never show a dead zero: no ring before the first measured turn.
 * 3. Fraction clamps to 1; the percent label rounds to a whole number.
 */
/** Fill at or above this is close enough that compaction is likely soon. */
export const CONTEXT_WARN_FRACTION = 0.85;

export interface ContextRingView {
  /** 0..1, for the SVG stroke. */
  fraction: number;
  /** e.g. "47%". */
  percentLabel: string;
  /** e.g. "1M", "256k". */
  windowLabel: string;
  /** True when the fill is close enough that compaction is likely soon. */
  warn: boolean;
}

export function contextRing(input: {
  used: number | null | undefined;
  window: number | null | undefined;
}): ContextRingView | null {
  const { used, window: win } = input;
  if (used == null || win == null) return null;
  if (!(win > 0) || !(used > 0)) return null;
  const fraction = Math.min(1, used / win);
  return {
    fraction,
    percentLabel: `${Math.round(fraction * 100)}%`,
    windowLabel: formatWindowSize(win),
    warn: fraction >= CONTEXT_WARN_FRACTION,
  };
}

/** 1000000 -> "1M", 256000 -> "256k", 900 -> "900". */
export function formatWindowSize(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${trimZeros(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    return `${trimZeros(tokens / 1_000)}k`;
  }
  return String(tokens);
}

function trimZeros(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * Documented context window for a thread's model: the explicit model id when
 * set, else the provider's recommended/first model. Null when the provider or
 * model documents no window.
 */
export function contextWindowFor(
  providers: ProviderInfo[],
  providerId: string,
  modelId: string | null | undefined,
): number | null {
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;
  const infos = provider.modelInfo ?? [];
  const byId = modelId ? infos.find((m) => m.id === modelId) : undefined;
  const fallback = infos.find((m) => m.recommended) ?? infos[0];
  return byId?.contextTokens ?? fallback?.contextTokens ?? null;
}

/**
 * Window for the ring: the CLI-reported figure when present, else the static
 * catalog. A model change leaves the catalog stale (issue #317).
 */
export function threadContextWindow(
  reported: number | null | undefined,
  providers: ProviderInfo[],
  providerId: string,
  modelId: string | null | undefined,
): number | null {
  return reported ?? contextWindowFor(providers, providerId, modelId);
}
