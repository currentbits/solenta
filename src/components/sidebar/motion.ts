function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export type ListAnimCtrl = {
  enable: () => void;
  disable: () => void;
  destroy?: () => void;
};

export type ListMotionSkip = {
  hydrate: boolean;
  bulk: boolean;
  keyboard: boolean;
};

export function listMotionBlocked(skip: ListMotionSkip): boolean {
  return prefersReducedMotion() || skip.hydrate || skip.bulk || skip.keyboard;
}

/**
 * auto-animate reinserts a removed row for the exit animation and marks it
 * `__aa_del`. disable() cancels that animation and does not take the
 * placeholder back out, so a keyboard snap, bulk replace, or reduced-motion
 * change during the exit leaves a second copy of the row in the list.
 */
export function releaseAbortedRows(parent: HTMLElement): void {
  for (const child of [...parent.children]) {
    if (!("__aa_del" in child)) continue;
    delete (child as HTMLElement & { __aa_del?: unknown }).__aa_del;
    if (child instanceof HTMLElement) child.removeAttribute("style");
    child.remove();
  }
}

export function countIdChurn(
  prev: readonly string[],
  next: readonly string[],
): number {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  let n = 0;
  for (const id of nextSet) if (!prevSet.has(id)) n += 1;
  for (const id of prevSet) if (!nextSet.has(id)) n += 1;
  return n;
}
