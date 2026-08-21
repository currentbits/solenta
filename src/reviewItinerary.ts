/**
 * Review itinerary (issue #421).
 *
 * Experts don't read diffs top-to-bottom. This builds an ordered, risk-ranked
 * review plan from a working-tree diff: CI/config first (hard-stop), a
 * duplicate-utility scan, the critical path, tests (toggleable to the front),
 * then evidence. Files are chunked by functional area — never alphabetical.
 */
import type { BlastRadiusInfo, FileChange } from "./shared/ipc";
import { blastRadiusFor, isCiWorkflowPath } from "./blastRadius";

export type ReviewArea =
  | "ci-config"
  | "tests"
  | "critical"
  | "impl"
  | "docs"
  | "meta";

export interface ReviewSymbol {
  name: string;
  path: string;
}

export interface ReviewAnnotationChunk {
  area: string;
  rationale: string;
  risks: string[];
}

export interface ReviewAnnotation {
  version: number;
  readOrder: string[];
  chunks: ReviewAnnotationChunk[];
  risks: string[];
}

export interface ReviewHunk {
  id: string;
  path: string;
  header: string;
  body: string;
  accepted: boolean;
}

export interface ReviewFilePatch {
  path: string;
  text: string;
  hunks: ReviewHunk[];
}

export interface ReviewReuseHit {
  name: string;
  addedIn: string;
  existingPath: string;
  reason: "existing" | "in-diff";
}

export interface ReviewMismatch {
  expected: string;
  extra: string[];
  label: string;
}

export interface ReviewChunk {
  area: ReviewArea;
  title: string;
  files: FileChange[];
  rationale: string;
}

export interface ReviewStep {
  id: string;
  title: string;
  kind: string;
  detail: string;
}

export interface ReviewItinerary {
  hardStop: { files: string[]; reason: string } | null;
  /** CI/workflow files in this diff (issue #510). Privilege-escalation. */
  blastRadius: BlastRadiusInfo | null;
  reuseHits: ReviewReuseHit[];
  mismatches: ReviewMismatch[];
  chunks: ReviewChunk[];
  steps: ReviewStep[];
  hunks: ReviewHunk[];
  patches: ReviewFilePatch[];
  annotation: ReviewAnnotation | null;
  newHunkCount: number;
  acceptedHunkCount: number;
}

export interface ReviewItineraryInput {
  files: FileChange[];
  patch: string;
  planText?: string | null;
  threadTitle?: string | null;
  symbols?: ReviewSymbol[];
  annotation?: ReviewAnnotation | null;
  acceptedHunks?: string[];
  testsFirst?: boolean;
}

/** Agent-written self-annotation; lives in the thread cwd. */
export const REVIEW_ITINERARY_FILE = ".solenta/review-itinerary.json";

export const AREA_TITLE: Record<ReviewArea, string> = {
  "ci-config": "CI / config",
  tests: "Tests",
  critical: "Critical path",
  impl: "Implementation",
  docs: "Evidence",
  meta: "Workspace",
};

const AREA_RATIONALE: Record<ReviewArea, string> = {
  "ci-config": "Workflows and config fail closed — read these before anything else.",
  tests: "What the agent claims this proves.",
  critical: "Entry points and contracts — a miss here is a runtime miss.",
  impl: "The rest of the change, grouped by area.",
  docs: "Evidence last — comments, docs, screenshots.",
  meta: "Agent workspace files.",
};

const DEFAULT_ORDER: ReviewArea[] = [
  "ci-config",
  "critical",
  "tests",
  "impl",
  "docs",
];

const TESTS_FIRST_ORDER: ReviewArea[] = [
  "ci-config",
  "tests",
  "critical",
  "impl",
  "docs",
];

const CRITICAL_PATHS = new Set([
  "electron/main.js",
  "electron/ipc.js",
  "electron/runner.js",
  "electron/store.js",
  "electron/preload.js",
  "electron/services.js",
  "src/app.tsx",
  "src/usecoder.ts",
  "src/shared/ipc.ts",
  "src/wireclient.ts",
  "src/boot.tsx",
  "src/main.tsx",
  "src/coderapi.ts",
]);

