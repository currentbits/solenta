/**
 * Detect a renderer that booted against a different main-process build.
 *
 * After downloadUpdate swaps the on-disk bundle, a reload (Cmd-R, crash
 * recovery, webNavigation.reload) loads the NEW renderer into the OLD
 * preload. Comparing compile-time __BUILD_SHA__ with app.status().build.sha
 * is the check; either side unstamped (dev tree, test fake) is not a
 * mismatch. That is the whole point of the null/empty guard.
 * ponytail: sha equality is the ceiling; no protocolVersion registry.
 */
export function isBuildMismatch(
  mainSha: string | null | undefined,
  rendererSha: string | null | undefined,
): boolean {
  if (!mainSha || !rendererSha) return false;
  return mainSha !== rendererSha;
}
