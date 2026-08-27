/**
 * Markdown component, mounted for real: fenced blocks get a header with a
 * working Copy button, inline code stays inline, and raw HTML in agent output
 * is dropped (never executed).
 *
 * Run: node --import=./test/support/render.mjs --test test/markdown.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
import { mount, inAct } from "./support/dom.ts";
import { Markdown } from "../src/components/Markdown";
import { PathLinkProvider } from "../src/components/PathLinks";

describe("Markdown", () => {
  it("renders plain paragraphs", async () => {
    const m = await mount(<Markdown text={"first\n\nsecond"} />);
    const paras = m.container.querySelectorAll("p");
    assert.equal(paras.length, 2);
    assert.match(m.text(), /first/);
    assert.match(m.text(), /second/);
  });

  it("fenced code gets a language header and a Copy button", async () => {
    const m = await mount(<Markdown text={"```ts\nconst x = 1;\n```"} />);
    assert.match(m.text(), /ts/);
    const btn = m.byText("Copy");
    assert.ok(btn, "Copy button present");
    assert.match(m.text(), /const x = 1;/);
  });

  it("Copy writes the code to the clipboard and flips the label", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (t: string) => {
          writes.push(t);
        },
      },
      configurable: true,
    });
    const m = await mount(<Markdown text={"```\nhello code\n```"} />);
    await m.click(m.byText("Copy"));
    assert.deepEqual(writes, ["hello code"]);
    assert.ok(m.byText("Copied"), "label flips after copy");
  });

  it("inline code has no header or Copy button", async () => {
    const m = await mount(<Markdown text={"use `npm test` to verify"} />);
    assert.equal(m.byText("Copy"), null);
    const code = m.container.querySelector("p code");
    assert.ok(code, "inline code element present");
    assert.equal(code.textContent, "npm test");
  });

  it("raw HTML in agent output is not rendered", async () => {
    const m = await mount(
      <Markdown text={"before<script>alert(1)</script>after"} />,
    );
    assert.equal(m.container.querySelector("script"), null);
  });

  it("throttles the re-parse while text streams in", async () => {
    // Streaming pushes new text several times a second and every push re-parses
    // the whole message, so without this the cost is O(n^2) over a run.
    let push: (t: string) => void = () => {};
    function Streaming() {
      const [text, setText] = useState("one");
      push = setText;
      return <Markdown text={text} />;
    }
    const m = await mount(<Streaming />);
    assert.equal(m.text(), "one");

    // First chunk after mount draws straight away: a reply must start showing.
    await inAct(() => push("one two"));
    await m.flush();
    assert.equal(m.text(), "one two");

    // The next one lands within the interval, so it waits.
    await inAct(() => push("one two three"));
    await m.flush();
    assert.equal(m.text(), "one two", "a chunk right after a parse waits");

    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    assert.equal(m.text(), "one two three", "and lands once the interval passes");
  });

  it("links open externally with noreferrer", async () => {
    const m = await mount(<Markdown text={"[docs](https://example.com)"} />);
    const a = m.container.querySelector("a");
    assert.ok(a);
    assert.equal(a.getAttribute("target"), "_blank");
    assert.equal(a.getAttribute("rel"), "noreferrer");
    assert.equal(a.getAttribute("href"), "https://example.com");
  });
});

const EXISTING = new Set(["src/foo.ts", "images/1.jpg"]);

function linked(
  text: string,
  opened: string[] = [],
  loadImage?: (abs: string) => Promise<string | null>,
) {
  return (
    <PathLinkProvider
      resolvePaths={(paths) =>
        Object.fromEntries(
          paths.map((p) => [p, EXISTING.has(p) ? `/wt/${p}` : null]),
        )
      }
      openPath={(abs, opts) => {
        opened.push(opts?.reveal ? `reveal:${abs}` : abs);
      }}
      loadImage={loadImage}
    >
      <Markdown text={text} />
    </PathLinkProvider>
  );
}

describe("Markdown path links", () => {
  it("makes a relative file clickable and opens the worktree path", async () => {
    const opened: string[] = [];
    const m = await mount(linked("see `src/foo.ts` please", opened));
    await m.flush();
    const link = m.container.querySelector("[data-path-link]");
    assert.ok(link, "existing relative path is a link");
    assert.equal(link.getAttribute("data-path-link"), "src/foo.ts");
    await m.click(link);
    assert.deepEqual(opened, ["/wt/src/foo.ts"]);
  });

  it("does not link a missing file", async () => {
    const m = await mount(linked("see `src/missing.ts` please"));
    await m.flush();
    assert.equal(m.container.querySelector("[data-path-link]"), null);
    assert.match(m.text(), /src\/missing\.ts/);
  });

  it("strips :12 when opening file:12", async () => {
    const opened: string[] = [];
    const m = await mount(linked("see `src/foo.ts:12`", opened));
    await m.flush();
    const link = m.container.querySelector("[data-path-link]");
    assert.ok(link);
    assert.equal(link.getAttribute("data-path-link"), "src/foo.ts");
    assert.equal(link.getAttribute("data-path-line"), "12");
    await m.click(link);
    assert.deepEqual(opened, ["/wt/src/foo.ts"]);
  });

  it("leaves http links alone", async () => {
    const m = await mount(linked("[docs](https://example.com/src/foo.ts)"));
    await m.flush();
    assert.equal(m.container.querySelector("[data-path-link]"), null);
    const a = m.container.querySelector("a");
    assert.ok(a);
    assert.equal(a.getAttribute("href"), "https://example.com/src/foo.ts");
  });
});

describe("Markdown images", () => {
  it("keeps https srcs", async () => {
    const m = await mount(
      <Markdown text={"![shot](https://example.com/a.jpg)"} />,
    );
    await m.flush();
    const img = m.container.querySelector("img");
    assert.ok(img);
    assert.equal(img.getAttribute("src"), "https://example.com/a.jpg");
    assert.equal(img.getAttribute("alt"), "shot");
  });

  it("loads a workspace image when resolvePaths is async", async () => {
    const asked: string[] = [];
    const m = await mount(
      <PathLinkProvider
        resolvePaths={async (paths) =>
          Object.fromEntries(
            paths.map((p) => [p, EXISTING.has(p) ? `/wt/${p}` : null]),
          )
        }
        openPath={() => {}}
        loadImage={async (abs) => {
          asked.push(abs);
          return "solenta-media://local/?p=async";
        }}
      >
        <Markdown text={"![chart](images/1.jpg)"} />
      </PathLinkProvider>,
    );
    await m.flush();
    await m.flush();
    await m.flush();
    assert.deepEqual(asked, ["/wt/images/1.jpg"]);
    assert.equal(
      m.container.querySelector("img")?.getAttribute("src"),
      "solenta-media://local/?p=async",
    );
  });

  it("loads a workspace-relative image through loadImage, not the relative src", async () => {
    const asked: string[] = [];
    const m = await mount(
      linked("![5k run](images/1.jpg)", [], async (abs) => {
        asked.push(abs);
        return "solenta-media://local/?p=1";
      }),
    );
    await m.flush();
    await m.flush();
    assert.deepEqual(asked, ["/wt/images/1.jpg"]);
    const img = m.container.querySelector("img");
    assert.ok(img, `workspace image must render, got: ${m.html().slice(0, 300)}`);
    assert.equal(img.getAttribute("src"), "solenta-media://local/?p=1");
    assert.equal(img.getAttribute("alt"), "5k run");
  });

  it("does not render a broken img for a missing local path", async () => {
    const m = await mount(
      linked("![missing](images/nope.jpg)", [], async () => null),
    );
    await m.flush();
    await m.flush();
    assert.equal(m.container.querySelector("img"), null);
  });

  it("allows data URLs that react-markdown would otherwise strip", async () => {
    const data = "data:image/png;base64,AAAA";
    const m = await mount(<Markdown text={`![x](${data})`} />);
    await m.flush();
    const img = m.container.querySelector("img");
    assert.ok(img);
    assert.equal(img.getAttribute("src"), data);
  });

  it("does not turn javascript: into an img src", async () => {
    const m = await mount(
      <Markdown text={'![x](javascript:alert(1))'} />,
    );
    await m.flush();
    const img = m.container.querySelector("img");
    if (img) {
      assert.notEqual(img.getAttribute("src"), "javascript:alert(1)");
    }
  });
});

