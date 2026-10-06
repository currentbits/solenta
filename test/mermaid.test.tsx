/**
 * ```mermaid fences (#1506): drawn as a diagram once the lazy chunk renders,
 * code while it loads, on a parse error, and while the fence is still in the
 * growing tail of a streaming reply.
 *
 * Run: node --import=./test/support/render.mjs --test test/mermaid.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { MarkdownBody } from "../src/components/Markdown";
import { mermaidRenderer } from "../src/components/MermaidDiagram";

const FENCE = "```mermaid\ngraph TD\n  A --> B\n```";
const realRender = mermaidRenderer.render;

function stub(render: (code: string) => Promise<string | null>): string[] {
  const seen: string[] = [];
  mermaidRenderer.render = (code: string) => {
    seen.push(code);
    return render(code);
  };
  return seen;
}

/** Lazy chunk, render promise, then the state update. */
async function flush() {
  for (let i = 0; i < 3; i++) {
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("mermaid fences (#1506)", () => {
  afterEach(() => {
    mermaidRenderer.render = realRender;
    unmountAll();
  });

  it("swaps the code for the rendered diagram, keeping header and Copy", async () => {
    const seen = stub(async () => '<svg id="d"><text>A</text></svg>');
    const m = await mount(<MarkdownBody text={FENCE} />);
    await flush();
    assert.deepEqual(seen, ["graph TD\n  A --> B"]);
    const diagram = m.query("[data-mermaid]");
    assert.ok(diagram, "diagram mounted");
    assert.equal(diagram!.getAttribute("role"), "img");
    assert.ok(m.query("[data-mermaid] svg#d"));
    assert.equal(m.query("pre"), null, "code block replaced");
    assert.ok(m.byText("Copy"), "Copy stays for the source");
  });

  it("keeps the code block when the source does not parse", async () => {
    stub(async () => null);
    const m = await mount(<MarkdownBody text={"```mermaid\nnot a diagram\n```"} />);
    await flush();
    assert.equal(m.query("[data-mermaid]"), null);
    assert.match(m.query("pre")!.textContent ?? "", /not a diagram/);
  });

  it("keeps the code block when rendering throws", async () => {
    mermaidRenderer.render = () => Promise.reject(new Error("boom"));
    const m = await mount(<MarkdownBody text={FENCE} />);
    await flush();
    assert.equal(m.query("[data-mermaid]"), null);
    assert.ok(m.query("pre"));
  });

  it("shows code while the fence is in the streaming tail, the diagram once settled", async () => {
    const seen = stub(async () => "<svg></svg>");
    const open = await mount(
      <MarkdownBody text={"Intro\n\n```mermaid\ngraph TD\n  A -->"} streaming />,
    );
    await flush();
    assert.equal(open.query("[data-mermaid]"), null, "open fence stays code");
    assert.deepEqual(seen, [], "nothing rendered for a half-written fence");
    open.unmount();

    const settled = await mount(
      <MarkdownBody text={`Intro\n\n${FENCE}\n\nNext paragraph`} streaming />,
    );
    await flush();
    assert.ok(settled.query("[data-mermaid]"), "a settled chunk draws");
  });

  it("other languages never load the mermaid chunk", async () => {
    const seen = stub(async () => "<svg></svg>");
    await mount(<MarkdownBody text={"```ts\nconst x = 1;\n```"} />);
    await flush();
    assert.deepEqual(seen, []);
  });
});

describe("mermaid sanitiser (#1506)", () => {
  it("strips script, event handlers, foreignObject HTML and javascript: links", async () => {
    const { sanitizeSvg } = await import("../src/mermaidEngine");
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.n{fill:red}</style>' +
        '<script>alert(1)</script><g onclick="alert(2)"><text>ok</text></g>' +
        '<foreignObject><div><img src="x" onerror="alert(3)"></div></foreignObject>' +
        '<a href="javascript:alert(4)"><text>link</text></a></svg>',
    );
    assert.doesNotMatch(out, /<script|onclick|onerror|javascript:|foreignObject/i);
    assert.match(out, /<style>\.n\{fill:red\}<\/style>/, "theme CSS kept");
    assert.match(out, /<text>ok<\/text>/);
  });
});

describe("chunk settling (#1506)", () => {
  it("keeps code blocks mounted when the streaming tail settles", async () => {
    const text = "Intro\n\n```ts\nconst x = 1;\n```";
    const m = await mount(<MarkdownBody text={text} streaming />);
    const pre = m.query("pre");
    await m.rerender(<MarkdownBody text={`${text}\n\nNext`} streaming />);
    assert.equal(m.query("pre"), pre, "same <pre> node, not a remount");
  });
});
