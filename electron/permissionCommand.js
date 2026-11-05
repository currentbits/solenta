"use strict";

const { simpleCommands, commandChain } = require("./guardrails.js");

/**
 * Edit-before-approve (#509): extract / apply a shell command on a tool
 * permission, and derive the session-rule prefix for allow-always-after-edit.
 *
 * Claude's addRules `ruleContent` for Bash is a prefix glob (`npm test:*`),
 * not the whole tool. Allow-always keys on the prefix of the command that
 * actually runs (the edit, never the original), or on a rule the user typed
 * (#479). Whole-tool is only the explicit WHOLE_TOOL_RULE overflow.
 *
 * Keep commandPrefix in lockstep with src/permissionRule.ts (parity test:
 * test/permissionRuleParity.test.ts).
 */

/** `alwaysRule` sentinel for "this tool, anything" (#479 overflow). */
const WHOLE_TOOL_RULE = "*";

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
  "gh",
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
 * The CLI's own allow rules for an ask (can_use_tool `permission_suggestions`):
 * one per subcommand of `cd x && rm y && tar …`, plus the Read grant a `cd`
 * outside the project needs. commandPrefix only sees the first token (`cd:*`),
 * which can never cover a compound command. addRules/allow only: a suggested
 * setMode or directory grant is not what "always allow" means.
 * @param {unknown} suggestions
 * @returns {{ toolName: string, ruleContent?: string }[]}
 */
function suggestedAllowRules(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.flatMap((s) =>
    s && s.type === "addRules" && s.behavior === "allow" && Array.isArray(s.rules)
      ? s.rules
          .filter((r) => r && typeof r.toolName === "string")
          .map((r) =>
            typeof r.ruleContent === "string"
              ? { toolName: r.toolName, ruleContent: r.ruleContent }
              : { toolName: r.toolName },
          )
      : [],
  );
}

/**
 * Card / event label of a rule: bare content for the asking tool
 * (`npm test *`), `Read(//tmp/**)` for another one.
 * @param {string} toolName
 * @param {{ toolName: string, ruleContent?: string }} rule
 */
function ruleLabel(toolName, rule) {
  if (rule.ruleContent === undefined) return `any ${rule.toolName}`;
  return rule.toolName === toolName
    ? rule.ruleContent
    : `${rule.toolName}(${rule.ruleContent})`;
}

/**
 * Session addRules payload. Command tools get `ruleContent`: the user's
 * `alwaysRule` when given, else the CLI's `suggested` rules (unedited
 * command only), else the prefix of `command` (the one that runs).
 * `alwaysRule === WHOLE_TOOL_RULE`, or a tool with no command (Edit/Write),
 * stays `{ toolName }` — the whole tool.
 *
 * @param {string} toolName
 * @param {string | null} command
 * @param {unknown} [alwaysRule]
 * @param {{ toolName: string, ruleContent?: string }[]} [suggested]
 */
function sessionAllowRule(toolName, command, alwaysRule, suggested) {
  /** @type {{ toolName: string, ruleContent?: string }} */
  const rule = { toolName };
  const typed = typeof alwaysRule === "string" ? alwaysRule.trim() : "";
  let rules = [rule];
  if (command !== null && !typed && suggested && suggested.length > 0) {
    rules = suggested;
  } else if (command !== null && typed !== WHOLE_TOOL_RULE) {
    const content = typed || commandPrefix(command);
    if (content) rule.ruleContent = content;
  }
  return {
    type: "addRules",
    rules,
    behavior: "allow",
    destination: "session",
  };
}

/**
 * Command prefixes (`git push`) in the session rules Always allow sent for
 * `toolName` (#1854): `git push:*` or the CLI's newer `git push *` gives
 * "git push". The whole-tool rule and exact rules give none; the exact
 * command key covers those.
 * @param {string} toolName
 * @param {{ toolName: string, ruleContent?: string }[]} rules
 * @returns {string[]}
 */
function rulePrefixes(toolName, rules) {
  return (rules || [])
    .filter((r) => r.toolName === toolName && typeof r.ruleContent === "string")
    .map((r) => /^(.*?)(?::\*| \*)$/.exec(r.ruleContent.trim()))
    // A `*` left mid-rule is a glob, not a prefix.
    .map((m) => (m && !m[1].includes("*") ? m[1].trim().split(/\s+/).join(" ") : ""))
    .filter(Boolean);
}

/** Redirects that write nowhere new: `2>&1`, `>/dev/null`. */
const HARMLESS_REDIRECTS = /\d?>&\d|&?\d?>\s*\/dev\/null/g;

/**
 * Whether every simple command in `command` starts with one of `prefixes`
 * (word for word), so `git push origin x && ls -la` needs both `git push`
 * and `ls` remembered. A wrapper (env, xargs, nohup, ...) runs a later word,
 * so it never matches a prefix of its own.
 * ponytail: any other `>`, even a quoted one, asks again; a prefix rule must
 * not stretch to `ls > ~/.zshrc`. Parse redirect targets if that re-asks too
 * often.
 * @param {string} command
 * @param {string[]} prefixes
 */
function coveredByPrefixes(command, prefixes) {
  if (!prefixes.length) return false;
  const plain = command.replace(HARMLESS_REDIRECTS, " ");
  if (plain.includes(">")) return false;
  const segs = simpleCommands(plain);
  const wanted = prefixes.map((p) => p.split(" "));
  return (
    segs.length > 0 &&
    segs.every((seg) => {
      if (commandChain(seg).names.length !== 1) return false;
      const words = seg.slice(seg.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w)));
      return wanted.some((t) => t.every((tok, i) => words[i] === tok));
    })
  );
}

module.exports = {
  WHOLE_TOOL_RULE,
  commandField,
  extractCommand,
  applyCommand,
  resolveEditedCommand,
  commandPrefix,
  suggestedAllowRules,
  ruleLabel,
  sessionAllowRule,
  rulePrefixes,
  coveredByPrefixes,
};
