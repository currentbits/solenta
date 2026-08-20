"use strict";

/**
 * Edit-before-approve (#509): extract / apply a shell command on a tool
 * permission, and derive the session-rule prefix for allow-always-after-edit.
 *
 * Claude's addRules `ruleContent` for Bash is a prefix glob (`npm test:*`),
 * not the whole tool. After a human amends the command, that glob must key
 * on the *edited* command — never the original, and never a blank cheque
 * for Bash. Unedited allow-always stays whole-tool; narrowing that is #479.
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
 * Session addRules payload. After an edit, `ruleContent` is the edited
 * command's prefix so allow-always never keys on the original. Unedited
 * stays `{ toolName }` (whole tool) — #479 owns narrowing that default.
 *
 * @param {string} toolName
 * @param {string | null} command
 * @param {{ edited: boolean }} opts
 */
function sessionAllowRule(toolName, command, opts) {
  /** @type {{ toolName: string, ruleContent?: string }} */
  const rule = { toolName };
  if (opts && opts.edited) {
    const prefix = commandPrefix(command);
    if (prefix) rule.ruleContent = prefix;
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
