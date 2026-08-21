/**
 * Blast-radius guard (issue #510).
 *
 * An agent touching CI configuration is a privilege-escalation event, not a
 * code edit. Workflow files turn untrusted input (issue titles, PR bodies,
 * branch names) into runner execution. Classification is path-only and pure
 * so the review UI, next-action chain, digest, and the main-process merge
 * gate share one decision.
 *
 * Keep the matcher in electron/blastRadius.js in lockstep — the two
 * processes share no module.
 */

export const CI_WORKFLOW_KIND = "ci-workflow" as const;

/**
 * Stable prefix of the main-process merge refusal. Must match
 * CI_WORKFLOW_BLOCK_PREFIX in electron/blastRadius.js.
 */
export const CI_WORKFLOW_BLOCK_PREFIX = "CI_WORKFLOW:";

export interface WorkflowLintFinding {
  path: string;
  excerpt: string;
  reason: string;
}

export interface BlastRadiusInfo {
  kind: typeof CI_WORKFLOW_KIND;
  files: string[];
  findings: WorkflowLintFinding[];
}

export function posixPath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function baseName(path: string): string {
  const n = posixPath(path);
  const i = n.lastIndexOf("/");
  return i < 0 ? n : n.slice(i + 1);
}

/**
 * True when `path` is a CI/CD workflow or pipeline definition.
 *
 * Matches the #510 list: `.github/workflows/`, `.gitlab-ci.yml`,
 * `.circleci/`, `Jenkinsfile`, `azure-pipelines.yml`,
 * `bitbucket-pipelines.yml`. Broader "config" (package.json, tsconfig)
 * stays in the review-itinerary ci-config chunk and is NOT a blast-radius
 * event.
 */
export function isCiWorkflowPath(path: string): boolean {
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

/** GitHub Actions YAML under `.github/workflows/` — the Snowflake lint target. */
export function isGithubWorkflowPath(path: string): boolean {
  const n = posixPath(path).replace(/^\/+/, "").toLowerCase();
  if (
    !(
      n.startsWith(".github/workflows/") ||
      n.includes("/.github/workflows/")
    )
  ) {
    return false;
  }
  return /\.ya?ml$/.test(n);
}

export function ciWorkflowFiles(paths: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const n = posixPath(raw);
    if (!n || seen.has(n) || !isCiWorkflowPath(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

const GITHUB_EVENT_RE = /\$\{\{\s*github\.event\./i;

function clipExcerpt(line: string, max = 96): string {
  const s = line.replace(/^\s+/, "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isRunBlockScalar(rest: string): boolean {
  return /^\s*[|>][-+]?\s*$/.test(rest);
}

/**
 * Flag direct `${{ github.event.* }}` interpolation into a `run:` line or
 * a folded/literal `run: |` block. The Snowflake Copilot Autofix bug was
 * exactly this: stripping the `env:` + `jq` escape and dropping the issue
 * title into the shell. `env:` / `if:` / `with:` interpolations are the
 * safe pattern and are ignored.
 *
 * Scans added (`+`) lines. Context lines keep `run: |` block state so a
 * newly interpolated line inside an existing block still flags.
 */
export function lintWorkflowPatch(
  path: string,
  patchText: string,
): WorkflowLintFinding[] {
  if (!isGithubWorkflowPath(path)) return [];
  const findings: WorkflowLintFinding[] = [];
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
    const indent = content.match(/^ */)![0].length;
    const trimmed = content.trim();

    if (inRunBlock) {
      if (trimmed === "" || indent > runIndent) {
        if (added && GITHUB_EVENT_RE.test(content)) {
          findings.push({
            path,
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
    const rest = run[2] ?? "";
    if (isRunBlockScalar(rest)) {
      inRunBlock = true;
      runIndent = run[1]!.length;
      continue;
    }
    if (added && GITHUB_EVENT_RE.test(rest)) {
      findings.push({
        path,
        excerpt: clipExcerpt(content),
        reason:
          "interpolates github.event.* directly into run: (untrusted input → shell)",
      });
    }
  }
  return findings;
}

function pathFromGitHeader(chunk: string): string {
  const plus = chunk.match(/^\+\+\+ [ab]\/(.+)$/m);
  if (plus?.[1] && plus[1] !== "/dev/null") return plus[1].trim();
  const git = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git) return (git[2] || git[1] || "").trim();
  return "";
}

/** Lint every GitHub workflow file section of a unified patch. */
export function lintWorkflowDiff(patch: string): WorkflowLintFinding[] {
  const text = String(patch || "");
  if (!text.trim()) return [];
  const chunks = text.split(/(?=^diff --git )/m).filter((s) => s.trim());
  const findings: WorkflowLintFinding[] = [];
  for (const chunk of chunks) {
    const filePath = pathFromGitHeader(chunk);
    if (!filePath) continue;
    findings.push(...lintWorkflowPatch(filePath, chunk));
  }
  return findings;
}

export function blastRadiusFor(
  paths: Iterable<string>,
  patch?: string | null,
): BlastRadiusInfo | null {
  const files = ciWorkflowFiles(paths);
  if (files.length === 0) return null;
  const findings = patch ? lintWorkflowDiff(patch) : [];
  return { kind: CI_WORKFLOW_KIND, files, findings };
}

export function isCiWorkflowBlockMessage(message: string): boolean {
  return String(message || "").startsWith(CI_WORKFLOW_BLOCK_PREFIX);
}

export function ciWorkflowBlockMessage(files: string[]): string {
  const listed = files.length ? files.join(", ") : "CI workflow files";
  return `${CI_WORKFLOW_BLOCK_PREFIX} CI workflow changes require sign-off (${listed}). A human must explicitly approve.`;
}

export function blastRadiusLabel(info: BlastRadiusInfo): string {
  const n = info.files.length;
  return n === 1 ? "CI workflow" : `CI workflows · ${n}`;
}

export function blastRadiusTitle(info: BlastRadiusInfo): string {
  const files = info.files.join(", ");
  const lint =
    info.findings.length > 0
      ? ` ${info.findings.length} interpolation warning${
          info.findings.length === 1 ? "" : "s"
        }.`
      : "";
  return `This change edits CI workflow files (${files}). Privilege-escalation — a human must sign off.${lint}`;
}
