import type { ChatMessage } from "./shared/ipc";

/**
 * Compact summary for a machine-origin orchestration notice.
 *
 * Returns null unless `fromNotice` is set and every line is a known routine
 * completion. A normal done notice includes the runner's merge/PR paragraph;
 * that boilerplate is peeled off before any actionable check and summarized
 * as a review decision. It must not, by itself, keep the row expanded.
 * Unflagged lookalikes, failures, real questions, permissions, merge asks in
 * the reply itself, and anything unrecognized stay fully visible. The caller
 * still renders the original text unchanged.
 */
const NOTICE_FOOTER = "Continue orchestrating; thread_status has full details.";

/** Signals in the reply or crew note. Not applied to the landing paragraph. */
const REAL_ACTION =
  /\?|\b(?:failed|stopped|blocked|undeliverable)\b|not delivered|\bpermissions?\b|\bapprov(?:e|es|al|ed|ing)\b/i;

/** A merge/PR ask in the reply itself. The canned paragraph contains these too. */
const DIRECT_MERGE_ASK = /\bthread_merge\b|\bthread_pr\b/i;

/**
 * Requests and soft failures that do not use "?" or the word "failed".
 * A handful of anchored phrases, not a parser: anything else still has to
 * match a known routine line before it can fold.
 */
const CLEAR_REQUEST =
  /\bneeds? your input\b|\bwaiting for your (?:decision|input)\b|\bplease choose\b|\bunable to\b|\berrored\b/i;

const RESULT_MAX = 80;
const TITLE_MAX = 48;

interface WorkerItem {
  kind: "worker";
  title: string;
  lastReply: string;
  landing: boolean;
}

interface CrewItem {
  kind: "crew";
  id: string;
  title: string;
  note: string;
  unblocked: string[];
}

type ActivityItem = WorkerItem | CrewItem;

/** Exact paragraph queueOrchNotice appends for a done worker with a worktree. */
function cannedLandingSuffix(threadId: string, branch: string): string {
  return (
    ` Its work is still only on branch ${branch}:` +
    ` check it, then tell the user what it built and ask whether to merge` +
    ` it (thread_merge) or open a pull request (thread_pr) with` +
    ` workerThreadId ${threadId}. Do not land it before they answer \u2014` +
    ` not even onto your own branch. If other workers have finished too,` +
    ` ask about all of them in one question and name the order you would` +
    ` land them in.`
  );
}

/**
 * Peel that exact paragraph off the end of a done line. Anything else after
 * the branch marker, including a shorter or extended tail, stays visible.
 */
function peelLanding(
  rest: string,
  threadId: string,
): { rest: string; landing: boolean } | null {
  const marker = " Its work is still only on branch ";
  const at = rest.lastIndexOf(marker);
  if (at < 0) return { rest, landing: false };
  const suffix = rest.slice(at);
  const branch = /^ Its work is still only on branch (\S+|\(its own\)):/.exec(
    suffix,
  );
  if (!branch || suffix !== cannedLandingSuffix(threadId, branch[1]!)) {
    return null;
  }
  return { rest: rest.slice(0, at), landing: true };
}

function replyIsActionable(text: string): boolean {
  return (
    REAL_ACTION.test(text) ||
    DIRECT_MERGE_ASK.test(text) ||
    CLEAR_REQUEST.test(text)
  );
}

function parseWorkerDone(line: string): WorkerItem | null {
  const match =
    /^(?:\[orchestration\] )?Worker thread (\S+)(?: \("([^"]*)"\))? finished with status done\.(.*)$/.exec(
      line,
    );
  if (!match) return null;
  const threadId = match[1]!;
  const landed = peelLanding(match[3] ?? "", threadId);
  if (!landed) return null;
  const rest = landed.rest;
  let lastReply = "";
  if (rest.startsWith(" Last reply: ")) {
    lastReply = rest.slice(" Last reply: ".length);
  } else if (rest.length > 0) {
    return null;
  }
  if (replyIsActionable(lastReply)) return null;
  return {
    kind: "worker",
    title: match[2] ?? "",
    lastReply,
    landing: landed.landing,
  };
}

