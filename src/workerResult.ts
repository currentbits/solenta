import type { ChatMessage } from "./shared/ipc";

/** One worker's structured result in a wake notice (#1427). */
export interface WorkerResult {
  workerId: string;
  title: string;
  status: string;
  lastReply: string;
  /** Diffstat, verify, ruled-out and open items, as the runner wrote them. */
  body: string;
}

/**
 * Head line from queueOrchNotice, then the fence workerResultBlock
 * (electron/runner-orch-notices.js) appends. Keep the two in step.
 */
const RESULT =
  /^(?:\[orchestration\] )?Worker thread (\S+)(?: \("(.*?)"\))? finished with status (\w+)\.(.*)\n\[worker result \1\]\n([\s\S]*?)\n\[\/worker result\]$/gm;

export function workerResults(
  message: Pick<ChatMessage, "role" | "text" | "fromNotice">,
): WorkerResult[] {
  if (message.role !== "user" || message.fromNotice !== true) return [];
  const out: WorkerResult[] = [];
  for (const m of message.text.matchAll(RESULT)) {
    const reply = /^ Last reply: (.*?)(?: Its work is still only on branch |$)/.exec(m[4] ?? "");
    out.push({
      workerId: m[1]!,
      title: m[2] ?? "",
      status: m[3]!,
      lastReply: reply?.[1] ?? "",
      body: m[5] ?? "",
    });
  }
  return out;
}

/**
 * Notice lines outside every result fence (peer messages, crew lines,
 * failures), minus the standing footer. They stay visible next to the card.
 */
export function noticeRest(text: string): string {
  return text
    .replace(RESULT, "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("Continue orchestrating"))
    .join("\n");
}
