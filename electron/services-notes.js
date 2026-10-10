"use strict";

// Thread title limits and the prompt notes injected into agent turns.

const { knownProviderIds } = require("./providers.js");

/** Thread title cap — matches runner auto-rename from the first prompt line. */
const THREAD_TITLE_MAX = 60;
/** Per-thread scratch pad cap (issue #194). */
const THREAD_NOTES_MAX = 2000;
/** Felt-estimate cap (issue #401). Mirror src/shared/ipc.ts FELT_ESTIMATE_MAX_MS. */
const FELT_ESTIMATE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-thread hypothesis ledger caps (issue #303). Mirror src/shared/ipc.ts. */
const HYPOTHESES_MAX = 50;
const HYPOTHESIS_CLAIM_MAX = 200;
const HYPOTHESIS_REASON_MAX = 500;
const HYPOTHESIS_STATUSES = ["validated", "invalidated", "inconclusive"];
/** Ruled-out note: walk this many handoffFrom hops, emit at most this many lines. */
const HYPOTHESIS_NOTE_HOPS = 5;
const HYPOTHESIS_NOTE_MAX = 10;
/** Per-thread suggested-work chip caps (issue #550). Mirror src/shared/ipc.ts. */
const SUGGESTIONS_MAX = 20;
const SUGGESTION_TITLE_MAX = 120;
const SUGGESTION_PROMPT_MAX = 4000;
const SUGGESTION_RESOLVE_STATUSES = ["started", "filed", "dismissed"];

/**
 * @param {string} title
 * @returns {string}
 */
function truncateThreadTitle(title) {
  const s = String(title ?? "");
  if (s.length <= THREAD_TITLE_MAX) return s;
  return s.slice(0, THREAD_TITLE_MAX);
}

/**
 * Strip generated `Fork:` prefixes so a fork of a fork does not grow
 * `Fork: Fork: …`. Provenance stays on `handoffFrom`.
 * @param {string} title
 * @returns {string}
 */
function stripForkTitlePrefix(title) {
  let s = String(title ?? "").trim();
  while (/^fork:\s*/i.test(s)) {
    s = s.replace(/^fork:\s*/i, "").trim();
  }
  return s;
}

/**
 * First non-empty prompt line, capped like createThread titles.
 * @param {unknown} prompt
 * @returns {string}
 */
function titleFromPromptLine(prompt) {
  const line = String(prompt || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line ? truncateThreadTitle(line) : "";
}

/**
 * Ordinary fork title: optional explicit name, else one `Fork:` on the
 * source title with generated prefixes collapsed.
 * @param {unknown} explicit
 * @param {string} sourceTitle
 * @returns {string}
 */
function resolveOrdinaryForkTitle(explicit, sourceTitle) {
  const trimmed = explicit != null ? String(explicit).trim() : "";
  if (trimmed) return truncateThreadTitle(trimmed);
  const base = stripForkTitlePrefix(sourceTitle) || "New Thread";
  return `Fork: ${base}`;
}

/**
 * Worker job name: explicit title, else first prompt line. Empty means
 * fall through to ordinary fork naming.
 * @param {{ title?: unknown, prompt?: unknown } | null | undefined} input
 * @returns {string}
 */
function resolveWorkerTitle(input) {
  const trimmed = input && input.title != null ? String(input.title).trim() : "";
  if (trimmed) return truncateThreadTitle(trimmed);
  return titleFromPromptLine(input && input.prompt);
}

/**
 * Normalize a model string. The provider's `models` list is a picker snapshot,
 * not an allowlist: every provider accepts a custom id. Guards are trim,
 * non-empty, and at most 100 characters. A bad id fails at the CLI.
 * Returns the trimmed string, or null when clearing.
 *
 * @param {import('./providers').ProviderEntry | null} entry
 * @param {string | null | undefined} rawModel
 * @returns {string | null}
 */
function normalizeModelForProvider(entry, rawModel) {
  if (rawModel == null || rawModel === "") return null;
  const trimmed = String(rawModel).trim();
  if (!trimmed) {
    throw new Error("Model must be a non-empty string");
  }
  // A provider's `models` list is a SUGGESTION, not an allowlist. It is a
  // snapshot of a CLI's catalogue taken when this file was written, and it goes
  // stale the moment a model ships. Rejecting an unlisted id would block a user
  // from a model their CLI already supports, and would make the picker's
  // "Custom..." affordance dead for every provider now that all of them
  // publish a list. A bad id fails loudly at the CLI, which is the right place.
  if (trimmed.length > 100) {
    throw new Error("Model must be at most 100 characters");
  }
  return trimmed;
}

/**
 * True when a provider id is accepted by setProvider / forkThread.
 * @param {string} id
 * @returns {boolean}
 */
function isKnownProviderId(id) {
  const s = String(id || "");
  return (
    knownProviderIds().includes(s) ||
    (s === "simulate" && process.env.CODER_SIMULATE === "1")
  );
}

/** Hand-off digest limits: chars per message, messages kept, chars total. */
const HANDOFF_MESSAGE_MAX = 2000;
const HANDOFF_MESSAGE_COUNT = 12;
const HANDOFF_TOTAL_MAX = 12000;

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) so every provider's agent knows the Planboard
 * convention. The Planboard view reads these labels back via
 * `gh issue list`.
 */
const PLANBOARD_NOTE =
  "\n\n[Planboard] This workspace tracks project plans as forge issues. " +
  "For multi-step work, record and maintain your plan/roadmap/issues as " +
  "issues in this repo's origin (GitHub or GitLab) using the coder-threads tools " +
  "issue_create, issue_list, issue_set_plan, issue_complete, and " +
  "issue_comment (status labels plan:todo, plan:doing, plan:done). " +
  "issue_comment appends a comment without changing plan:* or closing. " +
  "Do not use `gh` or `glab` for these writes: host-side tools keep the board " +
  "in sync even when a sandbox cannot authenticate to the forge. " +
  "Skip this for trivial tasks. Your own todo list is mirrored onto the " +
  "board as live steps, so keep it current instead of filing issues for " +
  "individual steps.";

/**
 * Codex-only standing note (issue #800). gpt-5.6-sol invents a Solenta
 * "enable automation / agentmux" toggle when Computer Use tools are
 * missing. Official Computer Use is a ChatGPT / Codex Desktop plugin,
 * not a CLI flag and not a Solenta setting. `codex features list`
 * already reports computer_use=true; passing --enable is a no-op.
 */
const CODEX_COMPUTER_USE_NOTE =
  "\n\n[Computer use] Solenta runs the headless Codex CLI (app-server for interactive threads). " +
  "It has no Computer Use, desktop-control, or " +
  '"enable automation" / agentmux setting. Official Computer Use is ' +
  "installed from ChatGPT / Codex Desktop → Settings → Computer Use → " +
  "Install (plugin + Screen Recording + Accessibility). If those tools " +
  "are missing, say so and point at Desktop — do not invent a Solenta " +
  "toggle. Full-access permission mode is not desktop control.";

/**
 * PLANBOARD_NOTE when the project checkout has a GitHub or GitLab origin, else "".
 * Keeps the note out of prompts where it isn't actionable.
 *
 * ponytail: checks the LOCAL path only, so remote-host projects never get
 * the note; route the check over ssh if remote planboards matter.
 *
 * @param {string | null | undefined} projectPath
 * @returns {string}
 */
function planboardNoteFor(projectPath) {
  try {
    const { gitTry, isForgeRemote } = require("./worktrees.js");
    const cwd = String(projectPath || "");
    if (!cwd) return "";
    const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
    if (!remote.ok) return "";
    if (!isForgeRemote(String(remote.stdout || "").trim())) return "";
    return PLANBOARD_NOTE;
  } catch {
    return "";
  }
}

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) telling the agent WHICH thread and project it is, so the
 * coder-threads tools can be called with real ids instead of a guess.
 *
 * The orchestrator server has no caller identity (one workspace-wide token,
 * stateless HTTP), so this note is the only channel by which an agent learns
 * its own id. Without it an agent picked thread ids off threads_list by title
 * and spawned workers on another project's repo (issue #109).
 *
 * Rides every dispatch rather than only the first turn: context compaction
 * and resumed sessions would otherwise lose it.
 *
 * Emitted only when the coder-threads server is actually registered: with no
 * thread tools in the run there is nothing to pass these ids to, and the note
 * would just be noise. Same rule as planboardNoteFor's GitHub-origin gate.
 *
 * @param {{ id?: string, projectId?: string } | null | undefined} thread
 * @param {{ name?: string } | null | undefined} project
 * @param {string | null | undefined} cwd - worktree path, else project path
 * @returns {string}
 */
