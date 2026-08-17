import type {
  AgentProfile,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
} from "./shared/ipc";

const BEST_OF_N_TOO_FEW = "Select at least two installed providers";

/** One Best of N fork: a bare provider override, or a full saved profile. */
export type BestOfNEntry =
  | { kind: "provider"; id: string; provider: string }
  | {
      kind: "profile";
      id: string;
      provider: string;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
      permissionMode: PermissionMode;
    };

/**
 * Validate a Best of N pick of providers and/or saved profiles.
 *
 * Returns de-duplicated entries in first-seen selected order, or an error
 * string. A selected id that matches a saved profile wins over a provider
 * with the same id. Uninstalled providers (and profiles on them) are dropped.
 * Unlike hand-off, the live thread's own provider is allowed — there is no
 * "skip the current provider" filter, which is why no current id is passed.
 */
export function buildBestOfNEntries(
  availableProviderIds: readonly string[],
  selectedIds: readonly string[],
  profiles: readonly AgentProfile[] = [],
): BestOfNEntry[] | string {
  const installed = new Set(availableProviderIds);
  const byId = new Map(
    (Array.isArray(profiles) ? profiles : []).map((p) => [p.id, p]),
  );
  const seen = new Set<string>();
  const plan: BestOfNEntry[] = [];
  for (const id of selectedIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const profile = byId.get(id);
    if (profile) {
      if (!installed.has(profile.provider)) continue;
      plan.push({
        kind: "profile",
        id: profile.id,
        provider: profile.provider,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        permissionMode: profile.permissionMode,
      });
      continue;
    }
    if (!installed.has(id)) continue;
    plan.push({ kind: "provider", id, provider: id });
  }
  if (plan.length < 2) return BEST_OF_N_TOO_FEW;
  return plan;
}

/** First advertised vendor line, or empty when the registry has none. */
export function providerVendor(provider: ProviderInfo): string {
  const info = provider.modelInfo[0];
  return info?.vendor ?? "";
}
