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

/**
 * auto-animate 0.10 (and 1.0 beta) re-observes a row from a debounced timer
 * (updatePos → observePosition) that can fire after the row left the DOM.
 * The observer's root is the document element, so Blink keeps it, and the
 * detached row subtree its callback closes over, alive for the session: a
 * few leaked cards/shelves per status change (#1475). Observing a detached
 * element measures nothing, so drop the call.
 *
 * ponytail: patches the prototype; auto-animate is the app's only
 * IntersectionObserver user. Drop this once upstream checks isConnected.
 */
export function skipDetachedObserve(
  IO: { prototype: IntersectionObserver } | undefined =
    typeof IntersectionObserver === "undefined" ? undefined : IntersectionObserver,
): void {
  const proto = IO?.prototype as
    | (IntersectionObserver & { __skipDetached?: true })
    | undefined;
  if (!proto || proto.__skipDetached) return;
  const observe = proto.observe;
  proto.observe = function (this: IntersectionObserver, target: Element) {
    if (target.isConnected) observe.call(this, target);
  };
  proto.__skipDetached = true;
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
