import type { ProjectInfo } from "./shared/ipc";

/**
 * Per-project default-worktree override (#1775): a project's own
 * `defaultWorktree` wins over settings.defaultWorktree when it is set;
 * null/absent falls through to the global default. Callers still apply
 * their own remote/scratch guard -- this only resolves the stored
 * preference, same split as the electron-side resolveDefaultWorktree
 * (electron/services-shared.js).
 */
export function resolveDefaultWorktree(
  project: Pick<ProjectInfo, "defaultWorktree"> | null | undefined,
  globalDefault: boolean,
): boolean {
  const override = project?.defaultWorktree;
  if (override === true || override === false) return override;
  return globalDefault === true;
}
