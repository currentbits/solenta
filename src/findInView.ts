/**
 * Find-in-thread / find-in-diffs (#1524).
 *
 * The transcript is a tail window and collapsed diffs are not mounted, so
 * ⌘F searches the loaded data and the UI scrolls/expands the hit. Do not
 * use Electron findInPage.
 */
import { matchesBinding } from "./keybindings";

export type TranscriptHit = { kind: "message" | "plan"; id: string };
export type DiffHit = { path: string };

export function unitMatches(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return text.toLowerCase().includes(q);
}

export function findTranscriptHits(
  input: {
    messages: readonly { id: string; text: string }[];
    plan?: string | null;
    planSteps?: readonly { step: string }[] | null;
  },
  query: string,
): TranscriptHit[] {
  if (!query.trim()) return [];
  const hits: TranscriptHit[] = [];
  const planParts = [
    input.plan ?? "",
    ...(input.planSteps ?? []).map((s) => s.step),
  ];
  if (planParts.some((t) => unitMatches(t, query))) {
    hits.push({ kind: "plan", id: "plan" });
  }
  for (const message of input.messages) {
    if (unitMatches(message.text, query)) {
      hits.push({ kind: "message", id: message.id });
    }
  }
  return hits;
}

export function findDiffHits(
  files: readonly { path: string }[],
  patches: readonly { path: string; text: string }[],
  query: string,
): DiffHit[] {
  if (!query.trim()) return [];
  const byPath = new Map(patches.map((p) => [p.path, p.text]));
  const hits: DiffHit[] = [];
  for (const file of files) {
    const patch = byPath.get(file.path);
    if (unitMatches(file.path, query) || (patch != null && unitMatches(patch, query))) {
      hits.push({ path: file.path });
    }
  }
  return hits;
}

export function stepIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + dir + total) % total;
}

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> & { code?: string; target?: EventTarget | null };

function inDiffSurface(target: EventTarget | null | undefined): boolean {
  if (target == null || typeof (target as { closest?: unknown }).closest !== "function") {
    return false;
  }
  return (target as Element).closest("[data-git-pane], [data-turn-diff]") != null;
}

/** Which find bar a key event should open. Shared ⌘F follows the cursor. */
export function findSurfaceForEvent(e: KeyLike): "transcript" | "diff" | null {
  const transcript = matchesBinding(e, "transcript.find");
  const diff = matchesBinding(e, "diff.find");
  if (!transcript && !diff) return null;
  if (transcript && diff) return inDiffSurface(e.target) ? "diff" : "transcript";
  if (diff && !transcript) return "diff";
  return "transcript";
}
