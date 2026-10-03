/**
 * Brand-leaning series colours per provider (#1411): Usage charts and the
 * Limits bars share them. Status colours stay reserved for status.
 */
const PROVIDER_COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "var(--text)",
  grok: "var(--green)",
  kimi: "var(--amber)",
  cursor: "var(--blue)",
  opencode: "var(--text-muted)",
  muse: "#a78bfa",
};

export function providerColor(id: string): string {
  return PROVIDER_COLORS[id] ?? "var(--text-muted)";
}
