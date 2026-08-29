/**
 * Keep a highlighted row visible inside its own overflow box.
 *
 * Element.scrollIntoView({ block: "nearest" }) also walks ancestor
 * scrollports. The composer picker lives under .chatSlot { overflow: hidden },
 * so that call lifts the whole composer and leaves a gap at the bottom (#762).
 */

export function nearestScrollTop(
  viewport: { scrollTop: number; clientHeight: number },
  child: { offsetTop: number; offsetHeight: number },
): number {
  const viewTop = viewport.scrollTop;
  const viewBottom = viewTop + viewport.clientHeight;
  const childTop = child.offsetTop;
  const childBottom = childTop + child.offsetHeight;
  if (childTop < viewTop) return childTop;
  if (childBottom > viewBottom) return childBottom - viewport.clientHeight;
  return viewTop;
}

export function scrollChildIntoNearestView(
  container: HTMLElement | null,
  child: HTMLElement | null,
): void {
  if (!container || !child || container.clientHeight <= 0) return;
  const next = nearestScrollTop(
    { scrollTop: container.scrollTop, clientHeight: container.clientHeight },
    { offsetTop: child.offsetTop, offsetHeight: child.offsetHeight },
  );
  if (next !== container.scrollTop) container.scrollTop = next;
}
