/**
 * Imperative HTML fallback for showContextMenu when Electron Menu.popup
 * is not available (jsdom tests, vite browser, web mode).
 *
 * Portals onto document.body with position:fixed so sidebar overflow and
 * sibling stacking contexts cannot clip or paint through it — the T3 web
 * fallback's contract, without vendoring their source.
 */

import type { ContextMenuItem, ContextMenuPosition } from "./contextMenu";

let activeDismiss: (() => void) | null = null;

export function dismissContextMenu(): void {
  activeDismiss?.();
}

const MENU_STYLE =
  "position:fixed;z-index:10000;min-width:12rem;max-width:24rem;" +
  "padding:4px;border-radius:8px;border:1px solid var(--border);" +
  "background:var(--card);box-shadow:var(--shadow-pop);" +
  "display:flex;flex-direction:column;gap:1px;color:var(--text);" +
  "outline:none;pointer-events:auto;";

const ITEM_STYLE =
  "display:flex;align-items:center;justify-content:space-between;gap:12px;" +
  "width:100%;text-align:left;padding:6px 8px;border:none;border-radius:6px;" +
  "background:transparent;color:inherit;font:inherit;font-size:12px;" +
  "cursor:pointer;white-space:nowrap;";

function applyAttrs(el: HTMLElement, attrs?: Record<string, string>): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
}

function clamp(menu: HTMLElement, left: number, top: number): void {
  const rect = menu.getBoundingClientRect();
  const x = Math.min(
    Math.max(4, left),
    Math.max(4, window.innerWidth - rect.width - 4),
  );
  const y = Math.min(
    Math.max(4, top),
    Math.max(4, window.innerHeight - rect.height - 4),
  );
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function inStack(target: EventTarget | null, stack: HTMLElement[]): boolean {
  return target instanceof Node && stack.some((n) => n.contains(target));
}

export function showContextMenuFallback(
  items: readonly ContextMenuItem[],
  position: ContextMenuPosition,
): Promise<string | null> {
  dismissContextMenu();
  return new Promise((resolve) => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const stack: HTMLElement[] = [];
    let disposed = false;

    const cleanup = (result: string | null) => {
      if (disposed) return;
      disposed = true;
      if (activeDismiss === dismiss) activeDismiss = null;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("mousedown", onPointer, true);
      const restore = inStack(document.activeElement, stack);
      for (const n of stack) n.remove();
      if (restore && previous?.isConnected) previous.focus();
      resolve(result);
    };

    const dismiss = () => cleanup(null);
    activeDismiss = dismiss;

    const enabledIn = (menu: HTMLElement): HTMLElement[] =>
      [...menu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([disabled])')];

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
        return;
      }
      const menu = stack[stack.length - 1];
      if (!menu) return;
      const items = enabledIn(menu);
      if (items.length === 0) return;
      const from = items.findIndex((el) => el === document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        items[from < 0 ? 0 : (from + 1) % items.length]!.focus();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        items[from < 0 ? items.length - 1 : (from - 1 + items.length) % items.length]!.focus();
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        items[0]!.focus();
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]!.focus();
        return;
      }
      if (e.key === "ArrowRight" && document.activeElement instanceof HTMLElement) {
        const hasKids = document.activeElement.getAttribute("aria-haspopup") === "menu";
        if (hasKids) {
          e.preventDefault();
          document.activeElement.click();
        }
        return;
      }
      if (
        (e.key === "ArrowLeft" || e.key === "Backspace") &&
        stack.length > 1
      ) {
        e.preventDefault();
        closeFrom(stack.length - 1);
        enabledIn(stack[stack.length - 1]!)[0]?.focus();
      }
    };
    const onPointer = (e: Event) => {
      if (inStack(e.target, stack)) return;
      cleanup(null);
    };

    const closeFrom = (level: number) => {
      while (stack.length > level) stack.pop()?.remove();
    };

    const openLevel = (
      entries: readonly ContextMenuItem[],
      left: number,
      top: number,
      level: number,
    ) => {
      closeFrom(level);
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.style.cssText = MENU_STYLE;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      if (level === 0) menu.setAttribute("data-context-menu", "");
      else menu.setAttribute("data-context-submenu", "");
      menu.dataset.level = String(level);

      for (const item of entries) {
        if (item.separatorBefore && menu.childElementCount > 0) {
          const sep = document.createElement("div");
          sep.setAttribute("role", "separator");
          sep.setAttribute("data-menu-sep", item.id);
          sep.style.cssText =
            "height:1px;margin:4px 6px;background:var(--border);";
          menu.appendChild(sep);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("role", "menuitem");
        btn.style.cssText = ITEM_STYLE;
        btn.disabled = item.disabled === true;
        applyAttrs(btn, item.attrs);
        const label = document.createElement("span");
        label.textContent = item.label;
        btn.appendChild(label);
        if (item.whenLabel) {
          const when = document.createElement("span");
          when.textContent = item.whenLabel;
          when.style.cssText =
            "color:var(--text-dim);font-size:11px;font-variant-numeric:tabular-nums;";
          btn.appendChild(when);
        } else if (item.children && item.children.length > 0) {
          const caret = document.createElement("span");
          caret.textContent = "›";
          caret.setAttribute("aria-hidden", "true");
          caret.style.cssText = "color:var(--text-dim);";
          btn.appendChild(caret);
          btn.setAttribute("aria-haspopup", "menu");
          btn.setAttribute("aria-expanded", "false");
        }
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (item.disabled) return;
          if (item.children && item.children.length > 0) {
            btn.setAttribute("aria-expanded", "true");
            const r = btn.getBoundingClientRect();
            openLevel(item.children, r.right + 4, r.top, level + 1);
            return;
          }
          cleanup(item.id);
        });
        menu.appendChild(btn);
      }

      document.body.appendChild(menu);
      stack.push(menu);
      clamp(menu, left, top);
      const first = menu.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      );
      first?.focus();
    };

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("mousedown", onPointer, true);
    openLevel(items, position.x, position.y, 0);
  });
}