function selfIdNoteFor(thread, project, cwd) {
  if (!thread || !thread.id || !thread.projectId) return "";
  try {
    const { activeServers } = require("./memory-sup.js");
    if (!activeServers().some((s) => s.name === "coder-threads")) return "";
  } catch {
    return "";
  }
  const name = project && project.name ? String(project.name) : "this project";
  const where = cwd ? `, checked out at ${cwd}` : "";
  return (
    `\n\n[Thread] You are thread ${thread.id} in project "${name}" ` +
    `(projectId ${thread.projectId})${where}. Pass these ids to the ` +
    `coder-threads tools; never guess another thread's id from its title. ` +
    `Threads in other projects are off limits.`
  );
}

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) telling the agent it can offer out-of-scope work as a
 * one-click chip via work_suggest (issue #550). Gated exactly like
 * selfIdNoteFor: silent unless the coder-threads server is registered.
 *
 * @returns {string}
 */
function suggestedWorkNoteFor() {
  try {
    const { activeServers } = require("./memory-sup.js");
    if (!activeServers().some((s) => s.name === "coder-threads")) return "";
  } catch {
    return "";
  }
  return (
    "\n\n[Suggested work] When you notice work worth doing that is OUT OF SCOPE for the current task, call the coder-threads tool work_suggest (with your own threadId/projectId) — a short title plus a self-contained prompt for a fresh agent with none of your context. It renders as a chip the user can start as a new thread with one click. Never start or do that work yourself, never derail the current task for it, and suggest at most a few per run. Skip anything already suggested on this thread."
  );
}

/**
 * Standing note appended to every Codex dispatch (CLI-only, never stored
 * in the transcript) so the model does not invent a Solenta Computer Use
 * toggle (issue #800). Silent for every other provider.
 *
 * @param {string | null | undefined} provider
 * @returns {string}
 */
function codexComputerUseNoteFor(provider) {
  return provider === "codex" ? CODEX_COMPUTER_USE_NOTE : "";
}

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) listing approaches earlier agents on this thread already
 * tried and rejected. The whole point of the ledger: it stops the next agent
 * (and the next best-of-N fork) from re-treading a dead end.
 *
 * Only invalidated entries speak; validated / inconclusive stay in the store
 * for the UI. Walks `handoffFrom` so a fork sees its ancestor's ruled-out
 * list. Returns "" when there is nothing to say, same rule as
 * planboardNoteFor / selfIdNoteFor.
 *
 * ponytail: 5 hops / 10 lines — enough to stop a sibling re-treading a
 * parent's dead end; walk the whole crew if a long chain starts to matter.
 *
 * @param {{ hypotheses?: Array<{ claim?: string, status?: string, reason?: string }>, handoffFrom?: string | null, id?: string } | null | undefined} thread
 * @param {(id: string) => { hypotheses?: unknown, handoffFrom?: string | null, id?: string } | null | undefined} [getThread]
 * @returns {string}
 */
