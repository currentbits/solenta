import type { ProviderInfo } from "./shared/ipc";

/**
 * Validate a Best of N provider pick.
 *
 * Returns the de-duplicated installed ids in first-seen selected order, or an
 * error string. Unlike hand-off, the live thread's provider is allowed.
 */
export function buildBestOfNPlan(
  availableProviderIds: readonly string[],
  selectedIds: readonly string[],
  currentProviderId: string,
): string[] | string {
  const installed = new Set(availableProviderIds);
  const seen = new Set<string>();
  const plan: string[] = [];
  for (const id of selectedIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!installed.has(id)) continue;
    // Current is allowed when installed; there is no "skip live provider" filter.
    if (id === currentProviderId || installed.has(id)) {
      plan.push(id);
    }
  }
  if (plan.length < 2) {
    return "Select at least two installed providers";
  }
  return plan;
}

/** First advertised vendor line, or empty when the registry has none. */
export function providerVendor(provider: ProviderInfo): string {
  const info = provider.modelInfo[0];
  return info?.vendor ?? "";
}
