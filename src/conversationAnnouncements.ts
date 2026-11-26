import type { ThreadDetail, ThreadStatus } from "./shared/ipc";

export type ConversationState = {
  key: string;
  kind: "permission" | "question" | "plan" | "input" | "external" | ThreadStatus;
  status: ThreadStatus;
  runStartedAt: number | null;
};

export function conversationState(detail: ThreadDetail): ConversationState {
  const { thread, pendingPermission: permission } = detail;
  let kind: ConversationState["kind"] = thread.status;
  let requestId = "";
  if (thread.pendingExternalApproval) {
    kind = "external"; requestId = thread.pairingId ?? thread.id;
  } else if (permission) {
    kind = permission.inputRequest ? "input" : permission.questions?.length ? "question" : permission.plan ? "plan" : "permission";
    requestId = permission.requestId;
  } else if (thread.pendingQuestion) {
    kind = "question"; requestId = thread.pendingQuestion.id;
  } else if (thread.pendingPlan) {
    kind = "plan"; requestId = thread.pendingPlan.id;
  } else if (thread.status === "working" && thread.awaitingInput) {
    kind = "input";
  }
  return {
    key: `${kind}:${requestId}:${!requestId && thread.status === "working" ? thread.runStartedAt ?? "" : ""}`,
    kind, status: thread.status, runStartedAt: thread.runStartedAt,
  };
}

/** Only transition summaries, never streamed tool arguments or error payloads. */
export function conversationAnnouncement(previous: ConversationState | null, next: ConversationState, detail: ThreadDetail, replies: boolean): string | null {
  if (previous?.key === next.key) return null;
  switch (next.kind) {
    case "external": return "An external agent is waiting for approval to start.";
    case "permission": return "Permission needed. Review the request below the conversation.";
    case "question": return "A question needs your answer below the conversation.";
    case "plan": return "A plan is ready for your review below the conversation.";
    case "input": return "Your input is needed below the conversation.";
    case "quota-wait": return "Run paused while waiting for provider quota.";
    case "failed": return "Run failed. Check the conversation for details.";
    case "working":
      if (!previous) return "Run in progress.";
      return previous.status === "quota-wait" || (previous.status === "working" && previous.runStartedAt === next.runStartedAt)
        ? "Run resumed." : "Run started.";
    case "idle":
    case "done": {
      if (previous?.status !== "working") return null;
      if (detail.thread.stoppedAt) return "Run stopped.";
      if (next.kind === "idle") return "Run ended.";
      const preview = replies ? finalReplyPreview(detail, previous.runStartedAt) : "";
      return `Run finished.${preview ? ` Reply: ${preview}` : ""}`;
    }
  }
}

export function finalReplyPreview(detail: ThreadDetail, startedAt: number | null): string {
  // Without a known run boundary, do not risk reading a reply from an older turn.
  if (startedAt == null) return "";
  for (let i = detail.messages.length - 1; i >= 0; i--) {
    const message = detail.messages[i];
    if (message.role !== "assistant" || message.thinking || !message.text.trim()) continue;
    if (message.createdAt < startedAt) return "";
    const plain = message.text
      .replace(/```[\s\S]*?(?:```|$)/g, " Code block in reply. ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, "")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ").trim();
    return plain.length > 600 ? `${plain.slice(0, 600).trimEnd()}…` : plain;
  }
  return "";
}