const SKIP_SYMBOLS = new Set([
  "it",
  "id",
  "on",
  "to",
  "is",
  "as",
  "if",
  "or",
  "and",
  "for",
  "let",
  "var",
  "new",
  "set",
  "get",
  "use",
  "app",
  "css",
  "jsx",
  "tsx",
  "props",
  "state",
  "styles",
  "classname",
  "exports",
  "require",
  "module",
  "default",
  "return",
  "function",
  "const",
  "class",
  "type",
  "interface",
  "enum",
  "export",
  "import",
]);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "have",
  "will",
  "each",
  "when",
  "then",
  "into",
  "onto",
  "just",
  "also",
  "only",
  "more",
  "most",
  "some",
  "such",
  "them",
  "they",
  "were",
  "been",
  "being",
  "your",
  "their",
  "about",
  "after",
  "before",
  "should",
  "would",
  "could",
  "than",
  "what",
  "where",
  "which",
  "while",
  "these",
  "those",
  "there",
  "here",
  "does",
  "did",
  "doing",
  "done",
  "over",
  "under",
  "between",
  "because",
  "through",
  "github",
  "issue",
]);

const JS_HEAD_RE =
  /^(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const JS_BIND_RE =
  /^(?:export\s+(?:default\s+)?)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/;
const PY_RE = /^(?:def|class)\s+([A-Za-z_][\w]*)/;
const GO_FUNC_RE = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/;
const GO_TYPE_RE = /^type\s+([A-Za-z_][\w]*)/;
const RS_RE = /^(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_][\w]*)/;

export function posixPath(path: string): string {
  return String(path || "").replace(/\\/g, "/");
}

function baseName(path: string): string {
  const n = posixPath(path);
  const i = n.lastIndexOf("/");
  return i < 0 ? n : n.slice(i + 1);
}

function extOf(path: string): string {
  const base = baseName(path);
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i).toLowerCase();
}

/** Functional area for one repo-relative path. */
export function classifyPath(path: string): ReviewArea {
  const n = posixPath(path).toLowerCase();
  if (!n) return "impl";
  if (n.startsWith(".solenta/") || n.includes("/.solenta/")) return "meta";
  if (isCiConfig(n)) return "ci-config";
  if (isTestPath(n)) return "tests";
  if (isCriticalPath(n)) return "critical";
  if (isDocsPath(n)) return "docs";
  return "impl";
}

function isCiConfig(n: string): boolean {
  if (n.startsWith(".github/") || n.includes("/.github/")) return true;
  if (n.includes(".gitlab-ci")) return true;
  const base = baseName(n);
  if (
    base === "dockerfile" ||
    base.startsWith("dockerfile.") ||
    base.startsWith("docker-compose")
  ) {
    return true;
  }
  if (
    base === "package.json" ||
    base === "package-lock.json" ||
    base === "pnpm-lock.yaml" ||
    base === "yarn.lock" ||
    base === "bun.lock" ||
    base === "bun.lockb"
  ) {
    return true;
  }
  if (base.startsWith("tsconfig") && base.endsWith(".json")) return true;
  if (base === "jsconfig.json") return true;
  if (
    /^(vite|vitest|webpack|rollup|electron-builder).*\.(js|ts|mjs|cjs|json)$/.test(
      base,
    )
  ) {
    return true;
  }
  if (
    base.startsWith(".eslintrc") ||
    base.startsWith("eslint.config") ||
    base.startsWith(".prettierrc") ||
    base.startsWith("prettier.config")
  ) {
    return true;
  }
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (
    /\.(yml|yaml)$/.test(base) &&
    /(^|\/)(\.github|ci|deploy|workflows)(\/|$)/.test(n)
  ) {
    return true;
  }
  if (
    n.startsWith("scripts/publish") ||
    n.startsWith("scripts/package") ||
    n.startsWith("scripts/test-smoke")
  ) {
    return true;
  }
  return [
    "appveyor.yml",
    "netlify.toml",
    "vercel.json",
    "fly.toml",
    ".nvmrc",
    ".node-version",
    "mise.toml",
    "electron-builder.yml",
    "electron-builder.yaml",
    "electron-builder.json",
  ].includes(base);
}

function isTestPath(n: string): boolean {
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(n)) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(n);
}

function isCriticalPath(n: string): boolean {
  if (CRITICAL_PATHS.has(n)) return true;
  return /(^|\/)(main|index|app|ipc|runner|store|preload|boot)\.[cm]?[jt]sx?$/.test(
    n,
  );
}

function isDocsPath(n: string): boolean {
  if (/\.(md|mdx)$/.test(n)) return true;
  if (n.startsWith("docs/") || n.includes("/docs/") || n.startsWith("site/")) {
    return true;
  }
  const base = baseName(n);
  return base === "license" || base === "changelog" || base === "changelog.md";
}

