/** Main app destination. Kept local so Sidebar does not import App. */
export type SidebarNavView =
  | "thread"
  | "kanban"
  | "planboard"
  | "prs"
  | "automations"
  | "activity"
  | "usage"
  | "fleet"
  | "insights"
  | "digest";

export const MORE_DESTINATIONS: readonly {
  id:
    | "activity"
    | "kanban"
    | "automations"
    | "usage"
    | "fleet"
    | "insights"
    | "digest";
  label: string;
  view: SidebarNavView;
}[] = [
  { id: "activity", label: "Activity", view: "activity" },
  { id: "kanban", label: "Kanban", view: "kanban" },
  { id: "automations", label: "Automations", view: "automations" },
  { id: "usage", label: "Usage", view: "usage" },
  { id: "fleet", label: "Fleet", view: "fleet" },
  { id: "insights", label: "Insights", view: "insights" },
  { id: "digest", label: "Digest", view: "digest" },
];

export function moveAppMenuFocus(menu: HTMLElement, key: string): boolean {
  const items = [
    ...menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    ),
  ];
  if (items.length === 0) return false;
  const from = items.findIndex((el) => el === document.activeElement);
  let next = -1;
  if (key === "ArrowDown") next = from < 0 ? 0 : (from + 1) % items.length;
  else if (key === "ArrowUp") {
    next = from < 0 ? items.length - 1 : (from - 1 + items.length) % items.length;
  } else if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else return false;
  items[next]?.focus();
  return true;
}
