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
 * Opt out in Settings > Advanced, or with CODER_GUARDRAILS=off. A guardrail that
 * crashes the run is worse than the risk it covers.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

/** @typedef {"allow" | "ask" | "deny"} Decision */
/** @typedef {{ decision: Decision, rule: string | null, reason: string }} Verdict */
/** @typedef {{ rule: string, match: string }} Hit */

const ALLOW = /** @type {Verdict} */ ({
  decision: "allow",
  rule: null,
  reason: "",
});

/** Shared with local hooks and the memory server, including adopted servers. */
function guardrailsSettingPath() {
  return process.env.CODER_GUARDRAILS_PATH ||
    (process.env.CODER_MEMORY_CONFIG
      ? path.join(path.dirname(process.env.CODER_MEMORY_CONFIG), "guardrails-enabled")
      : null);
}

function setGuardrailsEnabled(enabled) {
  const file = guardrailsSettingPath();
  if (file) fs.writeFileSync(file, enabled === false ? "0" : "1", { mode: 0o600 });
}

/** Read the tiny runtime flag per call; never parse the transcript store here. */
function guardrailsEnabled() {
  const v = String(process.env.CODER_GUARDRAILS || "").toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  const file = guardrailsSettingPath();
  try {
    return !file || fs.readFileSync(file, "utf8") !== "0";
  } catch {
    return true;
  }
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
  [/\/guardrails-enabled$/, "protected.guardrails"],
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
    /\bhistory\s+-c\b|\bshred\b|\brm\s+-rf\s+[^\s]*\.git\b/i,
    "shell.covertracks",
    "erasing history or the repo itself",
  ],
];

/** Commands that reach the network; legitimate often enough to ask, not deny. */
const EGRESS_CMDS = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "rsync", "ssh", "telnet",
]);

const LOCAL_HOST =
  /(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)/i;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Prefixes that run a later word as the real command. */
const WRAPPERS = new Set([
  "sudo", "doas", "env", "time", "nohup", "exec", "command", "builtin",
  "nice", "timeout", "xargs", "!",
]);
/** A heredoc on this line is piped into a shell, so its body is code. */
const SHELL_LINE = /(^|[\s|;&(/])(ba|z|da|k)?sh(?=[\s;|&)]|$)/;

const base = (w) => w.slice(w.lastIndexOf("/") + 1);

/**
 * Split a shell command into simple commands (word lists, quotes removed)
 * so policy can tell what runs from text that merely mentions it (#1840).
 * Heredoc bodies are data unless the line feeds a shell. A quoted string
 * stays one word; only `sh -c` / `eval` bodies and "$(...)" are parsed as
 * code.
 * @param {string} cmd
 * @returns {string[][]}
 */
function simpleCommands(cmd, depth = 0) {
  /** @type {string[][]} */
  const out = [];
  /** @type {{ delim: string, keep: boolean }[]} */
  const heredocs = [];
  /** @type {string[]} */
  let seg = [];
  /** @type {string | null} */
  let word = null;
  // `sh <<< 'cmd'`: the here-string word is a script for the shell.
  let hereShell = false;
  const endWord = () => {
    if (word === null) return;
    seg.push(word);
    if (hereShell) nested(word);
    hereShell = false;
    word = null;
  };
  const endSeg = () => {
    endWord();
    if (seg.length) out.push(seg);
    seg = [];
  };
  const nested = (s) => {
    if (depth < 4) out.push(...simpleCommands(s, depth + 1));
  };
  const add = (ch) => {
    word = (word ?? "") + ch;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "\n") {
      endSeg();
      i++;
      for (const h of heredocs.splice(0)) {
        let body = "";
        while (i < cmd.length) {
          const nl = cmd.indexOf("\n", i);
          const end = nl < 0 ? cmd.length : nl;
          const line = cmd.slice(i, end);
          i = end + 1;
          if (line.trim() === h.delim) break;
          body += `${line}\n`;
        }
        if (h.keep) nested(body);
      }
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "#" && word === null) {
      while (i < cmd.length && cmd[i] !== "\n") i++;
    } else if (c === "\\") {
      if (cmd[i + 1] !== "\n") add(cmd[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      add(cmd.slice(i + 1, end < 0 ? cmd.length : end));
      i = end < 0 ? cmd.length : end + 1;
    } else if (c === '"') {
      let s = "";
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < cmd.length) i++;
        s += cmd[i++];
      }
      i++;
      add(s);
      if (s.includes("$(") || s.includes("`")) nested(s);
    } else if (c === "$" && cmd[i + 1] === "(") {
      endSeg();
      i += 2;
    } else if (";&|()`".includes(c)) {
      endSeg();
      i++;
    } else if (cmd.startsWith("<<<", i)) {
      endWord();
      i += 3;
      hereShell = seg.length > 0 && SHELLS.has(commandChain(seg).names.at(-1));
    } else if (c === "<" && cmd[i + 1] === "<") {
      endWord();
      i += 2;
      if (cmd[i] === "-") i++;
      while (cmd[i] === " " || cmd[i] === "\t") i++;
      let delim = "";
      while (i < cmd.length && !/[\s;&|()<>]/.test(cmd[i])) {
        if (!`'"\\`.includes(cmd[i])) delim += cmd[i];
        i++;
      }
      const ls = cmd.lastIndexOf("\n", i - 1) + 1;
      const le = cmd.indexOf("\n", i);
      const line = cmd.slice(ls, le < 0 ? cmd.length : le);
      if (delim) heredocs.push({ delim, keep: SHELL_LINE.test(line) });
    } else if (c === "<" || c === ">") {
      endWord();
      i++;
    } else {
      add(c);
      i++;
    }
  }
  endSeg();
  for (const s of out.slice()) {
    const { names, args } = commandChain(s);
    const name = names[names.length - 1];
    // eval runs text it builds, so any of its words may be the command:
    // `eval "$(echo curl x)"` runs curl. Every suffix is a candidate.
    if (name === "eval" && depth < 4) {
      for (const n of simpleCommands(args.join(" "), depth + 1)) {
        for (let k = 0; k < n.length; k++) out.push(n.slice(k));
      }
    }
    if (!SHELLS.has(name)) continue;
    const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (at >= 0 && args[at + 1]) nested(args[at + 1]);
  }
  return out;
}

