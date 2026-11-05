"use strict";

/**
 * Governance layer v1 (#262): the per-profile permission matrix.
 *
 * Spec: docs/superpowers/specs/2026-09-02-governance-layer-v1-design.md.
 * Pure apart from fs.realpathSync. The runner composes this after #409's
 * classifyTool on Claude's can_use_tool and again when the user answers the
 * card, so an edited command is judged as the thing that actually runs.
 *
 * Deny wins: every matching rule is collected and the most severe action
 * decides (block > deny > ask > allow), never first-glob-wins. A path that
 * cannot be canonicalized fails CLOSED (Cursor CVE-2026-50548 failed open).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WRITE_TOOLS } = require("./guardrails.js");
const { autoApproveRules } = require("./autoApprove.js");

const ACTIONS = new Set(["block", "deny", "ask", "allow"]);
const KINDS = new Set(["tool", "bash", "write", "network"]);
const SEVERITY = ["block", "deny", "ask", "allow"];
const MAX_RULES = 40;
const MAX_MATCH = 200;

/** Interactive tools: the card IS the tool, so the matrix never answers them. */
const MATRIX_SKIP = new Set(["askuserquestion", "exitplanmode"]);

/** Same class as #409 injection.hiddenchars. */
const HIDDEN = /[​-‏‪-‮⁦-⁩﻿]/g;

/** Shell substitution: an allow rule cannot vouch for what runs inside it. */
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

// ---------------------------------------------------------------------------
// Policy schema (store heal + settings:set validation)
// ---------------------------------------------------------------------------

/**
 * @param {unknown} raw
 * @param {boolean} strict - throw on junk (settings:set) vs null (disk heal)
 * @returns {{ defaultAction: "ask" | "allow", rules: Array<{ kind: string, match: string, action: string }> } | null}
 */
