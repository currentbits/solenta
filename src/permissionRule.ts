/**
 * Default allow-always rule shown on the permission card (#477): the prefix
 * glob the main process would derive (`npm test:*`). Mirrors commandPrefix
 * in electron/permissionCommand.js; keep the two in step.
 */

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

export function commandPrefix(command: string): string | null {
  const withoutEnv = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const tokens = withoutEnv.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const bin = tokens[0].replace(/^.*[/\\]/, "");
  let prefix = tokens[0];
  if (TWO_TOKEN_BINS.has(bin) && tokens[1] && !tokens[1].startsWith("-")) {
    prefix = `${tokens[0]} ${tokens[1]}`;
  }
  return `${prefix}:*`;
}