/**
 * The commands a simple command runs: wrappers (sudo, env, xargs, ...) then
 * the real one, plus the real one's arguments.
 * ponytail: wrapper flags are skipped by shape (-x, digits), so `sudo -u bob
 * cmd` names `bob`; fine while every wrapper chain with sudo is a deny anyway.
 * @param {string[]} seg
 */
function commandChain(seg) {
  /** @type {string[]} */
  const names = [];
  for (let i = 0; i < seg.length; i++) {
    const w = seg[i];
    if (/^[A-Za-z_]\w*=/.test(w)) continue;
    if (names.length && (w.startsWith("-") || /^\d/.test(w))) continue;
    names.push(base(w));
    if (!WRAPPERS.has(base(w))) return { names, args: seg.slice(i + 1) };
  }
  return { names, args: [] };
}

/** `rm -r` targets, as written on the command line. */
function rmTargets(segs) {
  const out = [];
  for (const seg of segs) {
    const { names, args } = commandChain(seg);
    if (names[names.length - 1] !== "rm") continue;
    if (!args.some((a) => /^-[\w-]*[rR]/.test(a))) continue;
    for (const a of args) if (a && !a.startsWith("-")) out.push(a);
  }
  return out;
}

/**
 * Words that name a file. A multi-word string (prose, a script body) only
 * offers its rooted pieces (`.env`, `~/x`, `/x`); a bare word with no path
 * shape counts only if it is a private-key name or a real file, so the word
 * `credentials` or a field like `self.after.key` is not a path (#1840).
 */
function pathLike(tok, word, resolved) {
  if (/^[./~]/.test(tok)) return true;
  if (/\s/.test(word)) return false;
  return tok.includes("/") || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(tok) ||
    fs.existsSync(resolved);
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

  const segs = simpleCommands(cmd);
  const chains = segs.map(commandChain);

  if (chains.some((c) => c.names.some((n) => n === "sudo" || n === "doas"))) {
    return {
      decision: "deny",
      rule: "shell.sudo",
      reason: "privilege escalation is never part of a code task",
    };
  }

  // rm -rf outside the worktree. Bare `/`, `~` and `$HOME` are always out.
  for (const target of rmTargets(segs)) {
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
  for (const word of segs.flat()) {
    for (const tok of word.split(/[\s;|&()<>"']+/)) {
      if (!tok || tok.startsWith("-")) continue;
      // Keep a trailing slash: `s/a/b.key/` is a sed script, not b.key.
      const resolved =
        resolveTarget(tok, worktreePath) + (tok.endsWith("/") ? "/" : "");
      const hit = matchSecret(resolved);
      if (hit && pathLike(tok, word, resolved)) {
        return {
          decision: "deny",
          rule: hit[0],
          reason: `command touches ${tok} (${hit[1]})`,
        };
      }
    }
  }

  const egress = chains.some(({ names, args }) => {
    const n = names[names.length - 1];
    return EGRESS_CMDS.has(n) ||
      (n === "npm" && args[0] === "publish") ||
      (n === "gh" && (args[0] === "release" || args[0] === "gist"));
  });
  if (egress && !LOCAL_HOST.test(cmd)) {
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
  "StrReplace",
  "write",
  "edit",
  "strreplace",
  "Delete",
  "search_replace",
]);
const READ_TOOLS = new Set([
  "Read",
  "NotebookRead",
  "view",
  "Glob",
  "Grep",
  "read",
  "glob",
  "read_file",
  "list_dir",
  "grep",
]);
const SHELL_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "shell",
  "run_command",
  "Shell",
  "bash",
  "exec_command",
  "run_terminal_command",
  "run_terminal_cmd",
  // Codex app-server item/commandExecution/requestApproval (#1171).
  "command",
  "Command",
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

/**
 * Replace every secret hit in place with its redact form. Not gated on the
 * guardrails toggle: it guards Solenta's own logs (#262 audit), not the agent.
 * @param {string} text
 */
function redactSecrets(text) {
  let s = String(text || "");
  for (const [re, rule] of SECRET_RULES) {
    s = s.replace(new RegExp(re.source, `${re.flags}g`), (m) =>
      rule === "secret.assignment" && PLACEHOLDER.test(m) ? m : redact(m),
    );
  }
  return s;
}

module.exports = {
  redactSecrets,
  WRITE_TOOLS,
  guardrailsEnabled,
  setGuardrailsEnabled,
  classifyTool,
  classifyCommand,
  simpleCommands,
  commandChain,
  scanInjection,
  scanSecrets,
  SECRET_RULES,
  PLACEHOLDER,
  insideRoot,
  PROTECTED_WRITE,
  SECRET_PATH,
};
