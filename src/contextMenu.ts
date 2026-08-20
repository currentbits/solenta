/**
 * T3-style context menu: native Electron Menu.popup when the bridge is
 * present, otherwise a position:fixed portal on document.body.
 *
 * T3 Code (pingdotgg/t3code) never renders the thread-actions list as
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
