/**
 * Default allow-always rule for a command permission (#479): the Claude
 * session-rule prefix glob (`npm test:*`) the "Always allow" button shows
 * and the user may edit before confirming.
 *
 * Twin of commandPrefix in electron/permissionCommand.js; keep them in
 * lockstep (test/permissionRuleParity.test.ts). The main process derives
 * the same rule itself when no `alwaysRule` is sent.
 */

/** `alwaysRule` sentinel for "this tool, anything" (WHOLE_TOOL_RULE). */
export const WHOLE_TOOL_RULE = "*";

/** Bins whose second token is the verb (`npm test`, `git status`). */
const TWO_TOKEN_BINS = new Set([
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "cargo",
  "go",
  "git",
  "docker",
  "kubectl",
  "composer",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "make",
  "mise",
]);

export function commandPrefix(command: string | null | undefined): string | null {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;
  const withoutEnv = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const tokens = withoutEnv.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const bin = tokens[0].replace(/^.*[/\\]/, "");
  let prefix = tokens[0];
  if (TWO_TOKEN_BINS.has(bin) && tokens[1] && !tokens[1].startsWith("-")) {
    prefix = `${tokens[0]} ${tokens[1]}`;
  }
  return `${prefix}:*`;
}
