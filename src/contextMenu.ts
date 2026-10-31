/**
 * Context menu: native Electron Menu.popup when the bridge is
 * present, otherwise a position:fixed portal on document.body.
 *
 * Never render the thread-actions list as
 * position:absolute inside the sidebar scroll container — sibling group
 * stacking contexts always paint through that overlay.
 */

import { showContextMenuFallback } from "./contextMenuFallback";

export type ContextMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  children?: ContextMenuItem[];
  /** Dim trailing hint (wake time). Folded into the native label. */
  whenLabel?: string;
  /** data-* hooks for the HTML fallback (tests). */
  attrs?: Record<string, string>;
};

export type ContextMenuPosition = { x: number; y: number };

type ContextMenuBridge = {
  show(
    items: ContextMenuItem[],
    position?: ContextMenuPosition,
  ): Promise<string | null>;
};

function nativeLabel(item: ContextMenuItem): string {
  return item.whenLabel ? `${item.label} (${item.whenLabel})` : item.label;
}

/** Strip renderer-only fields so IPC / native Menu see a closed shape. */
export function toNativeItems(
  items: readonly ContextMenuItem[],
): ContextMenuItem[] {
  return items.map((item) => ({
    id: item.id,
    label: nativeLabel(item),
    disabled: item.disabled,
    separatorBefore: item.separatorBefore,
    children: item.children ? toNativeItems(item.children) : undefined,
  }));
}

export async function showContextMenu(
  items: readonly ContextMenuItem[],
  position: ContextMenuPosition,
): Promise<string | null> {
  const coder = (globalThis as { coder?: { contextMenu?: ContextMenuBridge } })
    .coder;
  if (coder?.contextMenu?.show) {
    return coder.contextMenu.show(toNativeItems(items), position);
  }
  return showContextMenuFallback(items, position);
}

/**
 * Copy Image (issue #1801). Every image in the transcript already resolves
 * to a fetchable src by the time it is on screen -- a data: URL, or a
 * solenta-media:// URL served by electron/media-protocol.js with
 * supportFetchAPI/corsEnabled set -- so the renderer can read it back as a
 * Blob and hand it to the Clipboard API directly. No IPC, no main-process
 * path validation: this never reads anything the page was not already
 * showing.
 */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  try {
    const res = await fetch(src);
    const blob = await res.blob();
    const ClipboardItemCtor = (
      globalThis as { ClipboardItem?: typeof ClipboardItem }
    ).ClipboardItem;
    if (!ClipboardItemCtor) return false;
    await navigator.clipboard.write([
      new ClipboardItemCtor({ [blob.type || "image/png"]: blob }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Right-click on any transcript image: the one "Copy Image" entry. */
export function imageContextMenu(
  e: { preventDefault(): void; clientX: number; clientY: number },
  src: string,
): void {
  e.preventDefault();
  const items: ContextMenuItem[] = [
    { id: "copy-image", label: "Copy Image", attrs: { "data-copy-image": "" } },
  ];
  void showContextMenu(items, { x: e.clientX, y: e.clientY }).then((id) => {
    if (id === "copy-image") void copyImageToClipboard(src);
  });
}
