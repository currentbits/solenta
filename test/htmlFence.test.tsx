/**
 * ```html fences (#1525): sandboxed iframe once the lazy chunk renders,
 * code while streaming or over the size cap.
 *
 * Run: node --import=./test/support/render.mjs --test test/htmlFence.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, unmountAll, type Mounted } from "./support/dom.ts";
import { MarkdownBody } from "../src/components/Markdown";
import { HTML_MAX_CHARS, HTML_SANDBOX } from "../src/htmlPage";

const FENCE = "```html\n<h1>Hello</h1>\n```";

async function flush() {
  for (let i = 0; i < 3; i++) {
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// The page is a lazy chunk: a loaded CI runner can need more than a few ticks.
async function until(m: Mounted, sel: string) {
  for (let i = 0; i < 100 && !m.query(sel); i++) {
    // Inside act: a chunk resolving outside it trips the console gate.
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

describe("html fences (#1525)", () => {
  afterEach(() => {
    unmountAll();
  });

  it("swaps a settled fence for a sandboxed srcdoc iframe", async () => {
    const m = await mount(<MarkdownBody text={FENCE} />);
    await until(m, "[data-html-page] iframe");
    const frame = m.query("[data-html-page] iframe");
    assert.ok(frame, "iframe mounted");
    assert.equal(frame!.getAttribute("sandbox"), HTML_SANDBOX);
    assert.match(frame!.getAttribute("srcdoc") ?? "", /<h1>Hello<\/h1>/);
    assert.match(frame!.getAttribute("srcdoc") ?? "", /Content-Security-Policy/);
    assert.match(frame!.getAttribute("srcdoc") ?? "", /connect-src 'none'/);
    assert.ok(m.byText("Open in browser"), "escape hatch");
    assert.ok(m.byText("Copy"), "Copy stays for the source");
  });

  it("shows code while the fence is in the streaming tail, the page once settled", async () => {
    const open = await mount(
      <MarkdownBody text={"Intro\n\n```html\n<h1>partial"} streaming />,
    );
    await flush();
    assert.equal(open.query("[data-html-page]"), null, "open fence stays code");
    open.unmount();

    const settled = await mount(
      <MarkdownBody text={`Intro\n\n${FENCE}\n\nNext paragraph`} streaming />,
    );
    await until(settled, "[data-html-page]");
    assert.ok(settled.query("[data-html-page]"), "a settled chunk draws");
  });

  it("keeps the code block when the page is over the size cap", async () => {
    const big = "```html\n" + "x".repeat(HTML_MAX_CHARS + 1) + "\n```";
    const m = await mount(<MarkdownBody text={big} />);
    await flush();
    assert.equal(m.query("[data-html-page]"), null);
    assert.ok(m.query("pre"));
  });

  it("other languages never load an html page", async () => {
    const m = await mount(<MarkdownBody text={"```ts\nconst x = 1;\n```"} />);
    await flush();
    assert.equal(m.query("[data-html-page]"), null);
    assert.ok(m.query("pre"));
  });
});
