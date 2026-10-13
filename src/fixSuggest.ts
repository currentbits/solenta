/**
 * Proactive fix suggestions (#253): spot a build error, test failure or merge
 * conflict in a thread's terminal or dev-server output, and turn it into a
 * fix prompt the user can run, edit, or fork without typing anything.
 */

export type FailureKind = "build" | "test" | "conflict";

export interface Failure {
  kind: FailureKind;
  /** The output line that matched, trimmed. */
  line: string;
}

/** What the user picked on a fix card. */
export type FixAction = "run" | "draft" | "fork";
export type FixHandler = (action: FixAction, threadId: string, prompt: string) => void;

// First rule that matches wins, so a conflict beats the build error it
// causes, and a build error beats the tests it breaks.
// ponytail: line regexes for the common toolchains; add a rule when a
// real tool's output slips past.
const RULES: [FailureKind, RegExp][] = [
  ["conflict", /^CONFLICT \(.+$/m],
  ["conflict", /^Automatic merge failed.*$/m],
  ["conflict", /^error: could not apply .+$/m],
  ["build", /^.*\berror TS\d+:.*$/m],
  ["build", /^error\[E\d+\]: .+$/m],
  ["build", /^.*:\d+:\d+: (?:fatal )?error: .+$/m],
  ["build", /^.*✘ \[ERROR\] .+$/m],
  ["build", /^.*\[vite\] Internal server error: .+$/m],
  ["build", /^.*Failed to compile\.?$/m],
  ["build", /^.*Module not found: .+$/m],
  ["test", /^\s*FAIL\s+\S.*$/m],
  ["test", /^.*\bTests?:?\s+\d+ failed.*$/m],
  ["test", /^(?:# |ℹ )fail [1-9]\d*$/m],
  ["test", /^\s*\d+ failing$/m],
  ["test", /^--- FAIL: .+$/m],
  ["test", /^test result: FAILED\..*$/m],
  ["test", /^FAILED \S.*$/m],
];

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** Terminal output as a reader sees it: no escapes, `\r` overwrites kept last. */
export function plainText(raw: string): string {
  return raw
    .replace(ANSI_RE, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** The first failure in already-plain text, or null. */
export function detectFailure(text: string): Failure | null {
  for (const [kind, re] of RULES) {
    const m = text.match(re);
    if (m) return { kind, line: m[0].trim().slice(0, 300) };
  }
  return null;
}

/**
 * Identity for "already dismissed or acted on". Digits are dropped so a rerun
 * with different line numbers or timings is the same failure.
 */
export function failureKey(f: Failure): string {
  return `${f.kind}:${f.line.replace(/\d+/g, "#")}`;
}

export const FAILURE_LABEL: Record<FailureKind, string> = {
  build: "Build error",
  test: "Test failure",
  conflict: "Merge conflict",
};

const ASK: Record<FailureKind, string> = {
  build: "Find the root cause and fix it, then re-run the build to confirm.",
  test: "Find out why it fails and fix the code (change the test only if the test itself is wrong), then re-run it to confirm.",
  conflict: "Resolve the conflicts, keeping the intent of both sides, and finish the merge or rebase.",
};

const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 3000;

/**
 * Self-contained prompt (a fork only gets a digest of this thread). The
 * excerpt is a window around the last occurrence of the failing line, so
 * both a leading `FAIL x` and a trailing `Tests: 1 failed` keep their detail.
 */
export function fixPrompt(f: Failure, source: string, output: string): string {
  const lines = output.split("\n");
  let at = lines.length - 1;
  for (let i = at; i >= 0; i--) {
    if (lines[i].trim().startsWith(f.line)) {
      at = i;
      break;
    }
  }
  const start = Math.max(0, Math.min(at - EXCERPT_LINES / 2, lines.length - EXCERPT_LINES));
  const excerpt = lines
    .slice(start, start + EXCERPT_LINES)
    .join("\n")
    .trim()
    .slice(-EXCERPT_CHARS);
  return `The ${source} in this thread's worktree reported a ${FAILURE_LABEL[f.kind].toLowerCase()}:\n\n\`\`\`\n${excerpt}\n\`\`\`\n\n${ASK[f.kind]}`;
}
