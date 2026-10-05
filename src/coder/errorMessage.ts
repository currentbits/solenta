export function errorMessage(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : String(err);
  for (const marker of [
    "MERGE_CONFLICT:",
    "WORKTREE_DIRTY:",
    "WORKTREE_REBASE_CONFLICT:",
  ]) {
    const at = raw.indexOf(marker);
    if (at !== -1) return raw.slice(at + marker.length).trim();
  }
  return raw;
}