function parseCrew(line: string): CrewItem | null {
  const match = /^\[crew\] finished (\S+) \("([^"]*)"\)(.*)$/.exec(line);
  if (!match) return null;
  let rest = match[3] ?? "";
  let unblocked: string[] = [];
  if (rest.includes("Unblocked:")) {
    const tail =
      /^(.*)\. Unblocked: ([A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*)$/.exec(rest);
    if (!tail) return null;
    rest = tail[1] ?? "";
    unblocked = (tail[2] ?? "").split(", ").filter(Boolean);
  }
  let note = "";
  if (rest.startsWith(": ")) note = rest.slice(2);
  else if (rest.length > 0) return null;
  if (replyIsActionable(note)) return null;
  return {
    kind: "crew",
    id: match[1]!,
    title: match[2] ?? "",
    note,
    unblocked,
  };
}

function parseBody(lines: string[]): ActivityItem[] | null {
  const items: ActivityItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("[crew] ")) {
      const crew = parseCrew(line);
      if (!crew) return null;
      items.push(crew);
      continue;
    }
    const worker = parseWorkerDone(line);
    if (!worker) return null;
    items.push(worker);
  }
  return items.length > 0 ? items : null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const base = (space > 24 ? cut.slice(0, space) : cut).trimEnd();
  return `${base}\u2026`;
}

function joinSentences(parts: string[]): string {
  return parts
    .map((part) => part.replace(/\s+/g, " ").trim().replace(/\.+$/, ""))
    .filter(Boolean)
    .join(". ");
}

function quotedTitle(title: string): string | null {
  const flat = clip(title, TITLE_MAX);
  return flat ? `"${flat}"` : null;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function summarizeWorkers(workers: WorkerItem[]): string {
  if (workers.length === 1) {
    const title = quotedTitle(workers[0]!.title);
    return title ? `Worker ${title} finished` : "Worker finished";
  }
  const titles = workers.map((worker) => quotedTitle(worker.title));
  if (workers.length <= 3 && titles.every((title) => title != null)) {
    return `Workers ${joinNames(titles as string[])} finished`;
  }
  return `${workers.length} workers finished`;
}

function summarizeCrews(crews: CrewItem[]): string {
  if (crews.length === 1) {
    const crew = crews[0]!;
    const title = quotedTitle(crew.title);
    const parts = [
      title ? `Crew task ${title} finished` : `Crew task ${crew.id} finished`,
    ];
    const note = clip(crew.note, RESULT_MAX);
    if (note) parts.push(note);
    if (crew.unblocked.length > 0) {
      parts.push(`Unblocked ${crew.unblocked.join(", ")}`);
    }
    return joinSentences(parts);
  }
  const titles = crews.map((crew) => quotedTitle(crew.title));
  if (crews.length <= 3 && titles.every((title) => title != null)) {
    return `Crew tasks ${joinNames(titles as string[])} finished`;
  }
  return `${crews.length} crew tasks finished`;
}

function summarize(items: ActivityItem[]): string {
  if (items.length === 1) {
    const item = items[0]!;
    if (item.kind === "worker") {
      const parts = [summarizeWorkers([item])];
      const reply = clip(item.lastReply, RESULT_MAX);
      if (reply) parts.push(reply);
      if (item.landing) parts.push("Merge or pull request decision waiting");
      return joinSentences(parts);
    }
    return summarizeCrews([item]);
  }
  const workers = items.filter((item): item is WorkerItem => item.kind === "worker");
  const crews = items.filter((item): item is CrewItem => item.kind === "crew");
  const parts: string[] = [];
  if (workers.length > 0) parts.push(summarizeWorkers(workers));
  if (crews.length > 0) parts.push(summarizeCrews(crews));
  if (workers.some((worker) => worker.landing)) {
    parts.push("Merge or pull request decision waiting");
  }
  return joinSentences(parts);
}

export function routineWorkerActivitySummary(
  message: Pick<
    ChatMessage,
    "role" | "text" | "fromNotice" | "fromThread" | "attachments" | "steer"
  >,
): string | null {
  if (message.role !== "user" || message.fromNotice !== true) return null;
  if (message.fromThread || message.steer) return null;
  if (message.attachments && message.attachments.length > 0) return null;
  const lines = message.text.split(/\r?\n/);
  if (lines.length < 2 || lines[lines.length - 1] !== NOTICE_FOOTER) return null;
  const body = lines.slice(0, -1);
  if (body.length === 0 || body.some((line) => line.length === 0)) return null;
  const items = parseBody(body);
  if (!items) return null;
  return summarize(items);
}
