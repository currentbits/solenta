const AGENTS_LAST_KEY = "coder.agents.collapsed";

function loadLastAgentsCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(AGENTS_LAST_KEY);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function saveLastAgentsCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(AGENTS_LAST_KEY, value ? "1" : "0");
  } catch {
    // Quota/private mode: last state just stops persisting.
  }
}

export function agentsPanelStartsCollapsed(
  defaultState: "closed" | "open" | null | undefined,
  rememberLast?: boolean | null,
): boolean {
  if (rememberLast) {
    const last = loadLastAgentsCollapsed();
    if (last !== null) return last;
  }
  return defaultState !== "open";
}
