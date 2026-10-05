/**
 * Streaming-markdown cost benchmark (#1475, finding 4).
 *
 * Streams a ~45 KB reply into MarkdownBody the way PM2's fake agent did (~45 KB
 * per 25 s, delivered as `thread:updated` at 4 pushes/s, so ~450 chars a push)
 * and times each synchronous render + commit in jsdom. Unthrottled on purpose: this is the cost of one push, the thing the
 * throttle in Markdown paces. Compares one-shot parsing (every non-streaming
 * message, and every push before #1475) with the chunked streaming path.
 *
 * Run (one mode per process, jsdom keeps a lot alive):
 *   node --import=./test/support/render.mjs test/perf/markdownStream.bench.tsx one-shot
 *   node --import=./test/support/render.mjs test/perf/markdownStream.bench.tsx chunked
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarkdownBody } = await import("../../src/components/Markdown");

function section(i: number): string {
  return [
    `## Step ${i}: update the \`worker-${i}\` module`,
    "",
    `This paragraph explains change ${i} in some detail, with a [link](https://example.com/${i}), **bold**, _emphasis_ and \`inline code\`. It wraps over a couple of sentences so paragraphs look like a real answer.`,
    "",
    "- first point about the change",
    "- second point, with `src/components/Markdown.tsx`",
    "  continued on an indented line",
    "- third point",
    "",
    "```ts",
    `export function step${i}(input: string): string {`,
    "  const parts = input.split(\"\\n\");",
    "",
    "  return parts.map((p) => p.trim()).join(\" \");",
    "}",
    "```",
    "",
    "| file | change | lines |",
    "|---|---|---|",
    `| a${i}.ts | added | ${i * 3} |`,
    `| b${i}.ts | removed | ${i * 2} |`,
    "",
    "> Note: this is a quoted remark about the step.",
    "",
    "1. ordered one",
    "2. ordered two",
    "",
  ].join("\n");
}

let reply = "# Plan\n\n";
for (let i = 1; reply.length < 45_000; i++) reply += section(i);
reply = reply.slice(0, 45_000);

const CHUNK = 450;
const MARKS = [5_000, 20_000, 45_000];

function run(streaming: boolean) {
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  const costs: Array<[number, number]> = [];
  let total = 0;
  for (let n = CHUNK; ; n += CHUNK) {
    const text = reply.slice(0, Math.min(n, reply.length));
    const t0 = performance.now();
    act(() => root.render(<MarkdownBody text={text} streaming={streaming} />));
    const ms = performance.now() - t0;
    total += ms;
    costs.push([text.length, ms]);
    if (text.length === reply.length) break;
  }
  act(() => root.unmount());
  // Median of the 5 pushes ending at each mark: one push alone is noisy.
  const at = MARKS.map((mark) => {
    const near = costs
      .filter(([len]) => len <= mark && len > mark - CHUNK * 5)
      .map(([, ms]) => ms)
      .sort((a, b) => a - b);
    return near[near.length >> 1];
  });
  return { total, at, pushes: costs.length };
}

const streaming = process.argv[2] === "chunked";
run(streaming); // warm-up: JIT
const r = run(streaming);
console.log(
  `${streaming ? "chunked " : "one-shot"}  pushes=${r.pushes}  ` +
    MARKS.map((m, i) => `${m / 1000}KB=${r.at[i].toFixed(2)}ms`).join("  ") +
    `  total=${(r.total / 1000).toFixed(2)}s`,
);
