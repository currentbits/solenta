import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export interface DescriptionTask { start: number; end: number }
const parser = unified().use(remarkParse).use(remarkGfm);

/** Source offsets come from the same GFM parser used by the rendered markdown. */
export function descriptionTasks(body: string): DescriptionTask[] {
  const result: DescriptionTask[] = [];
  function visit(node: { type: string; checked?: boolean | null; position?: { start: { offset?: number }; end: { offset?: number } }; children?: typeof node[] }) {
    if (node.type === "listItem" && "checked" in node && typeof node.checked === "boolean") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start != null && end != null) result.push({ start, end });
    }
    if (node.children) for (const child of node.children) visit(child);
  }
  visit(parser.parse(body));
  return result;
}

function taskLabel(raw: string): string {
  return raw.split(/\r?\n/, 1)[0].replace(/^(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\][ \t]*/, "");
}

const conflict = () => new Error("This checklist changed on the server. Reload the pull request and try again.");

/** Change one marker byte only. Never match by label or touch code-fence text. */
export function toggleDescriptionTask(original: string, latest: string, task: DescriptionTask): string {
  if (!descriptionTasks(original).some((t) => t.start === task.start && t.end === task.end)) throw conflict();
  const raw = original.slice(task.start, task.end);
  const marker = /^(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/.exec(raw);
  if (!marker) throw conflict();
  let start = task.start;
  if (original !== latest) {
    // Ambiguous duplicate task items deliberately require a reload, even when
    // their current order happens to look unchanged. A reorder is not identity.
    const label = taskLabel(raw);
    const oldMatches = descriptionTasks(original).filter((t) => taskLabel(original.slice(t.start, t.end)) === label);
    const latestTasks = descriptionTasks(latest);
    const latestMatches = latestTasks.filter((t) => taskLabel(latest.slice(t.start, t.end)) === label);
    const matches = latestTasks.filter((t) => latest.slice(t.start, t.end) === raw);
    if (oldMatches.length !== 1 || latestMatches.length !== 1 || matches.length !== 1) throw conflict();
    start = matches[0].start;
  }
  const offset = start + marker[0].length - 2;
  return latest.slice(0, offset) + (marker[1] === " " ? "x" : " ") + latest.slice(offset + 1);
}
