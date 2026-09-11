import type { AttachmentInfo, PendingQuestion } from "./shared/ipc";

/**
 * Choice-only questions hide Other and file attach. Absent/true keeps the
 * custom-answer path both channels already have: blocking AskUserQuestion
 * answers are free-form strings, and persisted cards become the next turn.
 * Not a binary attachment field on the permission response (issue #1219).
 */
export function questionAllowsCustomAnswer(q: PendingQuestion): boolean {
  return q.customAnswer !== false;
}

export function formatAttachmentPathLine(a: AttachmentInfo): string {
  const label =
    a.kind === "folder" ? "Folder" : a.kind === "file" ? "File" : "Image";
  return `${label}: ${a.path}`;
}

/**
 * One question's submitted value: selected/typed text plus accessible saved
 * paths. File-only answers are the path lines, so they stay a valid submit.
 */
export function composeQuestionAnswerValue(
  picked: string,
  attachments: AttachmentInfo[] = [],
): string {
  const text = picked.trim();
  const lines = attachments.map(formatAttachmentPathLine);
  return [text, ...lines].filter(Boolean).join("\n");
}

/**
 * Answer text for a persisted question card (issue #647). The agent's turn is
 * already over, so this is an ordinary user message — and it repeats the
 * question, because on a session that could not resume it is the only record
 * of what was being answered.
 */
export function formatQuestionAnswer(answers: Record<string, string>): string {
  const lines = Object.entries(answers)
    .filter(([, picked]) => picked)
    .map(([question, picked]) => `${question}\n→ ${picked}`);
  return lines.length ? `Answering your question:\n\n${lines.join("\n\n")}` : "";
}

export const REMOTE_QUESTION_ATTACH_NOTE =
  "This agent is running remotely. Files on this machine cannot be opened there. Paste an excerpt, or copy the file into the remote workspace.";