function hypothesisNoteFor(thread, getThread) {
  if (!thread) return "";
  const lines = [];
  const seenClaims = new Set();
  const seenIds = new Set();
  let current = thread;
  for (let hop = 0; current && hop <= HYPOTHESIS_NOTE_HOPS; hop++) {
    if (current.id) {
      if (seenIds.has(current.id)) break;
      seenIds.add(current.id);
    }
    const hyps = Array.isArray(current.hypotheses) ? current.hypotheses : [];
    for (let i = hyps.length - 1; i >= 0; i--) {
      const h = hyps[i];
      if (!h || h.status !== "invalidated") continue;
      const claim = String(h.claim || "").trim();
      if (!claim || seenClaims.has(claim)) continue;
      seenClaims.add(claim);
      const reason = String(h.reason || "").trim();
      lines.push(reason ? `- ${claim} — ${reason}` : `- ${claim}`);
      if (lines.length >= HYPOTHESIS_NOTE_MAX) break;
    }
    if (lines.length >= HYPOTHESIS_NOTE_MAX) break;
    const parentId = current.handoffFrom;
    if (!parentId || typeof getThread !== "function") break;
    try {
      current = getThread(String(parentId));
    } catch {
      break;
    }
  }
  if (lines.length === 0) return "";
  return (
    "\n\n[Ruled out] Earlier agents on this thread already tried and rejected these. " +
    "Do not re-tread them; if you must revisit one, record why with hypothesis_record.\n" +
    lines.join("\n")
  );
}