function clip(text: string, max: number): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Stable identity for one hunk so a content change drops prior acceptance. */
export function hunkId(path: string, header: string, body: string): string {
  return fnv1a(`${posixPath(path)}\0${header}\0${body}`);
}

function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pathFromPatch(chunk: string): string {
  const plus = chunk.match(/^\+\+\+ [ab]\/(.+)$/m);
  if (plus && plus[1] && plus[1] !== "/dev/null") return plus[1].trim();
  const git = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git) return (git[2] || git[1] || "").trim();
  const minus = chunk.match(/^--- [ab]\/(.+)$/m);
  if (minus && minus[1] && minus[1] !== "/dev/null") return minus[1].trim();
  return "";
}

function parseHunks(filePath: string, chunk: string): ReviewHunk[] {
  const hunks: ReviewHunk[] = [];
  let current: { header: string; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const lines = current.body;
    // split("\n") on a chunk that ends with a newline yields a trailing
    // empty string — that is a join artifact, not a blank context line
    // (those arrive as " ").
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const body = lines.join("\n");
    hunks.push({
      id: hunkId(filePath, current.header, body),
      path: filePath,
      header: current.header,
      body,
      accepted: false,
    });
    current = null;
  };
  for (const line of chunk.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      current = { header: line, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return hunks;
}

/** Split a unified patch into per-file sections (git order preserved). */
export function parsePatch(patch: string): ReviewFilePatch[] {
  const text = String(patch || "");
  if (!text.trim()) return [];
  const chunks = text.split(/(?=^diff --git )/m).filter((s) => s.trim());
  const out: ReviewFilePatch[] = [];
  for (const chunk of chunks) {
    const filePath = pathFromPatch(chunk);
    if (!filePath) continue;
    out.push({
      path: filePath,
      text: chunk,
      hunks: parseHunks(filePath, chunk),
    });
  }
  return out;
}

function symbolOnLine(line: string, ext: string): string {
  const trimmed = line.replace(/^\s+/, "");
  if (ext === ".py") {
    const m = PY_RE.exec(trimmed);
    return m?.[1] || "";
  }
  if (ext === ".go") {
    const fn = GO_FUNC_RE.exec(trimmed);
    if (fn?.[1]) return fn[1];
    const ty = GO_TYPE_RE.exec(trimmed);
    return ty?.[1] || "";
  }
  if (ext === ".rs") {
    const m = RS_RE.exec(trimmed);
    return m?.[1] || "";
  }
  const head = JS_HEAD_RE.exec(trimmed);
  if (head?.[1]) return head[1];
  const bind = JS_BIND_RE.exec(trimmed);
  if (bind?.[1] && (bind[2]?.includes("=>") || /\bfunction\b/.test(bind[2] || ""))) {
    return bind[1];
  }
  return "";
}

function keepSymbol(name: string): boolean {
  if (!name || name.length < 3) return false;
  return !SKIP_SYMBOLS.has(name.toLowerCase());
}

/** Names introduced on added lines of a file's patch. */
export function extractAddedSymbols(filePath: string, patchText: string): string[] {
  const ext = extOf(filePath);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of String(patchText || "").split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const name = symbolOnLine(line.slice(1), ext);
    if (!keepSymbol(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function scanReuse(
  files: FileChange[],
  patch: string,
  symbols: ReviewSymbol[],
): ReviewReuseHit[] {
  const patches = parsePatch(patch);
  const byPath = new Map(patches.map((p) => [p.path, p]));
  const addedByFile = new Map<string, string[]>();
  for (const file of files) {
    const p = byPath.get(file.path);
    addedByFile.set(file.path, p ? extractAddedSymbols(file.path, p.text) : []);
  }

  const nameToAdded = new Map<string, string[]>();
  for (const [filePath, names] of addedByFile) {
    for (const name of names) {
      const list = nameToAdded.get(name) || [];
      list.push(filePath);
      nameToAdded.set(name, list);
    }
  }

  const existingByName = new Map<string, string[]>();
  for (const row of symbols || []) {
    if (!row || !keepSymbol(row.name)) continue;
    const list = existingByName.get(row.name) || [];
    list.push(posixPath(row.path));
    existingByName.set(row.name, list);
  }

  const hits: ReviewReuseHit[] = [];
  const seen = new Set<string>();
  for (const [name, addedIn] of nameToAdded) {
    if (addedIn.length > 1) {
      for (const filePath of addedIn) {
        const other = addedIn.find((p) => p !== filePath) || addedIn[0]!;
        const key = `in-diff:${name}:${filePath}:${other}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          name,
          addedIn: filePath,
          existingPath: other,
          reason: "in-diff",
        });
      }
    }
    const existing = existingByName.get(name) || [];
    for (const filePath of addedIn) {
      const other = existing.find((p) => p !== filePath);
      if (!other) continue;
      const key = `existing:${name}:${filePath}:${other}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        name,
        addedIn: filePath,
        existingPath: other,
        reason: "existing",
      });
    }
  }
  return hits;
}

export function planSummary(planText: string | null | undefined, title?: string | null): string {
  const text = String(planText || "");
  const issue = text.match(/GitHub issue #\d+:\s*(.+)/i);
  if (issue?.[1]) return clip(issue[1], 72);
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l && !l.startsWith("["));
  if (line) return clip(line, 72);
  return clip(String(title || ""), 72);
}

function tokensOf(text: string): string[] {
  const words = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g);
  if (!words) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (STOP_WORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function fileMatchesPlan(path: string, tokens: string[]): boolean {
  const n = posixPath(path).toLowerCase();
  const segs = n
    .split("/")
    .flatMap((s) => s.replace(/\.[^.]+$/, "").split(/[-_.]/))
    .filter((s) => s.length >= 3);
  const hay = `${n} ${segs.join(" ")}`;
  return tokens.some((t) => t.length >= 3 && hay.includes(t));
}

export function planMismatches(
  planText: string | null | undefined,
  title: string | null | undefined,
  files: FileChange[],
): ReviewMismatch[] {
  const expected = planSummary(planText, title);
  if (!expected) return [];
  const tokens = tokensOf(`${planText || ""}\n${title || ""}`);
  if (tokens.length === 0) return [];
  const extra = files
    .filter((f) => classifyPath(f.path) !== "meta")
    .filter((f) => !fileMatchesPlan(f.path, tokens))
    .map((f) => f.path);
  if (extra.length === 0) return [];
  const shown = extra.slice(0, 3).map((p) => baseName(p));
  const more = extra.length > 3 ? ` +${extra.length - 3} more` : "";
  return [
    {
      expected,
      extra,
      label: `issue says ${expected}; diff also touches ${shown.join(", ")}${more}`,
    },
  ];
}

function riskScore(file: FileChange): number {
  const lines = (file.additions || 0) + (file.deletions || 0);
  const born = file.status === "A" || file.status === "??" ? 10 : 0;
  return lines * 2 + born;
}

function sortByRisk(files: FileChange[]): FileChange[] {
  return [...files].sort((a, b) => {
    const risk = riskScore(b) - riskScore(a);
    if (risk !== 0) return risk;
    return posixPath(a.path).localeCompare(posixPath(b.path));
  });
}

function isMetaItineraryFile(path: string): boolean {
  return posixPath(path).endsWith(REVIEW_ITINERARY_FILE);
}

export function parseReviewAnnotation(raw: unknown): ReviewAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const readOrder = Array.isArray(o.readOrder)
    ? o.readOrder.map((x) => String(x || "")).filter(Boolean)
    : [];
  const risks = Array.isArray(o.risks)
    ? o.risks
        .map((x) => String(x || ""))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const chunks: ReviewAnnotationChunk[] = [];
  if (Array.isArray(o.chunks)) {
    for (const row of o.chunks.slice(0, 20)) {
      if (!row || typeof row !== "object") continue;
      const x = row as Record<string, unknown>;
      chunks.push({
        area: String(x.area || ""),
        rationale: String(x.rationale || "").slice(0, 400),
        risks: Array.isArray(x.risks)
          ? x.risks
              .map((r) => String(r || ""))
              .filter(Boolean)
              .slice(0, 10)
          : [],
      });
    }
  }
  if (!readOrder.length && !chunks.length && !risks.length) return null;
  return { version: 1, readOrder, chunks, risks };
}

export function annotationForArea(
  annotation: ReviewAnnotation | null | undefined,
  area: string,
): ReviewAnnotationChunk | null {
  if (!annotation) return null;
  return annotation.chunks.find((c) => c.area === area) || null;
}

/** Build the ordered review plan for one working-tree diff. */
export function buildReviewItinerary(input: ReviewItineraryInput): ReviewItinerary {
  const files = (Array.isArray(input.files) ? input.files : []).filter(
    (f) => f && f.path && !isMetaItineraryFile(f.path),
  );
  const accepted = new Set(
    (input.acceptedHunks || []).map(String).filter(Boolean),
  );
  const patches = parsePatch(input.patch).map((p) => ({
    ...p,
    hunks: p.hunks.map((h) => ({ ...h, accepted: accepted.has(h.id) })),
  }));
  const hunks = patches.flatMap((p) => p.hunks);
  const annotation = input.annotation ?? null;

  const blastRadius = blastRadiusFor(
    files.map((f) => f.path),
    input.patch,
  );
  const ciFiles = files.filter((f) => classifyPath(f.path) === "ci-config");
  const hardStopFiles = ciFiles
    .map((f) => f.path)
    .filter((p) => !isCiWorkflowPath(p));
  const hardStop =
    hardStopFiles.length > 0
      ? {
          files: hardStopFiles,
          reason:
            "CI and config changes first — a bad config file ships to every run.",
        }
      : null;

  const reuseHits = scanReuse(files, input.patch, input.symbols || []);
  const mismatches = planMismatches(input.planText, input.threadTitle, files);

  const order = input.testsFirst ? TESTS_FIRST_ORDER : DEFAULT_ORDER;
  const grouped = new Map<ReviewArea, FileChange[]>();
  for (const file of files) {
    const area = classifyPath(file.path);
    if (area === "meta") continue;
    const list = grouped.get(area) || [];
    list.push(file);
    grouped.set(area, list);
  }

  const chunks: ReviewChunk[] = [];
  for (const area of order) {
    const list = grouped.get(area);
    if (!list || list.length === 0) continue;
    chunks.push({
      area,
      title: AREA_TITLE[area],
      files: sortByRisk(list),
      rationale: AREA_RATIONALE[area],
    });
  }

  const steps: ReviewStep[] = [];
  if (blastRadius) {
    const n = blastRadius.files.length;
    const extra =
      blastRadius.findings.length > 0
        ? ` ${blastRadius.findings.length} interpolation warning${
            blastRadius.findings.length === 1 ? "" : "s"
          }.`
        : "";
    steps.push({
      id: "blast-radius",
      title: "Blast radius",
      kind: "blast-radius",
      detail: `${n} CI workflow file${n === 1 ? "" : "s"} — privilege-escalation, human sign-off required.${extra}`,
    });
  }
  if (hardStop) {
    steps.push({
      id: "ci-config",
      title: AREA_TITLE["ci-config"],
      kind: "hard-stop",
      detail: hardStop.reason,
    });
  }
  if (reuseHits.length > 0) {
    const n = reuseHits.length;
    steps.push({
      id: "reuse",
      title: "Reuse scan",
      kind: "reuse",
      detail: `${n} possible duplicate${n === 1 ? "" : "s"} — check the repo before keeping a new helper.`,
    });
  }
  for (const chunk of chunks) {
    if (chunk.area === "ci-config" && (hardStop || blastRadius)) continue;
    steps.push({
      id: chunk.area,
      title: chunk.title,
      kind: chunk.area,
      detail: chunk.rationale,
    });
  }
  if (mismatches[0]) {
    steps.push({
      id: "mismatch",
      title: "Plan vs diff",
      kind: "mismatch",
      detail: mismatches[0].label,
    });
  }

  return {
    hardStop,
    blastRadius,
    reuseHits,
    mismatches,
    chunks,
    steps,
    hunks,
    patches,
    annotation,
    newHunkCount: hunks.filter((h) => !h.accepted).length,
    acceptedHunkCount: hunks.filter((h) => h.accepted).length,
  };
}

/** File patches in itinerary order (chunk order, then leftover patch files). */
export function orderedPatches(itinerary: ReviewItinerary): ReviewFilePatch[] {
  const byPath = new Map(itinerary.patches.map((p) => [p.path, p]));
  const out: ReviewFilePatch[] = [];
  const seen = new Set<string>();
  for (const chunk of itinerary.chunks) {
    for (const file of chunk.files) {
      const p = byPath.get(file.path);
      if (!p || seen.has(file.path)) continue;
      seen.add(file.path);
      out.push(p);
    }
  }
  for (const p of itinerary.patches) {
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    out.push(p);
  }
  return out;
}

export function chunkForPath(
  itinerary: ReviewItinerary,
  path: string,
): ReviewChunk | null {
  return itinerary.chunks.find((c) => c.files.some((f) => f.path === path)) || null;
}