function parsePolicy(raw, strict) {
  const fail = (msg) => {
    if (strict) throw new Error(`agentProfiles entry policy ${msg}`);
    return null;
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("must be an object");
  }
  const rec = /** @type {Record<string, unknown>} */ (raw);
  const defaultAction = rec.defaultAction;
  if (defaultAction !== "ask" && defaultAction !== "allow") {
    return fail("defaultAction must be ask or allow");
  }
  if (!Array.isArray(rec.rules)) return fail("rules must be an array");
  if (rec.rules.length > MAX_RULES) {
    return fail(`rules must have at most ${MAX_RULES} entries`);
  }
  const rules = [];
  for (const r of rec.rules) {
    if (!r || typeof r !== "object") return fail("rule must be an object");
    const kind = r.kind;
    const action = r.action;
    const match = typeof r.match === "string" ? r.match.trim() : "";
    if (!KINDS.has(kind)) {
      return fail("rule kind must be tool, bash, write, or network");
    }
    if (!ACTIONS.has(action)) {
      return fail("rule action must be block, deny, ask, or allow");
    }
    if (!match || match.length > MAX_MATCH) {
      return fail(`rule match must be 1-${MAX_MATCH} characters`);
    }
    rules.push({ kind, match, action });
  }
  return { defaultAction, rules };
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/** @param {unknown} name */
function normalizeTool(name) {
  return String(name || "").normalize("NFKC").trim().toLowerCase();
}

/**
 * Canonical command: NFKC, invisible Unicode stripped, whitespace collapsed,
 * leading `FOO=1` assignments dropped (same shape permissionCommand strips).
 * @param {unknown} command
 * @returns {string | null}
 */
function normalizeCommand(command) {
  if (typeof command !== "string") return null;
  const out = command
    .normalize("NFKC")
    .replace(HIDDEN, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  return out || null;
}

/**
 * realpath of the deepest existing ancestor plus the not-yet-created tail,
 * so Write to a new file canonicalizes and a symlinked parent cannot hide.
 * Throws on anything but "does not exist" (EACCES, ELOOP, ...).
 * @param {string} abs
 */
function realpathAllowMissing(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = err && /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Forward slashes, one leading slash (Windows drive paths included). */
function posix(p) {
  const s = String(p).replace(/\\/g, "/");
  return s.startsWith("/") ? s : `/${s}`;
}

/**
 * @param {string} raw
 * @param {string | null | undefined} worktreePath
 * @returns {string} canonical POSIX path
 */
function normalizePath(raw, worktreePath) {
  const s = String(raw).normalize("NFKC").replace(HIDDEN, "");
  const expanded =
    s === "~" || s.startsWith("~/") ? path.join(os.homedir(), s.slice(1)) : s;
  const abs = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(worktreePath || process.cwd(), expanded);
  return posix(realpathAllowMissing(abs));
}

/** @param {Record<string, unknown>} input */
function rawPath(input) {
  for (const k of ["file_path", "path", "notebook_path", "filePath"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  return null;
}

/** @param {Record<string, unknown>} input */
function rawCommand(input) {
  for (const k of ["command", "cmd", "script"]) {
    if (typeof input[k] === "string") return input[k];
  }
  return null;
}

/** @param {string} s */
function hostOf(s) {
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host.replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} input
 * @param {string | null} command
 */
function extractHosts(input, command) {
  const hosts = new Set();
  for (const k of ["url", "uri", "href"]) {
    const h = typeof input[k] === "string" ? hostOf(input[k]) : null;
    if (h) hosts.add(h);
  }
  if (command) {
    for (const m of command.matchAll(/\bhttps?:\/\/[^\s"'`<>|;&)]+/gi)) {
      const h = hostOf(m[0]);
      if (h) hosts.add(h);
    }
  }
  return [...hosts].sort();
}

/**
 * @typedef {{ tool: string, command: string | null, path: string | null, hosts: string[] }} Call
 */

/**
 * Canonical form of a tool call. Throws only when a WRITE tool's path cannot
 * be canonicalized; any other tool keeps the lexical path.
 * @param {string} toolName
 * @param {unknown} rawInput
 * @param {string | null | undefined} worktreePath
 * @returns {Call}
 */
function normalizeCall(toolName, rawInput, worktreePath) {
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? /** @type {Record<string, unknown>} */ (rawInput)
      : {};
  const command = normalizeCommand(rawCommand(input));
  const p = rawPath(input);
  let canonical = null;
  if (p) {
    try {
      canonical = normalizePath(p, worktreePath);
    } catch (err) {
      if (WRITE_TOOLS.has(String(toolName || ""))) throw err;
      canonical = posix(path.resolve(worktreePath || process.cwd(), p));
    }
  }
  return {
    tool: normalizeTool(toolName),
    command,
    path: canonical,
    hosts: extractHosts(input, command),
  };
}

/** @param {Call} call */
function actionHash(call) {
  const stable = JSON.stringify({
    command: call.command,
    hosts: [...call.hosts].sort(),
    path: call.path,
    tool: call.tool,
  });
  return crypto.createHash("sha256").update(stable).digest("hex");
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

/** Case-insensitive full match; `*` any run (slashes included), `?` one char. */
function globRe(glob) {
  const body = String(glob)
    .normalize("NFKC")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "is");
}

/** Bash patterns are word prefixes: `npm publish` covers `npm publish --tag x`. */
function bashMatches(glob, sub) {
  return globRe(glob).test(sub) || globRe(`${glob} *`).test(sub);
}

/**
 * Split on && || ; | and newlines. Quote-blind on purpose: a false split
 * only makes deny match more and allow match less.
 * @param {string} command
 */
function subcommands(command) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Rules that fire for this call, deny/ask side and allow side separately:
 * an allow must cover EVERY subcommand, a deny needs only one.
 * @param {Array<{ kind: string, match: string, action: string }>} rules
 * @param {Call} call
 * @param {string | null | undefined} worktreePath
 * @param {boolean} writeTool
 * @param {Record<string, unknown>} [input] - raw tool input, for `test` rules
 */
function matchingRules(rules, call, worktreePath, writeTool, input = {}) {
  const subs = call.command ? subcommands(call.command) : [];
  let rel = null;
  if (call.path && worktreePath) {
    let root;
    try {
      root = posix(fs.realpathSync.native(worktreePath));
    } catch {
      root = posix(path.resolve(worktreePath));
    }
    if (call.path.startsWith(`${root}/`)) rel = call.path.slice(root.length + 1);
  }

  const hits = [];
  const bashAllows = [];
  for (const rule of rules) {
    // Auto-approve toggles (#1721) bring their own matcher.
    if (typeof rule.test === "function") {
      if (rule.test({ tool: call.tool, input, worktreePath })) hits.push(rule);
      continue;
    }
    const re = globRe(rule.match);
    if (rule.kind === "tool") {
      if (re.test(call.tool)) hits.push(rule);
    } else if (rule.kind === "write") {
      if (writeTool && call.path && (re.test(call.path) || (rel && re.test(rel)))) {
        hits.push(rule);
      }
    } else if (rule.kind === "network") {
      if (call.hosts.some((h) => re.test(h))) hits.push(rule);
    } else if (rule.kind === "bash" && subs.length) {
      if (rule.action === "allow") bashAllows.push(rule);
      else if (subs.some((s) => bashMatches(rule.match, s))) hits.push(rule);
    }
  }
  if (bashAllows.length && !SUBSTITUTION.test(call.command || "")) {
    const used = new Set();
    const covered = subs.every((s) => {
      const r = bashAllows.find((a) => bashMatches(a.match, s));
      if (r) used.add(r);
      return Boolean(r);
    });
    if (covered) hits.push(...used);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

/** @param {{ kind: string, match: string }} r */
function ruleLabel(r) {
  return `${r.kind}:${r.match}`;
}

/**
 * @param {{
 *   toolName: string,
 *   rawInput: unknown,
 *   worktreePath: string | null,
 *   policy: { defaultAction: string, rules: Array<{ kind: string, match: string, action: string }> } | null | undefined,
 *   builtin: { decision: string, rule: string | null, reason: string } | null,
 *   sessionAllows?: ReadonlySet<string>,
 *   mcpRules?: Array<{ kind: string, match: string, action: string, source?: string, label?: string, test?: Function }>,
 * }} input - mcpRules: sourced non-profile rules (MCP per-tool, auto-approve)
 * @returns {{ decision: "allow" | "ask" | "deny", layer: string, rule: string | null, reason: string, actionHash: string, declared: Call }}
 */
function evaluate(input) {
  try {
    return evaluateUnsafe(input);
  } catch (err) {
    // Fail closed: an unanswered can_use_tool hangs the CLI, an allow on a
    // bug is the CVE. A visible deny is the only safe answer.
    const declared = {
      tool: normalizeTool(input && input.toolName),
      command: null,
      path: null,
      hosts: [],
    };
    return {
      decision: "deny",
      layer: "normalize",
      rule: "governance.error",
      reason: `policy check failed (${err && err.message ? err.message : err})`,
      actionHash: actionHash(declared),
      declared,
    };
  }
}

/** @param {Parameters<typeof evaluate>[0]} input */
function evaluateUnsafe(input) {
  const { toolName, rawInput, worktreePath, policy } = input;
  const builtin = input.builtin || { decision: "allow", rule: null, reason: "" };
  const sessionAllows = input.sessionAllows || new Set();

  /** @type {Call} */
  let declared;
  try {
    declared = normalizeCall(toolName, rawInput, worktreePath);
  } catch (err) {
    const code = (err && /** @type {NodeJS.ErrnoException} */ (err).code) || "error";
    declared = {
      tool: normalizeTool(toolName),
      command: null,
      path: null,
      hosts: [],
    };
    return {
      decision: "deny",
      layer: "normalize",
      rule: "path.canonicalize",
      reason: `could not canonicalize the write path (${code})`,
      actionHash: actionHash(declared),
      declared,
    };
  }
  const hash = actionHash(declared);
  const out = (decision, layer, rule, reason) => ({
    decision,
    layer,
    rule,
    reason,
    actionHash: hash,
    declared,
  });

  if (builtin.decision === "deny") {
    return out("deny", "builtin", builtin.rule, builtin.reason);
  }
  if (MATRIX_SKIP.has(declared.tool)) {
    return out("ask", "builtin", builtin.rule, builtin.reason);
  }

  const rules = [
    ...((policy && Array.isArray(policy.rules) && policy.rules) || []),
    ...(Array.isArray(input.mcpRules) ? input.mcpRules : []),
  ];
  const hits = matchingRules(
    rules,
    declared,
    worktreePath,
    WRITE_TOOLS.has(String(toolName || "")),
    rawInput && typeof rawInput === "object" ? /** @type {Record<string, unknown>} */ (rawInput) : {},
  );
  for (const action of SEVERITY) {
    if (action === "allow") break;
    const hit = hits.find((r) => r.action === action);
    if (!hit) continue;
    if (hit.source === "mcp") {
      return out(
        action === "ask" ? "ask" : "deny",
        `mcp.${action}`,
        ruleLabel(hit),
        action === "ask" ? "MCP tool set to ask" : "MCP tool denied in Settings",
      );
    }
    return out(
      action === "ask" ? "ask" : "deny",
      `profile.${action}`,
      ruleLabel(hit),
      action === "block"
        ? "blocked by profile (never allowed)"
        : action === "deny"
          ? "denied by profile"
          : "profile requires confirmation",
    );
  }
  if (sessionAllows.has(hash)) {
    return out("allow", "session", null, "allowed for this session");
  }
  // A specific rule names the call better than a blanket toggle (#1721).
  const named =
    hits.find((r) => r.action === "allow" && r.source !== "autoApprove") ||
    hits.find((r) => r.action === "allow");
  if (named) {
    if (named.source === "autoApprove") {
      return out("allow", "autoApprove", ruleLabel(named), `auto-approved by: ${named.label}`);
    }
    return named.source === "mcp"
      ? out("allow", "mcp.allow", ruleLabel(named), "MCP tool allowed in Settings")
      : out("allow", "profile.allow", ruleLabel(named), "allowed by profile");
  }
  if (builtin.decision === "ask") {
    return out("ask", "builtin", builtin.rule, builtin.reason);
  }
  const fallback = policy && policy.defaultAction === "allow" ? "allow" : "ask";
  return out(fallback, "profile.default", null, `profile default: ${fallback}`);
}

/**
 * Whether Full access (bypassPermissions) answers this ask itself (#1854):
 * the asks nobody wrote down, i.e. the profile.default fallback and builtin
 * guardrail asks. Explicit profile/MCP ask rules and questions (MATRIX_SKIP)
 * still reach the user; denies never get here.
 * @param {{ decision: string, layer: string, declared: { tool: string } }} ev - evaluate()'s result
 */
function fullAccessAllows(ev) {
  if (ev.decision !== "ask") return false;
  if (ev.layer === "profile.default") return true;
  return ev.layer === "builtin" && !MATRIX_SKIP.has(ev.declared.tool);
}

/**
 * Network rules for one host, most severe first (#803 proxy). null when no
 * rule matches: the proxy then lets it through, same as an unmatched call.
 * @param {{ rules?: Array<{ kind: string, match: string, action: string }> } | null | undefined} policy
 * @param {string} host
 * @returns {{ action: string, rule: string } | null}
 */
function networkVerdict(policy, host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  const hits = ((policy && policy.rules) || []).filter(
    (r) => r.kind === "network" && globRe(r.match).test(h),
  );
  for (const action of SEVERITY) {
    const hit = hits.find((r) => r.action === action);
    if (hit) return { action, rule: ruleLabel(hit) };
  }
  return null;
}

const MCP_SERVER_RE = /^[a-z0-9-]+$/;
const MCP_TOOL_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Per-tool MCP rules (#1720) as `tool` rules on `mcp__<server>__<tool>`,
 * the name every provider reports the call under. Same matrix, same
 * deny-wins evaluation; `source` only changes the layer label. Names are
 * re-checked so a stored `*` can never become a wildcard.
 * @param {unknown} servers - settings.mcpServers
 * @returns {Array<{ kind: "tool", match: string, action: string, source: "mcp" }>}
 */
function mcpToolRules(servers) {
  const out = [];
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || s.enabled === false || !MCP_SERVER_RE.test(String(s.name || ""))) continue;
    const rules = s.toolRules && typeof s.toolRules === "object" ? s.toolRules : {};
    for (const [tool, action] of Object.entries(rules)) {
      if (!MCP_TOOL_RE.test(tool) || !["allow", "ask", "deny"].includes(action)) continue;
      out.push({ kind: "tool", match: `mcp__${s.name}__${tool}`, action, source: "mcp" });
    }
  }
  return out;
}

/**
 * Policy of the profile a thread runs under, or null, plus the per-tool MCP
 * rules that apply to every thread. A deleted or unknown profile id is
 * "no profile", never a store error.
 * @param {{ getThread: Function, getSettings: Function }} store
 * @param {string} threadId
 */
function threadPolicy(store, threadId) {
  const settings = store.getSettings() || {};
  const thread = store.getThread(threadId);
  // Auto-approve toggles (#1721) ride the same sourced-rule list as MCP
  // rules, so every evaluate() call site picks them up unchanged. Read live:
  // a toggle flipped mid-run applies to the next tool call.
  const mcpRules = [
    ...mcpToolRules(settings.mcpServers),
    ...autoApproveRules(thread && thread.autoApprove, {
      known: [thread && thread.verifyCommand],
      // "Project" is the run's cwd: the worktree, else the project folder.
      root:
        (thread && thread.worktreePath) ||
        (thread && typeof store.getProject === "function"
          ? (store.getProject(thread.projectId) || {}).path
          : null) ||
        null,
    }),
  ];
  const id = thread && thread.agentProfileId;
  if (!id) return { profileId: null, policy: null, mcpRules };
  const profile = (settings.agentProfiles || []).find((p) => p.id === id);
  if (!profile) return { profileId: null, policy: null, mcpRules };
  return { profileId: profile.id, policy: profile.policy || null, mcpRules };
}

module.exports = {
  MAX_RULES,
  parsePolicy,
  normalizeCommand,
  normalizePath,
  normalizeCall,
  actionHash,
  evaluate,
  fullAccessAllows,
  networkVerdict,
  threadPolicy,
  mcpToolRules,
};
