/**
 * Double-Option detector for AppSnap (issue #381). Two Option/Alt keyups
 * inside the window fire a capture. keyup (not keydown) so a held Option
 * that auto-repeats cannot trip the snap.
 */

export const DOUBLE_OPTION_MS = 400;

export function isOptionKey(key: string): boolean {
  return key === "Alt" || key === "AltLeft" || key === "AltRight";
}

export function createDoubleOptionTracker(windowMs = DOUBLE_OPTION_MS) {
  let last = 0;
  return {
    note(
      key: string,
      type: "keydown" | "keyup",
      mods?: { meta?: boolean; ctrl?: boolean; shift?: boolean },
    ): boolean {
      if (!isOptionKey(key) || type !== "keyup") return false;
      if (mods?.meta || mods?.ctrl || mods?.shift) {
        last = 0;
        return false;
      }
      const now = Date.now();
      const hit = last !== 0 && now - last < windowMs;
      last = now;
      return hit;
    },
    reset() {
      last = 0;
    },
  };
}
