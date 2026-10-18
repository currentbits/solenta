"use strict";

/**
 * Export a thread as one self-contained, redacted HTML bug report (#394):
 * transcript, tool calls, diffs, environment and agent version, for pasting
 * into a vendor issue tracker instead of a terminal screenshot.
 *
 * Redaction runs on every string that reaches the file: this thread's
 * secret-card values (#289), the guardrail secret shapes, bearer tokens,
 * whole PEM private-key blocks, and the home directory (it names the user).
 * ponytail: the privacy gateway (#295) is not built yet; this reuses the
 * guardrail rules it will share. Point redactor() at it when it lands.
 */

const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { SECRET_RULES, PLACEHOLDER } = require("./guardrails.js");
const threadSecrets = require("./threadSecrets.js");

/** Global copies: guardrails only needs the first hit, the export needs all. */
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "secret.private-key"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "secret.bearer"],
  ...SECRET_RULES.map(([re, rule]) => [new RegExp(re.source, re.flags + "g"), rule]),
];

/** threadSecrets.redact's placeholder. */
const CARD = /\[secret:[A-Z0-9_]+\]/g;

/**
 * @param {string} threadId
 * @param {string} [home]
 */
function redactor(threadId, home = os.homedir()) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @param {unknown} value @returns {string} */
  const text = (value) => {
    const raw = String(value ?? "");
    let s = threadSecrets.redact(threadId, raw);
    if (s !== raw) {
      const n = (s.match(CARD) || []).length - (raw.match(CARD) || []).length;
      counts["secret.request-card"] = (counts["secret.request-card"] || 0) + n;
    }
    for (const [re, rule] of RULES) {
      s = s.replace(re, (m) => {
        if (rule === "secret.assignment" && PLACEHOLDER.test(m)) return m;
        counts[rule] = (counts[rule] || 0) + 1;
        return `[redacted:${rule.replace(/^secret\./, "")}]`;
      });
    }
    return home && home.length > 1 ? s.split(home).join("~") : s;
  };
  return { text, counts };
}

/** @param {string} s */
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {number | null | undefined} ms */
function when(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z" : "";
}

const CSS = `
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:980px;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:2rem 0 .5rem;border-bottom:1px solid #ddd;padding-bottom:.25rem}
table{border-collapse:collapse}td{padding:.15rem 1rem .15rem 0;vertical-align:top}td:first-child{color:#666}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,Menlo,monospace;background:#f6f6f7;padding:.5rem .75rem;border-radius:6px;margin:.25rem 0}
.msg{margin:.75rem 0}.role{font-size:12px;font-weight:600;color:#666}.role time{font-weight:400;margin-left:.5rem}
.user pre{background:#eef4ff}.event{color:#666;font-size:12px;margin:.25rem 0}
details{margin:.35rem 0;border:1px solid #e3e3e6;border-radius:6px;padding:.25rem .5rem}summary{cursor:pointer;font:12px ui-monospace,Menlo,monospace}
.err summary{color:#b3261e}.note{color:#666;font-size:12px}
@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#eee}pre{background:#2c2c2e}.user pre{background:#1f2a3d}details{border-color:#3a3a3c}}
`;

/**
 * Pure: everything it prints goes through the redactor.
 * @param {{
 *   detail: import("../src/shared/ipc").ThreadDetail,
 *   projectName?: string,
 *   env: Record<string, string>,
 *   diffs: Array<{ label: string, patch: string }>,
 *   exportedAt: number,
 *   home?: string,
 * }} input
 * @returns {{ html: string, counts: Record<string, number> }}
 */
