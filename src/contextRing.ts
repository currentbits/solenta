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

/** Rough chars-per-token for a pre-send estimate (issue #1797): not billing-accurate, good enough for a guard. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

export interface OversizedPromptWarning {
  estTokens: number;
  /** Tokens left in the window before this send, clamped to >= 0. */
  remaining: number;
}

/**
 * Oversized-send guard (#1797): warn when an outgoing prompt's estimate
 * would outrun what's left in the context window, or eat more than ~90%
 * of the window outright even on an otherwise-fresh thread. A null/unknown
 * window never warns — rule 1 of this file ("never invent a denominator")
 * applies here too, so a model Solenta can't size never blocks a send.
 */
export function oversizedPromptWarning(input: {
  estTokens: number;
  window: number | null | undefined;
  used: number | null | undefined;
}): OversizedPromptWarning | null {
  const { estTokens, window: win, used } = input;
  if (win == null || !(win > 0)) return null;
  const remaining = Math.max(0, win - Math.max(0, used ?? 0));
  if (estTokens <= remaining && estTokens <= win * 0.9) return null;
  return { estTokens, remaining };
}

/** Anthropic's extended prompt-cache TTL; past it the next send re-reads everything. */
export const CLAUDE_CACHE_TTL_MS = 60 * 60 * 1000;
// ponytail: fixed cutoff, make it a setting if 50k nags or misses in practice.
export const COLD_COMPACT_MIN_TOKENS = 50_000;

/**
 * "Compact first" chip (issue #1531): a Claude thread idle past the cache TTL
 * with a large context pays full price to re-read it on the next send.
 * `contextTokens` is usage.contextTokens, which already sums cache_read +
 * cache_creation. Returns the token count to show, or null for no chip.
 */
export function coldCompactTokens(input: {
  provider: string;
  contextTokens: number | null | undefined;
  lastActivityAt: number;
  now: number;
}): number | null {
  const { provider, contextTokens, lastActivityAt, now } = input;
  if (provider !== "claude" || contextTokens == null) return null;
  if (contextTokens < COLD_COMPACT_MIN_TOKENS) return null;
  return now - lastActivityAt > CLAUDE_CACHE_TTL_MS ? contextTokens : null;
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
