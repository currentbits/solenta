import type { ChatMessage, RunStatInfo, ThreadStatus } from "./shared/ipc";

export interface ReviewBar {
  runId: string;
  /** Last assistant message in this run; the bar anchors under it. */
  messageId: string;
  files: number;
  additions: number;
  deletions: number;
  sha: string;
  turn: number;
  /** Checkpoint that ended the state before this run; null for turn 1. */
  undoSha: string | null;
  undoTurn: number | null;
}

/** Unique runIds in first-seen message order, dropping an in-progress last run. */
export function completedRunIds(
  messages: ChatMessage[],
  threadStatus: ThreadStatus,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    const id = m.runId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (threadStatus === "working" && ids.length > 0) {
    ids.pop();
  }
  return ids;
}

export function formatReviewBarText(
  files: number,
  additions: number,
  deletions: number,
): string {
  const noun = files === 1 ? "file" : "files";
  return `Edited ${files} ${noun} · +${additions} -${deletions}`;
}

/**
 * Map completed runs to checkpoint turns 1:1 in order. A run with no
 * matching checkpoint (nothing edited) or no assistant message is omitted.
 */
export function mapReviewBars(input: {
  messages: ChatMessage[];
  stats: RunStatInfo[];
  threadStatus: ThreadStatus;
}): ReviewBar[] {
  const runIds = completedRunIds(input.messages, input.threadStatus);
  const stats = [...input.stats].sort((a, b) => a.turn - b.turn);
  const bars: ReviewBar[] = [];
  for (let i = 0; i < runIds.length; i++) {
    const runId = runIds[i]!;
    const turn = i + 1;
    const stat = stats.find((s) => s.turn === turn);
    if (!stat) continue;
    let lastAsst: ChatMessage | null = null;
    for (const m of input.messages) {
      if (m.role === "assistant" && m.runId === runId) lastAsst = m;
    }
    if (!lastAsst) continue;
    const prev = stats.find((s) => s.turn === stat.turn - 1) ?? null;
    bars.push({
      runId,
      messageId: lastAsst.id,
      files: stat.files,
      additions: stat.additions,
      deletions: stat.deletions,
      sha: stat.sha,
      turn: stat.turn,
      undoSha: prev?.sha ?? null,
      undoTurn: prev?.turn ?? null,
    });
  }
  return bars;
}
