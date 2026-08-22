"use strict";

/**
 * Install-time trust gate (#305).
 *
 * Three surfaces, one policy:
 *   scanSkill()          — SKILL.md about to be written or already on disk
 *   scanMcpServer()      — MCP config about to be enabled
 *   scanPackageInstall() — npm/pip/cargo/etc about to run in an agent shell
 *
 * Trust is reported up front (trusted / caution / blocked). `blocked` refuses
 * the install; `caution` is shown and the user can still proceed. Local,
 * regex-only, no ML, no network. An optional malware feed is a JSON file of
 * package names: the bundled seed plus userData/malware-packages.json.
 *
 * Escape hatch: CODER_GUARDRAILS=off. Nothing here throws.
 */

const fs = require("node:fs");
const path = require("node:path");
const { scanInjection, scanSecrets, guardrailsEnabled } = require("./guardrails.js");

/** @typedef {"trusted" | "caution" | "blocked"} TrustLevel */
/** @typedef {"off" | "blocklist" | "ask"} PackageInstallScan */
/** @typedef {{ severity: "caution" | "blocked", rule: string, reason: string }} TrustFinding */
/** @typedef {{ level: TrustLevel, findings: TrustFinding[] }} TrustReport */

const LEVEL_RANK = { trusted: 0, caution: 1, blocked: 2 };

/** @returns {TrustReport} */
function trusted() {
  return { level: "trusted", findings: [] };
}

/**
 * @param {TrustFinding[]} findings
 * @returns {TrustReport}
 */
function report(findings) {
  if (!findings.length) return trusted();
  const level = findings.some((f) => f.severity === "blocked")
    ? "blocked"
    : "caution";
  return { level, findings };
}

/**
 * @param {TrustReport | null | undefined} a
 * @param {TrustReport | null | undefined} b
 * @returns {TrustReport}
 */
function worseTrust(a, b) {
  if (!a) return b || trusted();
  if (!b) return a;
  return LEVEL_RANK[a.level] >= LEVEL_RANK[b.level] ? a : b;
}

// ---------------------------------------------------------------------------
// Malware package feed (bundled seed + optional overlay)
// ---------------------------------------------------------------------------

/** @type {Set<string>} */
const bundledNames = loadNameSet(
  path.join(__dirname, "malware-packages.json"),
);

/** @type {string | null} */
let overlayPath = null;
/** @type {{ at: number, names: Set<string> }} */
let overlayCache = { at: 0, names: new Set() };
const OVERLAY_TTL_MS = 60_000;

/** @type {string[]} */
let testExtra = [];

/**
 * Point at userData/malware-packages.json. Missing/junk files are ignored.
 * @param {string | null | undefined} filePath
 */
function setMalwareOverlayPath(filePath) {
  overlayPath = typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
  overlayCache = { at: 0, names: new Set() };
}

/**
 * Extra names for tests. Replaces the previous extra set; pass [] to clear.
 * @param {unknown} names
 */
function setMalwareOverlayForTests(names) {
  testExtra = Array.isArray(names)
    ? names
        .filter((n) => typeof n === "string" && n.trim())
        .map((n) => String(n).trim().toLowerCase())
    : [];
}

/** @param {string} filePath @returns {Set<string>} */
function loadNameSet(filePath) {
  const out = new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return out;
    for (const n of parsed) {
      if (typeof n === "string" && n.trim()) out.add(n.trim().toLowerCase());
    }
  } catch {
    // bundled seed missing in a broken install: fail open
  }
  return out;
}

/** @returns {Set<string>} */
function malwareNames() {
  const out = new Set(bundledNames);
  for (const n of testExtra) out.add(n);
  if (!overlayPath) return out;
  const now = Date.now();
  if (now - overlayCache.at > OVERLAY_TTL_MS) {
    overlayCache = { at: now, names: loadNameSet(overlayPath) };
  }
  for (const n of overlayCache.names) out.add(n);
  return out;
}

// ---------------------------------------------------------------------------
// Package-install parsing
// ---------------------------------------------------------------------------

