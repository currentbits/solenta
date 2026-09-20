import type {
  AgentProfile,
  PermissionMode,
  ProjectInfo,
  ProviderInfo,
  ReasoningEffort,
  ThreadForkOpts,
  ThreadInfo,
} from "./shared/ipc";

const BEST_OF_N_TOO_FEW = "Select at least two installed providers";

export const BEST_OF_N_ISOLATE_ASK =
  "Cannot isolate this fork: Ask threads stay in the shared checkout.";
export const BEST_OF_N_ISOLATE_REMOTE =
  "Cannot isolate this fork: remote projects cannot host git worktrees.";
export const BEST_OF_N_ISOLATE_NO_GIT =
  "Cannot isolate this fork: the project is not a local git repository.";

/** Committed start snapshot shared by every candidate in a Best of N race. */
export type IsolatedSnapshot = {
  sha: string;
  branch: string | null;
  dirty?: boolean;
};

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

/**
 * Preflight for Best of N isolation (#1223). Returns a user-facing error
 * when the project cannot host independent candidate worktrees. Service
 * forkThread(isolate: true) repeats the same checks fail-closed.
 */
export function bestOfNIsolationError(
  thread: Pick<ThreadInfo, "ask"> | null | undefined,
  project: Pick<ProjectInfo, "remoteHost" | "path" | "scm"> | null | undefined,
): string | null {
  if (thread?.ask) return BEST_OF_N_ISOLATE_ASK;
  if (!project || !project.path) return BEST_OF_N_ISOLATE_NO_GIT;
  if (project.remoteHost) return BEST_OF_N_ISOLATE_REMOTE;
  if (project.scm?.support === "unsupported") {
    return `Cannot isolate this fork: ${
      project.scm.detail || "this checkout does not support git worktrees."
    }`;
  }
  return null;
}

/** Fork options for one Best of N candidate. Isolation is required. */
export function bestOfNForkOpts(
  entry: BestOfNEntry,
  snapshot?: IsolatedSnapshot | null,
): ThreadForkOpts {
  const opts: ThreadForkOpts = {
    isolate: true,
    provider: entry.provider,
  };
  if (entry.kind === "profile") opts.model = entry.model;
  if (snapshot && snapshot.sha) {
    opts.leadSnapshotSha = snapshot.sha;
    opts.leadSnapshotBranch = snapshot.branch;
    if (snapshot.dirty) opts.leadSnapshotDirty = true;
  }
  return opts;
}

/** Pull a reusable start snapshot off an isolated fork's return value. */
export function snapshotFromFork(
  thread: Pick<
    ThreadInfo,
    "leadSnapshotSha" | "leadSnapshotBranch" | "leadSnapshotDirty"
  > | null | undefined,
): IsolatedSnapshot | null {
  const sha =
    thread && typeof thread.leadSnapshotSha === "string"
      ? thread.leadSnapshotSha.trim()
      : "";
  if (!sha) return null;
  return {
    sha,
    branch:
      thread &&
      typeof thread.leadSnapshotBranch === "string" &&
      thread.leadSnapshotBranch.trim()
        ? thread.leadSnapshotBranch.trim()
        : null,
    dirty: thread?.leadSnapshotDirty === true,
  };
}
