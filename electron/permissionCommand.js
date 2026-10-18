"use strict";

/**
 * Edit-before-approve (#509): extract / apply a shell command on a tool
 * permission, and derive the session-rule prefix for allow-always-after-edit.
 *
 * Claude's addRules `ruleContent` for Bash is a prefix glob (`npm test:*`),
 * not the whole tool. After a human amends the command, that glob must key
 * on the *edited* command — never the original, and never a blank cheque
 * for Bash. The renderer mirrors commandPrefix in src/permissionRule.ts to
 * show the rule before it is sent (#477); keep the two in step.
 */

const COMMAND_KEYS = ["command", "cmd", "script"];

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

/**
 * Which string field on the tool input holds the command, or null.
 * @param {unknown} input
 * @returns {"command" | "cmd" | "script" | null}
 */
function commandField(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  for (const k of COMMAND_KEYS) {
    if (typeof input[k] === "string") return k;
  }
  return null;
}

/**
 * Proposed command string, or null when this tool input has none.
 * Empty string still counts — the card should let the user fill it in.
 * @param {unknown} input
 * @returns {string | null}
 */
function extractCommand(input) {
  const k = commandField(input);
  return k ? /** @type {Record<string, string>} */ (input)[k] : null;
}

/**
 * @param {Record<string, unknown>} input
 * @param {string} command
 * @returns {Record<string, unknown>}
 */
function applyCommand(input, command) {
  const k = commandField(input);
  if (!k) return input;
  return { ...input, [k]: command };
}

/**
 * Merge an optional user-edited command into the tool input.
 * `updatedCommand` is ignored when the original input has no command field
 * (so an Edit/Write permission cannot grow a `command` by accident).
 *
 * @param {Record<string, unknown>} rawInput
 * @param {unknown} updatedCommand
 * @returns {{
 *   field: string | null,
 *   original: string | null,
 *   next: string | null,
 *   edited: boolean,
 *   input: Record<string, unknown>,
 * }}
 */
function resolveEditedCommand(rawInput, updatedCommand) {
  const field = commandField(rawInput);
  const original = field
    ? /** @type {string} */ (rawInput[field])
    : null;
  if (!field || typeof updatedCommand !== "string") {
    return { field, original, next: original, edited: false, input: rawInput };
  }
  const next = updatedCommand.trim();
  const edited = original.trim() !== next;
  return {
    field,
    original,
    next,
    edited,
    input: edited ? applyCommand(rawInput, next) : rawInput,
  };
}

/**
 * Claude Bash prefix glob for a session rule (`npm test:*`).
 * Env assignments (`FOO=1 npm test`) are stripped first; flags after the
 * verb are dropped so `npm test -- --grep foo` still keys on `npm test`.
 * @param {string | null | undefined} command
 * @returns {string | null}
 */
function commandPrefix(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return null;
  const withoutEnv = trimmed.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/,
    "",
  );
  const tokens = withoutEnv.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const bin = tokens[0].replace(/^.*[/\\]/, "");
  let prefix = tokens[0];
  if (TWO_TOKEN_BINS.has(bin) && tokens[1] && !tokens[1].startsWith("-")) {
    prefix = `${tokens[0]} ${tokens[1]}`;
  }
  return `${prefix}:*`;
}

/**
 * Session addRules payload for allow-always (#477/#479). A command tool keys
 * on a prefix glob: the user's rule when given, else the prefix of the
 * command that actually runs (the edited one after #509, never the
 * original). Whole tool only when asked: `alwaysRule === null` is the
 * explicit "any Bash". Tools without a command (Edit/Write) stay whole-tool,
 * like the CLI's "allow all edits this session".
 *
 * @param {string} toolName
 * @param {string | null} command  null for tools without a command field
 * @param {string | null} [alwaysRule]
 */
function sessionAllowRule(toolName, command, alwaysRule) {
  /** @type {{ toolName: string, ruleContent?: string }} */
  const rule = { toolName };
  if (command !== null && alwaysRule !== null) {
    const content =
      (typeof alwaysRule === "string" && alwaysRule.trim()) ||
      commandPrefix(command);
    if (content) rule.ruleContent = content;
  }
  return {
    type: "addRules",
    rules: [rule],
    behavior: "allow",
    destination: "session",
  };
}

module.exports = {
  commandField,
  extractCommand,
  applyCommand,
  resolveEditedCommand,
  commandPrefix,
  sessionAllowRule,
};