const INSTALL_LEAD =
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|dlx)\b|\b(npx|bunx)\b|\b(pip3?|uv|poetry)\s+(install|add)\b|\bcargo\s+add\b|\bgem\s+install\b|\bgo\s+(get|install)\b/i;

const REMOTE_SPEC = /^(git\+|https?:\/\/|github:|gist:|gitlab:|bitbucket:)/i;

/**
 * Drop a trailing @version, keep @scope/name.
 * @param {string} spec
 */
function stripVersion(spec) {
  const s = String(spec || "").replace(/^['"]|['"]$/g, "");
  if (!s) return "";
  if (s.startsWith("@")) {
    const m = s.match(/^(@[^@/\s]+\/[^@/\s]+)(?:@.*)?$/);
    return (m ? m[1] : s).toLowerCase();
  }
  return s.replace(/@.*$/, "").toLowerCase();
}

/**
 * Package specs after an install verb. `matched` is true even for a bare
 * `npm install` (lockfile install, no extra names).
 * @param {string} command
 * @returns {{ matched: boolean, specs: string[] }}
 */
function extractInstallSpecs(command) {
  const cmd = String(command || "");
  const specs = [];
  let matched = false;
  const re = new RegExp(INSTALL_LEAD.source, "gi");
  let m;
  while ((m = re.exec(cmd))) {
    matched = true;
    const rest = cmd.slice(m.index + m[0].length);
    const stop = rest.search(/[;|&\n]/);
    const argStr = stop === -1 ? rest : rest.slice(0, stop);
    for (const raw of argStr.split(/\s+/)) {
      if (!raw) continue;
      if (raw.startsWith("-")) continue;
      if (raw === "." || raw === "./" || raw.startsWith("./") || raw.startsWith("/")) {
        continue;
      }
      specs.push(raw.replace(/^['"]|['"]$/g, ""));
    }
  }
  return { matched, specs };
}

function isPackageInstallCommand(command) {
  return extractInstallSpecs(command).matched;
}

/**
 * @param {string} command
 * @returns {TrustReport}
 */
function scanPackageInstall(command) {
  if (!guardrailsEnabled()) return trusted();
  const { matched, specs } = extractInstallSpecs(command);
  if (!matched) return trusted();
  const findings = [];
  const blocked = malwareNames();
  for (const spec of specs) {
    if (REMOTE_SPEC.test(spec)) {
      findings.push({
        severity: "caution",
        rule: "install.remotespec",
        reason: `install from ${spec}`,
      });
      continue;
    }
    const name = stripVersion(spec);
    if (!name) continue;
    if (blocked.has(name)) {
      findings.push({
        severity: "blocked",
        rule: "install.malware",
        reason: `known-malicious package "${name}"`,
      });
    }
  }
  return report(findings);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const SKILL_RULES = [
  [
    /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i,
    "skill.curlpipe",
    "blocked",
    "pipe-to-shell executes unreviewed remote code",
  ],
  [
    /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b/i,
    "skill.curlpipe",
    "blocked",
    "pipe-to-interpreter executes unreviewed remote code",
  ],
  [
    /\b(CODER_GUARDRAILS\s*=\s*off|--dangerously-skip-permissions|bypassPermissions)\b/,
    "skill.bypass",
    "blocked",
    "skill tries to disable Solenta guardrails",
  ],
  [
    /\b(always|every (turn|request|prompt|message)|unconditionally)\b[^.\n]{0,60}\b(invoke|apply|use|run) this skill\b/i,
    "skill.autoinvoke",
    "caution",
    "skill asks to run on every request",
  ],
  [
    /\b(write|append|overwrite)\b[^.\n]{0,50}\b(\.claude\/(settings|hooks)|CLAUDE\.md|AGENTS\.md)\b/i,
    "skill.persist",
    "caution",
    "skill asks to rewrite harness config",
  ],
];

/**
 * @param {string} text
 * @returns {TrustReport}
 */
function scanSkillText(text) {
  if (!guardrailsEnabled()) return trusted();
  const s = String(text || "");
  if (!s.trim()) return trusted();
  /** @type {TrustFinding[]} */
  const findings = [];

  const inj = scanInjection(s);
  for (const h of inj.hits) {
    findings.push({
      severity: "blocked",
      rule: h.rule,
      reason: `prompt-injection pattern "${h.match}"`,
    });
  }

  const secrets = scanSecrets(s);
  for (const h of secrets.hits) {
    findings.push({
      severity: "blocked",
      rule: h.rule,
      reason: `embedded secret (${h.rule})`,
    });
  }

  for (const [re, rule, severity, reason] of SKILL_RULES) {
    if (re.test(s)) {
      findings.push({
        severity: /** @type {"caution" | "blocked"} */ (severity),
        rule,
        reason,
      });
    }
  }

  const pkg = scanPackageInstall(s);
  for (const f of pkg.findings) {
    if (f.severity === "blocked") findings.push(f);
  }

  return report(findings);
}

/**
 * @param {{ name?: unknown, description?: unknown, body?: unknown }} [input]
 * @returns {TrustReport}
 */
function scanSkill(input) {
  const name = input && typeof input.name === "string" ? input.name : "";
  const description =
    input && typeof input.description === "string" ? input.description : "";
  const body = input && typeof input.body === "string" ? input.body : "";
  return scanSkillText(`${name}\n${description}\n${body}`);
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i;

/**
 * @param {{ name?: unknown, url?: unknown }} [entry]
 * @returns {TrustReport}
 */
function scanMcpServer(entry) {
  if (!guardrailsEnabled()) return trusted();
  /** @type {TrustFinding[]} */
  const findings = [];
  const name = entry && typeof entry.name === "string" ? entry.name : "";
  const url = entry && typeof entry.url === "string" ? entry.url.trim() : "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    findings.push({
      severity: "blocked",
      rule: "mcp.url",
      reason: "URL is not a valid http(s) address",
    });
    return report(findings);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    findings.push({
      severity: "blocked",
      rule: "mcp.scheme",
      reason: `scheme ${parsed.protocol} is not http(s)`,
    });
  }
  if (parsed.username || parsed.password) {
    findings.push({
      severity: "blocked",
      rule: "mcp.userinfo",
      reason: "credentials in the URL",
    });
  }
  if (/(token|secret|password|api[_-]?key)=/i.test(parsed.search)) {
    findings.push({
      severity: "blocked",
      rule: "mcp.secretquery",
      reason: "secret-shaped query string",
    });
  }
  const host = parsed.hostname || "";
  const local = LOCAL_HOST.test(host);
  if (parsed.protocol === "http:" && !local) {
    findings.push({
      severity: "blocked",
      rule: "mcp.plaintext",
      reason: "remote MCP over http is interceptable",
    });
  } else if (!local && parsed.protocol === "https:") {
    findings.push({
      severity: "caution",
      rule: "mcp.remote",
      reason: "remote server sees agent context",
    });
  }

  const inj = scanInjection(`${name}\n${url}`);
  for (const h of inj.hits) {
    findings.push({
      severity: "blocked",
      rule: h.rule,
      reason: `injection pattern "${h.match}"`,
    });
  }
  return report(findings);
}

/**
 * First blocked finding, or the first finding, for error copy.
 * @param {TrustReport} trust
 * @returns {TrustFinding | null}
 */
function primaryFinding(trust) {
  if (!trust || !trust.findings || !trust.findings.length) return null;
  return (
    trust.findings.find((f) => f.severity === "blocked") || trust.findings[0]
  );
}

/**
 * @param {TrustReport} trust
 * @param {string} what
 */
function blockedError(trust, what) {
  const first = primaryFinding(trust);
  const rule = first ? first.rule : "policy";
  const reason = first ? first.reason : "blocked";
  return new Error(
    `Blocked by Solenta install scan (${rule}): ${reason}. ${what}`,
  );
}

module.exports = {
  trusted,
  report,
  worseTrust,
  scanSkill,
  scanSkillText,
  scanMcpServer,
  scanPackageInstall,
  isPackageInstallCommand,
  extractInstallSpecs,
  setMalwareOverlayPath,
  setMalwareOverlayForTests,
  primaryFinding,
  blockedError,
};