/** Keep a persisted plan bounded: it rides every threads:changed push. */
const PLAN_STEP_MAX = 200;
const PLAN_STEPS_MAX = 50;

/**
 * A TodoWrite input's `todos` -> planboard steps, or null when there is
 * nothing usable (caller then keeps the thread's previous plan). The agent's
 * live plan is already its todo list, so the board costs the agent nothing.
 *
 * ponytail: TodoWrite (claude) only — codex/opencode carry their own plan
 * shapes; map them onto this same {step,status} list when one matters.
 *
 * @param {unknown} todos
 * @returns {{ step: string, status: "todo" | "doing" | "done" }[] | null}
 */
function planStepsFrom(todos) {
  if (!Array.isArray(todos)) return null;
  const steps = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    const step = typeof t.content === "string" ? t.content.trim() : "";
    if (!step) continue;
    const status = String(t.status || "");
    steps.push({
      step: step.slice(0, PLAN_STEP_MAX),
      status:
        status === "completed"
          ? "done"
          : status === "in_progress"
            ? "doing"
            : "todo",
    });
  }
  return steps.length > 0 ? steps.slice(0, PLAN_STEPS_MAX) : null;
}

/**
 * One-time context prefix for the CLI (NOT stored in the transcript): a
 * digest of a transcript tail, newest-last, each message capped.
 * Source is the handoffFrom thread, or this thread itself when
 * replayContext is set (issue #254 rewind — do NOT set handoffFrom to
 * self; that field drives crew sweeps and the OTel ancestor walk).
 * Returns "" when no prefix applies: no source, session already exists,
 * source missing/deleted, or source has no assistant message.
 *
 * ponytail: tail digest, not a summary — a fork still needs a self-contained
 * prompt (the MCP tool description says so). Summarize here only if the tail
 * proves too thin in practice.
 *
 * Strings are mirrored in src/devCoder.ts (services-level helper + dev twin —
 * the established pattern for shared electron/dev logic).
 *
 * @param {{ id?: string, handoffFrom?: string | null, sessionId?: string | null, replayContext?: boolean } | null} thread
 * @param {(sourceId: string) => Array<{ role?: string, text?: string }> | null | undefined} getMessages
 * @returns {string}
 */
function buildHandoffPrefix(thread, getMessages, getThread) {
  if (!thread) return "";
  if (thread.sessionId != null && thread.sessionId !== "") {
    return "";
  }
  // replayContext wins: a rewound fork must digest ITS OWN retained tail,
  // not walk handoffFrom again (and never a self-handoffFrom).
  const sourceId =
    thread.replayContext === true ? thread.id : thread.handoffFrom;
  if (sourceId == null || sourceId === "") {
    return "";
  }
  let msgs;
  try {
    msgs = getMessages(String(sourceId));
  } catch {
    return "";
  }
  if (!Array.isArray(msgs) || msgs.length === 0) return "";

  if (
    !msgs.some(
      (m) => m && m.role === "assistant" && m.text != null && String(m.text),
    )
  ) {
    return "";
  }

  const picked = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (picked.length >= HANDOFF_MESSAGE_COUNT) break;
    const m = msgs[i];
    if (!m || (m.role !== "assistant" && m.role !== "user")) continue;
    const text = m.text == null ? "" : String(m.text);
    if (!text) continue;
    const body =
      text.length > HANDOFF_MESSAGE_MAX
        ? text.slice(0, HANDOFF_MESSAGE_MAX) + "\n[…truncated]"
        : text;
    if (picked.length && total + body.length > HANDOFF_TOTAL_MAX) break;
    picked.push(`${m.role}: ${body}`);
    total += body.length;
  }
  picked.reverse();

  // Cached recap (#239) of the source, when it has one: the tail alone
  // loses what was originally asked.
  let source = null;
  try {
    source = getThread ? getThread(String(sourceId)) : null;
  } catch {
    // tail digest still applies
  }
  const recap =
    source && source.recap && source.recap.text
      ? `Recap:\n${source.recap.text}\n\n`
      : "";

  return (
    "[Hand-off context: the last messages of the source thread, truncated — " +
    "not the full transcript]\n" +
    recap +
    picked.join("\n\n") +
    "\n[End context]\n\n"
  );
}

/** Whole-note cap so a 400K-LOC repo yields the same size prompt as a small one. */
const CODEINDEX_NOTE_MAX = 3500;

