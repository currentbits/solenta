"use strict";

/**
 * Orchestrator-owned guardrails (#409).
 *
 * The agent cannot be trusted to police itself: a prompt injection that lands
 * in its context can rewrite the very hooks meant to stop it. Solenta is the
 * one layer that sits outside the agent, so policy lives here — pure, local,
 * no ML, no network.
 *
 * Three independent checks, each a plain function so every caller (runner
 * permission seam, memory server, outbound git paths) shares one policy:
 *
 *   classifyTool()  — allow / ask / deny a tool call before it runs
 *   scanInjection() — untrusted inbound text about to enter an agent context
 *   scanSecrets()   — outbound text about to leave the machine
 *
 * Escape hatch: CODER_GUARDRAILS=off. Nothing here throws; a guardrail that
 * crashes the run is worse than the risk it covers.
 */

const path = require("node:path");
const os = require("node:os");

/** @typedef {"allow" | "ask" | "deny"} Decision */
/** @typedef {{ decision: Decision, rule: string | null, reason: string }} Verdict */
/** @typedef {{ rule: string, match: string }} Hit */

const ALLOW = /** @type {Verdict} */ ({
  decision: "allow",
  rule: null,
  reason: "",
});

/** Env kill switch, read per call so a relaunch isn't needed to flip it. */
function guardrailsEnabled() {
  const v = String(process.env.CODER_GUARDRAILS || "").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------

/**
 * Config the agent must never rewrite. Hooks and settings are the harness's
 * own immune system; CI configs and git hooks are code that runs later with
 * more privilege than the agent has now. Matched on the POSIX-ish path with a
 * leading slash so `a/.claude/hooks/x` and `/.claude/hooks/x` both hit.
 */
const PROTECTED_WRITE = [
  [/\/\.claude\/hooks\//, "protected.hooks"],
  [/\/\.claude\/settings(\.[\w-]+)?\.json$/, "protected.settings"],
  [/\/\.claude\/agents\//, "protected.agents"],
  [/\/\.mcp\.json$/, "protected.mcp"],
  [/\/\.github\/workflows\//, "protected.ci"],
  [/\/\.git\/hooks\//, "protected.githooks"],
  [/\/\.git\/config$/, "protected.gitconfig"],
  [/\/coder-store\.json$/, "protected.store"],
];

/**
 * Credential material. Reading it is how an injected agent turns a code task
 * into an exfiltration. `.env.example` and friends are templates, not secrets.
 */
const SECRET_PATH = [
  [/\/\.env(\.[\w-]+)?$/, "secret.env"],
  [/\.(pem|key|p12|pfx|jks|keystore)$/, "secret.keyfile"],
  [/\/\.ssh\//, "secret.ssh"],
  [/\/\.aws\//, "secret.aws"],
  [/\/\.gnupg\//, "secret.gnupg"],
  [/\/\.(npmrc|netrc|pypirc|docker\/config\.json)$/, "secret.rcfile"],
  [/\/id_(rsa|dsa|ecdsa|ed25519)$/, "secret.privatekey"],
  [/\/(credentials|secrets)(\.(json|yml|yaml|ya?ml|toml|ini))?$/, "secret.credentials"],
];

const SECRET_PATH_ALLOW = /\.(example|sample|template|dist)$|\/\.env\.example$/;

/** Normalise to forward slashes with a guaranteed leading slash. */
function norm(p) {
  const s = String(p || "").replace(/\\/g, "/");
  return s.startsWith("/") ? s : `/${s}`;
}

/**
 * True when `target` is inside `root`. Both are resolved first so `..` walks
 * and symlink-free relative paths can't slip past.
 * @param {string} target
 * @param {string | null | undefined} root
 */
function insideRoot(target, root) {
  if (!root) return true; // no worktree known: nothing to be outside of
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * @param {string} filePath
 * @param {string | null | undefined} worktreePath
 */
function resolveTarget(filePath, worktreePath) {
  const raw = String(filePath || "");
  const expanded = raw.startsWith("~")
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(worktreePath || process.cwd(), expanded);
}

/** @param {string} resolved @returns {[string, string] | null} rule + reason */
function matchProtected(resolved) {
  const p = norm(resolved);
  for (const [re, rule] of PROTECTED_WRITE) {
    if (re.test(p)) return [rule, "Solenta owns this config; agents cannot write it"];
  }
  return null;
}

/** @param {string} resolved @returns {[string, string] | null} */
function matchSecret(resolved) {
  const p = norm(resolved);
  if (SECRET_PATH_ALLOW.test(p)) return null;
  for (const [re, rule] of SECRET_PATH) {
    if (re.test(p)) return [rule, "credential material"];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shell policy
// ---------------------------------------------------------------------------

const SHELL_DENY = [
  [
    /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i,
    "shell.curlpipe",
    "pipe-to-shell executes unreviewed remote code",
  ],
  [
    /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b/i,
    "shell.curlpipe",
    "pipe-to-interpreter executes unreviewed remote code",
  ],
  [
    /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i,
    "shell.forcepush",
    "force-push destroys remote history",
  ],
  [
    /\bsudo\b/i,
    "shell.sudo",
    "privilege escalation is never part of a code task",
  ],
  [
    /\bhistory\s+-c\b|\bshred\b|\brm\s+-rf\s+[^\s]*\.git\b/i,
    "shell.covertracks",
    "erasing history or the repo itself",
  ],
];

/** Commands that reach the network; legitimate often enough to ask, not deny. */
const SHELL_EGRESS =
  /\b(curl|wget|nc|ncat|netcat|scp|sftp|rsync|ssh|telnet)\b|\bnpm\s+publish\b|\bgh\s+(release|gist)\b/i;

const LOCAL_HOST =
  /(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)/i;

/** `rm -rf` targets, as written on the command line. */
function rmTargets(command) {
  const out = [];
  const re = /\brm\s+(?:-[\w-]+\s+)*-[\w-]*[rR][\w-]*[fF]?[\w-]*\s+([^\n;&|]+)/g;
  let m;
  while ((m = re.exec(command))) {
    for (const tok of m[1].split(/\s+/)) {
      const t = tok.replace(/^["']|["']$/g, "");
      if (t && !t.startsWith("-")) out.push(t);
    }
  }
  return out;
}

/**
 * @param {string} command
 * @param {string | null | undefined} worktreePath
 * @returns {Verdict}
 */
function classifyCommand(command, worktreePath) {
  const cmd = String(command || "");

  for (const [re, rule, reason] of SHELL_DENY) {
    if (re.test(cmd)) return { decision: "deny", rule, reason };
  }

  // rm -rf outside the worktree. Bare `/`, `~` and `$HOME` are always out.
  for (const target of rmTargets(cmd)) {
    if (/^(\/|~\/?|\$HOME\/?|\*)$/.test(target)) {
      return {
        decision: "deny",
        rule: "shell.rmroot",
        reason: `rm -rf ${target} is unrecoverable`,
      };
    }
    if (target.includes("$") || target.includes("`")) continue; // unexpandable
    if (!insideRoot(resolveTarget(target, worktreePath), worktreePath)) {
      return {
        decision: "deny",
        rule: "shell.rmoutside",
        reason: `rm -rf targets ${target}, outside the worktree`,
      };
    }
  }

  // Secret file named anywhere in the command (cat .env, scp id_rsa, ...).
  for (const tok of cmd.split(/[\s;|&()<>"']+/)) {
    if (!tok || tok.startsWith("-")) continue;
    const hit = matchSecret(resolveTarget(tok, worktreePath));
    if (hit) {
      return {
        decision: "deny",
        rule: hit[0],
        reason: `command touches ${tok} (${hit[1]})`,
      };
    }
  }

  if (SHELL_EGRESS.test(cmd) && !LOCAL_HOST.test(cmd)) {
    return {
      decision: "ask",
      rule: "shell.egress",
      reason: "command reaches the network",
    };
  }

  return ALLOW;
}

// ---------------------------------------------------------------------------
// Tool policy
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "str_replace_editor",
  "apply_patch",
  "search_replace",
]);
const READ_TOOLS = new Set([
  "Read",
  "NotebookRead",
  "view",
  "Glob",
  "Grep",
  "read_file",
  "list_dir",
  "grep",
]);
const SHELL_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "shell",
  "run_command",
  "run_terminal_command",
  "run_terminal_cmd",
]);

/** First string field that looks like a path. */
function toolPath(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["file_path", "path", "notebook_path", "filePath"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  return "";
}

/** First string field that looks like a command. */
function toolCommand(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "cmd", "script"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  return "";
}

/**
 * The spawn-time hook pack, evaluated per tool call.
 *
 * "ask" means fall through to the normal Solenta permission prompt — the user
 * still decides. "deny" is answered without ever reaching the user, because
 * the whole point is that an injected agent shouldn't get to social-engineer
 * a yes.
 *
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {unknown} [opts.input]
 * @param {string | null} [opts.worktreePath]
 * @returns {Verdict}
 */
function classifyTool({ toolName, input, worktreePath }) {
  if (!guardrailsEnabled()) return ALLOW;
  try {
    const name = String(toolName || "");
    const inp = input && typeof input === "object" ? input : {};

    if (SHELL_TOOLS.has(name)) {
      return classifyCommand(toolCommand(inp), worktreePath);
    }

    const raw = toolPath(inp);
    if (!raw) return ALLOW;
    const resolved = resolveTarget(raw, worktreePath);

    if (WRITE_TOOLS.has(name)) {
      const prot = matchProtected(resolved);
      if (prot) {
        return { decision: "deny", rule: prot[0], reason: prot[1] };
      }
      const sec = matchSecret(resolved);
      if (sec) {
        return {
          decision: "deny",
          rule: sec[0],
          reason: `write to ${sec[1]}`,
        };
      }
      if (!insideRoot(resolved, worktreePath)) {
        return {
          decision: "ask",
          rule: "write.outside",
          reason: "write lands outside the worktree",
        };
      }
      return ALLOW;
    }

    if (READ_TOOLS.has(name)) {
      const sec = matchSecret(resolved);
      if (sec) {
        return {
          decision: "deny",
          rule: sec[0],
          reason: `read of ${sec[1]}`,
        };
      }
    }

    return ALLOW;
  } catch {
    // ponytail: fail open. A guardrail bug must not brick every tool call.
    return ALLOW;
  }
}

// ---------------------------------------------------------------------------
// Injection scanning (inbound: issue bodies, memory entries, rule files)
// ---------------------------------------------------------------------------

const INJECTION = [
  [
    /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(instruction|prompt|rule|direction)/i,
    "injection.override",
  ],
  [
    /\b(you are now|from now on you|new instructions?:|your real (task|instruction))/i,
    "injection.reroleplay",
  ],
  [/<\/?(system|system-reminder|important_instructions)\b/i, "injection.fakesystem"],
  [
    /\b(do not|don'?t|never)\b[^.\n]{0,30}\b(tell|inform|mention|show|reveal)\b[^.\n]{0,20}\b(the )?(user|human|owner)/i,
    "injection.concealment",
  ],
  [
    /\b(send|post|upload|exfiltrate|leak|forward)\b[^.\n]{0,40}(https?:\/\/|@[\w.-]+\.\w{2,})/i,
    "injection.exfil",
  ],
  [
    /\b(cat|read|print|dump|open)\b[^.\n]{0,30}(\.env\b|id_rsa|\.ssh\b|credentials\b|api[_ -]?key)/i,
    "injection.credharvest",
  ],
  [/[​-‏‪-‮⁦-⁩﻿]/, "injection.hiddenchars"],
  [
    /<!--[\s\S]{0,400}?\b(ignore|instruction|execute|run this|you must)\b/i,
    "injection.hiddencomment",
  ],
];

/**
 * Scan untrusted text that is about to enter an agent's context.
 *
 * Deliberately regex-only and deliberately noisy-side: a hit annotates the
 * content ("this came from outside, here's what tripped") rather than
 * silently dropping it. Callers decide whether to block or flag.
 *
 * @param {string} text
 * @returns {{ hits: Hit[], clean: boolean }}
 */
function scanInjection(text) {
  const s = String(text || "");
  /** @type {Hit[]} */
  const hits = [];
  if (!guardrailsEnabled() || !s) return { hits, clean: true };
  for (const [re, rule] of INJECTION) {
    const m = s.match(re);
    if (m) hits.push({ rule, match: excerpt(m[0]) });
  }
  return { hits, clean: hits.length === 0 };
}

function excerpt(s) {
  const one = String(s).replace(/[​-‏‪-‮⁦-⁩﻿]/g, "·").replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 120)}…` : one;
}

// ---------------------------------------------------------------------------
// Secret scanning (outbound: diffs, commit messages, PR bodies)
// ---------------------------------------------------------------------------

const SECRET_RULES = [
  [/\bAKIA[0-9A-Z]{16}\b/, "secret.aws-key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, "secret.github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, "secret.github-pat"],
  [/\bsk-ant-[A-Za-z0-9_-]{24,}\b/, "secret.anthropic-key"],
  [/\bsk-(?!ant-)[A-Za-z0-9]{32,}\b/, "secret.openai-key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, "secret.slack-token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "secret.google-key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "secret.private-key"],
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    "secret.jwt",
  ],
  [
    /\b(api[_-]?key|secret|token|password|passwd|access[_-]?key)\s*[:=]\s*["'][^"'\s]{16,}["']/i,
    "secret.assignment",
  ],
];

/** Obvious non-secrets that trip the generic assignment rule. */
const PLACEHOLDER =
  /(x{6,}|\.{3,}|your[_-]?|example|placeholder|changeme|dummy|redacted|<[^>]+>|\$\{|process\.env|os\.environ|REPLACE|TODO|\bnull\b|\*{4,})/i;

/**
 * Scan text about to leave the machine (commit message, PR body, diff).
 *
 * Matches are redacted in the result: a guardrail report that prints the
 * secret has just leaked it into a log.
 *
 * @param {string} text
 * @returns {{ hits: Hit[], clean: boolean }}
 */
function scanSecrets(text) {
  const s = String(text || "");
  /** @type {Hit[]} */
  const hits = [];
  if (!guardrailsEnabled() || !s) return { hits, clean: true };
  for (const [re, rule] of SECRET_RULES) {
    const m = s.match(re);
    if (!m) continue;
    if (rule === "secret.assignment" && PLACEHOLDER.test(m[0])) continue;
    hits.push({ rule, match: redact(m[0]) });
  }
  return { hits, clean: hits.length === 0 };
}

/** Keep enough to recognise the finding, not enough to use it. */
function redact(s) {
  const str = String(s);
  const head = str.slice(0, 8);
  return `${head}…(${str.length} chars)`;
}

module.exports = {
  guardrailsEnabled,
  classifyTool,
  classifyCommand,
  scanInjection,
  scanSecrets,
  insideRoot,
  PROTECTED_WRITE,
  SECRET_PATH,
};
