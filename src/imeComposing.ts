/**
 * True while an IME is composing (e.g. a CJK candidate list is open), so
 * Enter/arrow keys belong to the IME, not the app. keyCode 229 covers
 * browsers that fire the confirming keydown after compositionend.
 */
export function isImeComposing(e: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
  const n = "nativeEvent" in e ? e.nativeEvent : e;
  return n.isComposing || n.keyCode === 229;
}
