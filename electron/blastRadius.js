"use strict";

/**
 * Blast-radius guard (issue #510).
 *
 * Path classifier + GitHub Actions interpolation lint + the merge-gate
 * refusal. Keep the matcher in src/blastRadius.ts in lockstep — renderer
 * and main share no module.
 *
 * Issue #161 (CI-failure reaction loop): an agent's fix to a workflow file
 * MUST go through assertCiWorkflowSignOff. Never bypass this from a
 * machine-delivered merge / auto-merge / merge-queue path.
 */

const CI_WORKFLOW_KIND = "ci-workflow";
const CI_WORKFLOW_BLOCK_PREFIX = "CI_WORKFLOW:";

function posixPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function baseName(p) {
  const n = posixPath(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? n : n.slice(i + 1);
}

/**
 * True when `path` is a CI/CD workflow or pipeline definition.
 * @param {unknown} path
 * @returns {boolean}
 */
function isCiWorkflowPath(path) {
  const n = posixPath(path).replace(/^\/+/, "");
  if (!n) return false;
  const lower = n.toLowerCase();
  if (
    lower.startsWith(".github/workflows/") ||
    lower.includes("/.github/workflows/")
  ) {
    return true;
  }
  if (lower.startsWith(".circleci/") || lower.includes("/.circleci/")) {
    return true;
  }
  const base = baseName(lower);
  if (base === ".gitlab-ci.yml" || base === ".gitlab-ci.yaml") return true;
  if (base === "jenkinsfile") return true;
  if (base.startsWith("jenkinsfile.") && !/\.(md|mdx|txt|rst)$/.test(base)) {
    return true;
  }
  if (base === "azure-pipelines.yml" || base === "azure-pipelines.yaml") {
    return true;
  }
  if (
    base === "bitbucket-pipelines.yml" ||
    base === "bitbucket-pipelines.yaml"
  ) {
    return true;
  }
  return false;
}

function isGithubWorkflowPath(path) {
  const n = posixPath(path).replace(/^\/+/, "").toLowerCase();
  if (
    !(
      n.startsWith(".github/workflows/") || n.includes("/.github/workflows/")
    )
  ) {
    return false;
  }
  return /\.ya?ml$/.test(n);
}

/**
 * @param {Iterable<unknown>} paths
 * @returns {string[]}
 */
function ciWorkflowFiles(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const n = posixPath(raw);
    if (!n || seen.has(n) || !isCiWorkflowPath(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

const GITHUB_EVENT_RE = /\$\{\{\s*github\.event\./i;

function clipExcerpt(line, max) {
  const cap = max == null ? 96 : max;
  const s = String(line || "")
    .replace(/^\s+/, "")
    .trim();
  if (s.length <= cap) return s;
  return `${s.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

function isRunBlockScalar(rest) {
  return /^\s*[|>][-+]?\s*$/.test(rest);
}

/**
 * Flag `${{ github.event.* }}` interpolated into a `run:` line / block.
 * @param {string} filePath
 * @param {string} patchText
 * @returns {Array<{ path: string, excerpt: string, reason: string }>}
 */
function lintWorkflowPatch(filePath, patchText) {
  if (!isGithubWorkflowPath(filePath)) return [];
  const findings = [];
  let inRunBlock = false;
  let runIndent = 0;

  for (const raw of String(patchText || "").split("\n")) {
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("+++") ||
      raw.startsWith("---") ||
      raw.startsWith("@@")
    ) {
      continue;
    }
    if (raw.startsWith("-") && !raw.startsWith("---")) continue;
    const added = raw.startsWith("+");
    if (!added && !raw.startsWith(" ")) continue;
    const content = raw.slice(1);
    const indent = content.match(/^ */)[0].length;
    const trimmed = content.trim();

    if (inRunBlock) {
      if (trimmed === "" || indent > runIndent) {
        if (added && GITHUB_EVENT_RE.test(content)) {
          findings.push({
            path: filePath,
            excerpt: clipExcerpt(content),
            reason:
              "interpolates github.event.* into a run: block (untrusted input → shell)",
          });
        }
        continue;
      }
      inRunBlock = false;
    }

    const run = content.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!run) continue;
    const rest = run[2] || "";
    if (isRunBlockScalar(rest)) {
      inRunBlock = true;
      runIndent = run[1].length;
      continue;
    }
    if (added && GITHUB_EVENT_RE.test(rest)) {
      findings.push({
        path: filePath,
        excerpt: clipExcerpt(content),
        reason:
          "interpolates github.event.* directly into run: (untrusted input → shell)",
      });
    }
  }
  return findings;
}

function pathFromGitHeader(chunk) {
  const plus = chunk.match(/^\+\+\+ [ab]\/(.+)$/m);
  if (plus && plus[1] && plus[1] !== "/dev/null") return plus[1].trim();
  const git = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git) return (git[2] || git[1] || "").trim();
  return "";
}

function lintWorkflowDiff(patch) {
  const text = String(patch || "");
  if (!text.trim()) return [];
  const chunks = text.split(/(?=^diff --git )/m).filter((s) => s.trim());
  const findings = [];
  for (const chunk of chunks) {
    const filePath = pathFromGitHeader(chunk);
    if (!filePath) continue;
    findings.push(...lintWorkflowPatch(filePath, chunk));
  }
  return findings;
}

/**
 * @param {Iterable<unknown>} paths
 * @param {string} [patch]
 * @returns {{ kind: string, files: string[], findings: object[] } | null}
 */
function blastRadiusFor(paths, patch) {
  const files = ciWorkflowFiles(paths);
  if (files.length === 0) return null;
  return {
    kind: CI_WORKFLOW_KIND,
    files,
    findings: patch ? lintWorkflowDiff(patch) : [],
  };
}

function isCiWorkflowBlockMessage(message) {
  return String(message || "").startsWith(CI_WORKFLOW_BLOCK_PREFIX);
}

function ciWorkflowBlockMessage(files) {
  const listed =
    Array.isArray(files) && files.length
      ? files.join(", ")
      : "CI workflow files";
  return `${CI_WORKFLOW_BLOCK_PREFIX} CI workflow changes require sign-off (${listed}). A human must explicitly approve.`;
}

/**
 * Hard rule: CI/workflow diffs cannot merge without an explicit human
 * `ciWorkflowApproved` flag. Not a permission preset; not overridable by
 * settings. Callers that auto-merge (#242, #346) must not pass the flag.
 *
 * @param {string[]} files ci-workflow paths in the change set
 * @param {unknown} approved
 */
function assertCiWorkflowSignOff(files, approved) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length === 0) return;
  if (approved === true) return;
  const err = new Error(ciWorkflowBlockMessage(list));
  err.code = "CI_WORKFLOW";
  throw err;
}

function inspectFailedMessage() {
  return `${CI_WORKFLOW_BLOCK_PREFIX} Could not inspect the diff for CI workflow files; merge refused.`;
}

module.exports = {
  CI_WORKFLOW_KIND,
  CI_WORKFLOW_BLOCK_PREFIX,
  posixPath,
  isCiWorkflowPath,
  isGithubWorkflowPath,
  ciWorkflowFiles,
  lintWorkflowPatch,
  lintWorkflowDiff,
  blastRadiusFor,
  isCiWorkflowBlockMessage,
  ciWorkflowBlockMessage,
  assertCiWorkflowSignOff,
  inspectFailedMessage,
};