function buildThreadReport({ detail, projectName, env, diffs, exportedAt, home }) {
  const { thread, messages, usage } = detail;
  const r = redactor(thread.id, home);
  const t = (/** @type {unknown} */ v) => esc(r.text(v));
  const rows = (/** @type {Array<[string, unknown]>} */ pairs) =>
    pairs
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${t(v)}</td></tr>`)
      .join("");

  const agent = rows([
    ["Provider", thread.provider],
    ["Model", (usage && usage.model) || thread.model],
    ["CLI version", env.agentVersion],
    ["Permission mode", thread.permissionMode],
    ["Reasoning effort", thread.reasoningEffort],
    ["Session", thread.sessionId],
    ["Turns", usage && usage.turns],
    ["Tokens in / out", usage && `${usage.inputTokens} / ${usage.outputTokens}`],
    ["Cost (USD)", usage && usage.costUsd ? usage.costUsd.toFixed(4) : ""],
  ]);
  const environment = rows([
    ["Solenta", env.appVersion],
    ["OS", env.os],
    ["Electron", env.electron],
    ["Node", env.node],
    ["Project", projectName],
    ["Branch", thread.branch],
    ["Base", thread.baseBranch],
    ["Status", thread.status],
    ["Last error", thread.lastError],
  ]);

  const transcript = messages
    .map((m) => {
      if (m.role === "tool" && m.tool) {
        const tool = m.tool;
        const images = tool.images && tool.images.length ? `<p class="note">${tool.images.length} image(s) omitted</p>` : "";
        return `<details class="${tool.isError ? "err" : ""}"><summary>${t(m.text || tool.name)}${tool.isError ? " — error" : ""}</summary>`
          + `<pre>${t(tool.input)}</pre>${tool.output != null ? `<pre>${t(tool.output)}</pre>` : ""}${images}</details>`;
      }
      if (m.role === "event") {
        return m.thinking
          ? `<details><summary>Thinking</summary><pre>${t(m.text)}</pre></details>`
          : `<p class="event">${t(m.text)}</p>`;
      }
      const label = m.role === "user" ? (m.fromThread ? `From thread ${m.fromThread.title}` : "User") : "Assistant";
      return `<div class="msg ${m.role}"><div class="role">${t(label)}<time>${when(m.createdAt)}</time></div><pre>${t(m.text)}</pre></div>`;
    })
    .join("\n");

  const diffHtml = diffs.length
    ? diffs.map((d) => `<details open><summary>${t(d.label)}</summary><pre>${t(d.patch)}</pre></details>`).join("\n")
    : `<p class="note">No changes.</p>`;

  // Built last: the summary has to count every redaction above.
  const tally = Object.entries(r.counts);
  const summary = tally.length
    ? `Redacted ${tally.reduce((n, [, c]) => n + c, 0)} secret(s): ${tally.map(([k, c]) => `${k.replace(/^secret\./, "")} ×${c}`).join(", ")}.`
    : "No secrets matched the redaction rules.";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t(thread.title)} — Solenta bug report</title><style>${CSS}</style></head>
<body>
<h1>${t(thread.title)}</h1>
<p class="note">Exported ${when(exportedAt)} from Solenta. ${esc(summary)} Review before sharing: redaction is pattern-based.</p>
<h2>Agent</h2><table>${agent}</table>
<h2>Environment</h2><table>${environment}</table>
<h2>Transcript</h2>
${transcript || `<p class="note">No messages.</p>`}
<h2>Changes</h2>
${diffHtml}
</body></html>
`;
  return { html, counts: r.counts };
}

/** `<bin> --version`, first line; "" when it is missing or slow. */
function cliVersion(/** @type {string} */ bin) {
  return new Promise((resolve) => {
    if (!bin) return resolve("");
    execFile(bin, ["--version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout).trim().split("\n")[0]);
    });
  });
}

/**
 * Save dialog first (cancel costs nothing), then gather and write.
 * @param {{ store: any, dialog?: any }} ctx
 * @param {string} threadId
 * @returns {Promise<string | null>} written path, null when cancelled
 */
async function exportThreadReport(ctx, threadId) {
  // Lazy: services/worktrees pull most of the main process in.
  const services = require("./services.js");
  const { diff } = require("./worktrees.js");
  const providers = require("./providers.js");
  const detail = services.getThreadDetail(ctx.store, threadId, null, { markVisited: false });
  if (!ctx.dialog || typeof ctx.dialog.showSaveDialog !== "function") {
    throw new Error("Save dialog is not available in this mode");
  }
  const slug = String(detail.thread.title || "thread").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "thread";
  const picked = await ctx.dialog.showSaveDialog({
    title: "Export bug report",
    defaultPath: `${slug}-report.html`,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (picked.canceled || !picked.filePath) return null;

  const project = ctx.store.getProject(detail.thread.projectId);
  /** @type {Array<{ label: string, patch: string }>} */
  const diffs = [];
  for (const [scope, fallback] of [["branch", "Committed on branch"], ["uncommitted", "Uncommitted"]]) {
    try {
      const d = await diff({ store: ctx.store, threadId, scope });
      if (d.patch) diffs.push({ label: d.scopeLabel ? `${fallback} (${d.scopeLabel})` : fallback, patch: d.patch });
    } catch {
      // No worktree or repo: the report just has no diff.
    }
  }
  const entry = providers.getProvider(detail.thread.provider);
  const env = {
    appVersion: (() => {
      try {
        return String(require("../package.json").version || "dev");
      } catch {
        return "dev";
      }
    })(),
    os: `${os.type()} ${os.release()} (${process.arch})`,
    electron: process.versions.electron || "",
    node: process.versions.node,
    agentVersion: project && project.remoteHost ? "" : await cliVersion(providers.resolveBin(entry)),
  };
  const { html } = buildThreadReport({
    detail,
    projectName: project && project.name,
    env,
    diffs,
    exportedAt: Date.now(),
  });
  fs.writeFileSync(picked.filePath, html);
  return picked.filePath;
}

module.exports = { buildThreadReport, exportThreadReport, redactor };
