"use strict";

/**
 * Native OS context menu (T3 `api.contextMenu.show` / Menu.popup).
 * Children become submenus. Resolves the clicked leaf id, or null on dismiss.
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   disabled?: boolean,
 *   separatorBefore?: boolean,
 *   children?: NativeMenuItem[],
 * }} NativeMenuItem
 */

/**
 * @param {readonly NativeMenuItem[]} items
 * @param {(id: string | null) => void} complete
 * @returns {import("electron").MenuItemConstructorOptions[]}
 */
function toTemplate(items, complete) {
  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [];
  const sep = () => {
    if (template.length === 0 || template[template.length - 1].type === "separator") {
      return;
    }
    template.push({ type: "separator" });
  };
  for (const item of items) {
    if (!item || typeof item.id !== "string" || typeof item.label !== "string") continue;
    if (item.separatorBefore) sep();
    if (item.children && item.children.length > 0) {
      template.push({
        label: item.label,
        enabled: item.disabled !== true,
        submenu: toTemplate(item.children, complete),
      });
      continue;
    }
    template.push({
      label: item.label,
      enabled: item.disabled !== true,
      click: () => complete(item.id),
    });
  }
  return template;
}

/**
 * @param {import("electron").BrowserWindow | null} win
 * @param {readonly NativeMenuItem[]} items
 * @param {{ x?: number, y?: number } | null} [position]
 * @param {typeof import("electron").Menu} [MenuImpl]
 * @returns {Promise<string | null>}
 */
function showNativeContextMenu(win, items, position, MenuImpl) {
  const Menu = MenuImpl || require("electron").Menu;
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const complete = (id) => {
      if (done) return;
      done = true;
      resolve(id);
    };
    const menu = Menu.buildFromTemplate(toTemplate(list, complete));
    const x = position && Number.isFinite(position.x) ? Math.floor(position.x) : undefined;
    const y = position && Number.isFinite(position.y) ? Math.floor(position.y) : undefined;
    menu.popup({
      window: win || undefined,
      ...(x != null && y != null ? { x, y } : {}),
      callback: () => complete(null),
    });
  });
}

module.exports = { showNativeContextMenu, toTemplate };