/** Symbols listed per file before "+N more". */
const CODEINDEX_SYMBOLS_PER_FILE = 8;

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) with the shared per-repo symbol map. Agents reach for
 * grep first (CodeScaleBench: 7,993 keyword vs 57 deep-search), so the
 * value is injecting the map plus when-to-use-which-tool, not adding a tool.
 *
 * Returns "" when there is nothing to say: no index, a tiny repo, or
 * CODER_CODEINDEX_DISABLE=1. Same rule as planboardNoteFor / selfIdNoteFor.
 *
 * @param {import('./codeindex.js').CodeIndex | null | undefined} index
 * @returns {string}
 */
function codeIndexNoteFor(index) {
  if (!index) return "";
  if (process.env.CODER_CODEINDEX_DISABLE === "1") return "";
  const { MIN_FILES_FOR_NOTE } = require("./codeindex.js");
  if (index.fileCount < MIN_FILES_FOR_NOTE) return "";

  const { formatWikiNote, wikiFromIndex, parseDependencies } = require("./codewiki.js");
  const wiki = wikiFromIndex(index, {
    dependencies: index.repoRoot ? parseDependencies(index.repoRoot) : [],
    headSha: index.headSha,
  });
  const wikiNote = formatWikiNote(wiki);

  const age = ageOf(index.updatedAt);
  const header =
    `\n\n[Code map] Shared symbol index of this repo: ${index.fileCount} files, ` +
    `${index.symbolCount} symbols, built ${age}. It maps the project's MAIN ` +
    `checkout and is shared by every thread and worktree, so files created ` +
    `on a branch may be missing.`;
  const steering =
    "Use the map to jump straight to the file that owns a symbol instead of " +
    "grepping to orient yourself. Grep is still right for literal strings, " +
    "call sites, and anything not listed. Read the file before editing it.";

  const parts = [header];
  const files = Array.isArray(index.files) ? index.files : [];
  for (const file of files) {
    if (!file || !file.path) continue;
    // A path with no extracted symbols says nothing the agent can act on, and
    // the note's char budget is the scarce thing here.
    if (!Array.isArray(file.symbols) || file.symbols.length === 0) continue;
    const line = formatIndexFileLine(file);
    const candidate = parts.concat(line, steering).join("\n");
    if (candidate.length > CODEINDEX_NOTE_MAX) break;
    parts.push(line);
  }
  parts.push(steering);
  return wikiNote + parts.join("\n");
}

/**
 * @param {unknown} updatedAt
 * @returns {string}
 */
function ageOf(updatedAt) {
  const ms = Date.now() - Number(updatedAt);
  if (!Number.isFinite(ms) || ms < 45_000) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? "1 day ago" : `${day} days ago`;
}

/**
 * @param {{ path?: string, symbols?: string[] }} file
 * @returns {string}
 */
function formatIndexFileLine(file) {
  const symbols = Array.isArray(file.symbols) ? file.symbols : [];
  const shown = symbols.slice(0, CODEINDEX_SYMBOLS_PER_FILE);
  const extra = symbols.length - shown.length;
  let names = shown.join(", ");
  if (extra > 0) names = names ? `${names}, +${extra} more` : `+${extra} more`;
  return names ? `${file.path} - ${names}` : String(file.path);
}

module.exports = {
  THREAD_TITLE_MAX,
  THREAD_NOTES_MAX,
  FELT_ESTIMATE_MAX_MS,
  HYPOTHESES_MAX,
  HYPOTHESIS_CLAIM_MAX,
  HYPOTHESIS_REASON_MAX,
  HYPOTHESIS_STATUSES,
  SUGGESTIONS_MAX,
  SUGGESTION_TITLE_MAX,
  SUGGESTION_PROMPT_MAX,
  SUGGESTION_RESOLVE_STATUSES,
  truncateThreadTitle,
  resolveOrdinaryForkTitle,
  resolveWorkerTitle,
  normalizeModelForProvider,
  isKnownProviderId,
  HANDOFF_MESSAGE_MAX,
  HANDOFF_MESSAGE_COUNT,
  PLANBOARD_NOTE,
  CODEX_COMPUTER_USE_NOTE,
  planboardNoteFor,
  selfIdNoteFor,
  suggestedWorkNoteFor,
  codexComputerUseNoteFor,
  hypothesisNoteFor,
  planStepsFrom,
  buildHandoffPrefix,
  codeIndexNoteFor,
};
