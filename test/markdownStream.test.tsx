/**
 * Streaming markdown is parsed in chunks (#1475): settled blocks keep their
 * parse, only the growing last chunk re-parses. The rendered output must be
 * exactly what one parse of the same text gives, at every point of the stream.
 *
 * Run: node --import=./test/support/render.mjs --test test/markdownStream.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mount } from "./support/dom.ts";
import {
  MarkdownBody,
  clearParsedMarkdown,
  markdownParses,
} from "../src/components/Markdown";
import { markdownChunks } from "../src/components/markdownChunks";

const CORPUS: Record<string, string> = {
  mixed: [
    "# Title",
    "",
    "Intro with a [link](https://example.com) and `code`.",
    "Setext heading",
    "---",
    "",
    "- tight item",
    "- another",
    "",
    "Paragraph between lists.",
    "",
    "1. ordered",
    "2. more",
    "",
    "3. continues loosely",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> quote line",
    "> - list in quote",
    "",
    "- [ ] task",
    "- [x] done",
    "",
    "***",
    "",
    "Visit https://autolink.example and ~~strike~~.",
  ].join("\n"),
  fences: [
    "Before.",
    "",
    "```ts title",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "~~~",
    "``` not a close",
    "",
    "still code",
    "~~~",
    "",
    "````md",
    "```",
    "",
    "inner",
    "```",
    "````",
    "",
    "After.",
  ].join("\n"),
  nested: [
    "- item with code:",
    "",
    "  ```",
    "  code",
    "",
    "  more code",
    "  ```",
    "",
    "  continued paragraph",
    "",
    "- second item",
    "",
    "Outside.",
    "",
    "    indented code",
    "",
    "    more indented",
    "",
    "Done.",
  ].join("\n"),
  html: [
    "Para.",
    "",
    "<details>",
    "<summary>x</summary>",
    "",
    "Inside details.",
    "",
    "</details>",
    "",
    "End.",
  ].join("\n"),
  htmlFirst: "<div>\n\nb\n\nc",
  reference: [
    "See [the docs][docs] and a note[^1].",
    "",
    "More text.",
    "",
    "[docs]: https://example.com/docs",
    "",
    "[^1]: The footnote.",
  ].join("\n"),
  comment: ["A.", "", "<!--", "", "hidden", "", "-->", "", "B."].join("\n"),
};

const html = (text: string, streaming: boolean) =>
  renderToStaticMarkup(<MarkdownBody text={text} streaming={streaming} />);

describe("streaming markdown chunks", () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`${name}: every char-by-char prefix renders like one parse`, () => {
      for (let n = 1; n <= text.length; n++) {
        const prefix = text.slice(0, n);
        assert.equal(html(prefix, true), html(prefix, false), `prefix ${n}`);
      }
    });
  }

  it("splits at blank lines before unindented blocks", () => {
    assert.deepEqual(markdownChunks("# H\n\npara\n\n| a |\n|---|\n"), [
      "# H\n\n",
      "para\n\n",
      "| a |\n|---|\n",
    ]);
  });

  it("never splits inside an open fence, whatever its marker", () => {
    assert.deepEqual(markdownChunks("```js x\na\n\nb"), ["```js x\na\n\nb"]);
    assert.deepEqual(markdownChunks("~~~\n```\n\nb\n~~~\n\nc"), [
      "~~~\n```\n\nb\n~~~\n\n",
      "c",
    ]);
    // A shorter closing run doesn't close a longer fence.
    assert.equal(markdownChunks("````\n```\n\nb").length, 1);
    // A closing fence can't carry an info string.
    assert.equal(markdownChunks("```\n``` js\n\nb").length, 1);
  });

  it("keeps a list that continues across blank lines in one chunk", () => {
    assert.deepEqual(markdownChunks("- a\n\n- b\n\n1. c\n\nend"), [
      "- a\n\n- b\n\n1. c\n\n",
      "end",
    ]);
    assert.deepEqual(markdownChunks("para\n\n- a"), ["para\n\n", "- a"]);
  });

  it("keeps indented continuations with their block", () => {
    assert.deepEqual(markdownChunks("- a\n\n  more\n\nx"), [
      "- a\n\n  more\n\n",
      "x",
    ]);
  });

  it("never splits right after indented code", () => {
    assert.deepEqual(markdownChunks("    code\n\n3. z\n\nx"), [
      "    code\n\n3. z\n\n",
      "x",
    ]);
    assert.equal(markdownChunks("\t- tab list\n\n\n3. z").length, 1);
  });

  it("falls back to one chunk for definitions and spanning HTML", () => {
    for (const text of [
      "a [x]\n\nb\n\n[x]: /u",
      "a[^1]\n\nb\n\n[^1]: note",
      "> [x]: /u\n\nb",
      "a\n\n<!--\n\nb\n\n-->",
      "a\n\n<pre>\n\nb\n</pre>",
      "a\n\n<div>\n\nb",
      "<div>\n\nb\n\nc",
      "> q\n<div>\n```js\nx\n\ny\n```\n\nz",
    ]) {
      assert.deepEqual(markdownChunks(text), [text], text);
    }
  });

  it("random block mixes render like one parse (seeded fuzz)", () => {
    const blocks = [
      "para one\nlazy line", "Setext\n===", "---", "- a\n- b", "- a\n\n  cont",
      "1. x\n2. y", "3. z", "  - nested", "> quote\nlazy", "> q\n>\n> - li",
      "```js\nx\n\ny\n```", "~~~\n```\n~~~", "    indented\n\n    code",
      "| a | b |\n|---|---|\n| 1 | 2 |", "<div>\nhtml\n</div>", "<!-- c -->",
      "text <b>x</b>", "* star", "+ plus", "Term\n: def", "[x]", "  indented para",
      "\t- tab list", "***", "# H", "line  \nbreak", "```\nunclosed",
    ];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const seps = ["\n", "\n\n", "\n\n\n"];
    // ponytail: 1,500 keeps the file under the 20 s per-file limit on Windows
    // CI (6,000 took ~8 s locally, >20 s there). 24k mixes over 3 seeds ran
    // clean offline before merge; raise this locally when changing the splitter.
    for (let i = 0; i < 1_500; i++) {
      let text = "";
      for (let k = 2 + rand(6); k > 0; k--) {
        text += (text ? seps[rand(3)] : "") + blocks[rand(blocks.length)];
      }
      assert.equal(html(text, true), html(text, false), JSON.stringify(text));
    }
  });

  it("final DOM after a chunked stream equals a one-shot mount", async () => {
    const text = Object.values(CORPUS).slice(0, 3).join("\n\n");
    const one = await mount(<MarkdownBody text={text} />);
    const m = await mount(<MarkdownBody text="" streaming />);
    for (let n = 37; n < text.length; n += 37) {
      await m.rerender(<MarkdownBody text={text.slice(0, n)} streaming />);
    }
    await m.rerender(<MarkdownBody text={text} streaming />);
    assert.equal(m.html(), one.html(), "streaming state");
    await m.rerender(<MarkdownBody text={text} />);
    assert.equal(m.html(), one.html(), "after the stream ends");
  });

  it("re-parses only the tail when settled chunks don't change", async () => {
    const head = "# Head\n\nSettled paragraph.\n\n";
    const m = await mount(<MarkdownBody text={head + "tail"} streaming />);
    const before = markdownParses.count;
    await m.rerender(<MarkdownBody text={head + "tail grows"} streaming />);
    assert.equal(markdownParses.count - before, 1, "one parse: the tail");
    assert.match(m.text(), /tail grows/);
  });

  it("non-streaming text is one parse", async () => {
    clearParsedMarkdown();
    const before = markdownParses.count;
    await mount(<MarkdownBody text={"a\n\nb\n\nc"} />);
    assert.equal(markdownParses.count - before, 1);
  });

  it("a remount of the same text reuses the parse (thread switch back)", async () => {
    clearParsedMarkdown();
    const text = CORPUS.mixed!;
    const first = await mount(<MarkdownBody text={text} />);
    const html = first.html();
    first.unmount();
    const before = markdownParses.count;
    const again = await mount(<MarkdownBody text={text} />);
    assert.equal(markdownParses.count - before, 0, "served from the cache");
    assert.equal(again.html(), html);
  });

  it("does not cache the live tail of a streaming reply", async () => {
    clearParsedMarkdown();
    const head = "# Head\n\nSettled paragraph.\n\n";
    await mount(<MarkdownBody text={head + "tail"} streaming />);
    const before = markdownParses.count;
    await mount(<MarkdownBody text={head + "tail"} streaming />);
    assert.equal(markdownParses.count - before, 1, "head cached, tail re-parsed");
  });
});
