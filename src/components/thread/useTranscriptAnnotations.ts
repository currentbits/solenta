import { useMemo } from "react";
import type { ChatMessage, ThreadDetail, WorkLogItem } from "../../shared/ipc";
import {
  workLogDurationLabel,
  type TimelineEntry,
  type WorkLogGroup,
} from "../../timeline";
import { mapRunHeaders, type RunHeader } from "../../runHeader";
import { formatElapsed } from "../../format";
import { liveWorkingLabel } from "../../workingLabel";
import {
  latestTurnKey,
  mapFocusTurns,
  type FocusTurnSummary,
} from "../../focusView";
import { useRunDurationEnabled } from "../../uiPrefs";
import { messageProvenance, type MessageProvenance } from "../../provenance";

/** Per-message transcript annotations and the live working label. */
export function useTranscriptAnnotations({
  detail,
  timeline,
  summaryMode,
  isWorking,
  expandedFocusTurns,
  runningAgents,
}: {
  detail: ThreadDetail | null;
  timeline: TimelineEntry[];
  summaryMode: boolean;
  isWorking: boolean;
  expandedFocusTurns: ReadonlySet<string>;
  runningAgents: number;
}) {
  /** Run duration per runId, for assistant-message meta footers. Opt-in. */
  const showRunDuration = useRunDurationEnabled();
  const focusTurns = useMemo(() => {
    if (!detail || !summaryMode) return [];
    return mapFocusTurns(detail.messages, {
      liveTurnKey: isWorking ? latestTurnKey(detail.messages) : null,
    });
  }, [detail, summaryMode, isWorking]);
  const hiddenFocusActivity = useMemo(() => {
    const hidden = new Set<string>();
    if (!summaryMode) return hidden;
    for (const turn of focusTurns) {
      if (turn.live || expandedFocusTurns.has(turn.key)) continue;
      for (const id of turn.activityIds) hidden.add(id);
    }
    return hidden;
  }, [summaryMode, focusTurns, expandedFocusTurns]);
  const focusTurnByFirstId = useMemo(() => {
    const map = new Map<string, FocusTurnSummary>();
    for (const turn of focusTurns) map.set(turn.firstActivityId, turn);
    return map;
  }, [focusTurns]);
  const durationByRunId = useMemo(() => {
    const map = new Map<string, string>();
    if (!detail || !showRunDuration) return map;
    const byRun = new Map<string, WorkLogItem[]>();
    for (const item of detail.workLog) {
      const list = byRun.get(item.runId);
      if (list) list.push(item);
      else byRun.set(item.runId, [item]);
    }
    for (const [runId, items] of byRun) {
      const label = workLogDurationLabel(items);
      if (label) map.set(runId, label);
    }
    return map;
  }, [detail, showRunDuration]);

  /** "Worked for" header per completed run, keyed by its first message. */
  const headerByMessageId = useMemo(() => {
    const map = new Map<string, RunHeader>();
    if (!detail) return map;
    for (const header of mapRunHeaders(detail.messages, detail.thread.status)) {
      map.set(header.firstMessageId, header);
    }
    return map;
  }, [detail]);

  /**
   * Provenance tiers per assistant message (issue #404), computed over the
   * raw message list so turn boundaries (previous user message) are intact.
   */
  const provenanceById = useMemo(() => {
    const map = new Map<string, MessageProvenance>();
    if (!detail) return map;
    for (let i = 0; i < detail.messages.length; i++) {
      if (detail.messages[i].role !== "assistant") continue;
      const prov = messageProvenance(detail.messages, i);
      if (prov) map.set(detail.messages[i].id, prov);
    }
    return map;
  }, [detail]);

  const latestWorkLogRunId = useMemo(() => {
    let latest: WorkLogGroup | null = null;
    for (const entry of timeline) {
      if (entry.kind === "worklog") {
        if (!latest || entry.timestamp >= latest.timestamp) latest = entry;
      }
    }
    return latest?.runId ?? null;
  }, [timeline]);

  /**
   * Latest tool message of the most recent run; that card auto-expands and
   * stays open through completion (tool output and done arrive in the same
   * update, so keying off !done would collapse it before output ever shows).
   */
  const latestRunningToolId = useMemo(() => {
    if (!detail || !latestWorkLogRunId) return null;
    let latest: ChatMessage | null = null;
    for (const m of detail.messages) {
      if (m.role === "tool" && m.tool && m.runId === latestWorkLogRunId) {
        if (!latest || m.createdAt >= latest.createdAt) latest = m;
      }
    }
    return latest?.id ?? null;
  }, [detail, latestWorkLogRunId]);

  const latestThinkingId = useMemo(() => {
    if (!isWorking || !detail || !latestWorkLogRunId) return null;
    let latest: ChatMessage | null = null;
    for (const m of detail.messages) {
      if (m.thinking && m.runId === latestWorkLogRunId) {
        if (!latest || m.createdAt >= latest.createdAt) latest = m;
      }
    }
    if (!latest) return null;
    for (const m of detail.messages) {
      if (m.runId !== latestWorkLogRunId) continue;
      if (m.createdAt > latest.createdAt && !m.thinking) return null;
    }
    return latest.id;
  }, [detail, isWorking, latestWorkLogRunId]);
  const runningToolSummary = useMemo(() => {
    if (!isWorking || !detail || !latestWorkLogRunId) return null;
    let latest: ChatMessage | null = null;
    for (const m of detail.messages) {
      if (
        m.role === "tool" &&
        m.tool &&
        !m.tool.done &&
        m.runId === latestWorkLogRunId
      ) {
        if (!latest || m.createdAt >= latest.createdAt) latest = m;
      }
    }
    return latest?.text ?? null;
  }, [detail, isWorking, latestWorkLogRunId]);
  const thinkingLive = Boolean(latestThinkingId);
  /**
   * The assistant message currently being written. While a tool runs the
   * last message is the tool call itself, so the caret correctly disappears.
   */
  const streamingMessageId = (() => {
    if (!isWorking || !detail || detail.messages.length === 0) return null;
    const last = detail.messages[detail.messages.length - 1];
    return last.role === "assistant" ? last.id : null;
  })();
  const stalledAt =
    isWorking && detail?.thread.stalledAt != null
      ? detail.thread.stalledAt
      : null;
  const workingLabel = liveWorkingLabel({
    stalledElapsed: stalledAt != null ? formatElapsed(stalledAt) : null,
    workflowRunning: detail?.workflow ? runningAgents : null,
    toolSummary: runningToolSummary,
    thinking: thinkingLive,
  });
  return {
    hiddenFocusActivity,
    focusTurnByFirstId,
    durationByRunId,
    headerByMessageId,
    provenanceById,
    latestRunningToolId,
    latestThinkingId,
    streamingMessageId,
    stalledAt,
    workingLabel,
  };
}
