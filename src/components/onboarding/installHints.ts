/**
 * Per-provider install hints for the onboarding CLI step (#629).
 *
 * Commands only where the public install is a known npm package whose bin
 * matches electron/providers.js (claude, codex). Everyone else gets a PATH
 * hint plus a docs URL — a wrong brew/pip/npm string is worse than none.
 */

export interface InstallHint {
  command?: string;
  url: string;
}

export const INSTALL_HINTS: Record<string, InstallHint> = {
  claude: {
    command: "npm install -g @anthropic-ai/claude-code",
    url: "https://claude.com/claude-code",
  },
  codex: {
    command: "npm install -g @openai/codex",
    url: "https://github.com/openai/codex",
  },
  opencode: {
    url: "https://opencode.ai",
  },
  grok: {
    url: "https://x.ai/cli",
  },
  kimi: {
    url: "https://github.com/MoonshotAI/kimi-cli",
  },
  cursor: {
    command: "curl https://cursor.com/install -fsS | bash",
    url: "https://cursor.com/cli",
  },
};

/** Fallback when we have no verified install command for this CLI. */
export function pathHint(bin: string): string {
  return `make sure \`${bin}\` is on your PATH`;
}

/**
 * Resolve a copyable command + optional docs URL for a provider id.
 * Unknown ids fall back to the generic PATH hint with no URL.
 */
export function hintFor(id: string): { command: string; url?: string } {
  const known = INSTALL_HINTS[id];
  if (!known) return { command: pathHint(id) };
  return {
    command: known.command ?? pathHint(id),
    url: known.url,
  };
}
