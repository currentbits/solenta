/**
 * Git pane review views (#1493): scope toggle, lazy and "Show anyway"
 * per-file patches, split/wrap/whitespace toggles, syntax colour.
 *
 * Run: node --import=./test/support/render.mjs --test test/changesDiffViews.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, type Mounted } from "./support/dom.ts";
import { ChangesPanel } from "../src/components/thread/ChangesPanel";
import {
  languageForFence,
  languageForPath,
  splitHighlightedLines,
  useHighlightedLines,
} from "../src/syntaxHighlight";
import { diffHighlightGroups } from "../src/diffView";
import {
  getDiffScope,
  setDiffIgnoreWhitespace,
  setDiffScope,
  setDiffSplit,
  setDiffWrap,
} from "../src/uiPrefs";
import type { DiffOptions, DiffResult } from "../src/shared/ipc";

const patchFor = (path: string, add: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    " const keep = 1;",
    "-const old = 2;",
    `+${add}`,
  ].join("\n");

const DIFF: DiffResult = {
  files: [
    { path: "src/a.ts", status: "M", additions: 1, deletions: 1 },
    { path: "src/lazy.ts", status: "M", additions: 1, deletions: 1, patchOmitted: "lazy" },
    { path: "gen/big.json", status: "M", additions: 4000, deletions: 10, patchOmitted: "large" },
  ],
  patch: patchFor("src/a.ts", "const fresh = 3;"),
  truncated: false,
};

function mountPanel(respond: (opts?: DiffOptions) => DiffResult = () => DIFF) {
  const calls: Array<DiffOptions | undefined> = [];
  const staged: Array<string[] | null> = [];
  const m = mount(
    <ChangesPanel
      open
      threadId="t1"
      threadTitle="diffs"
      threadBranch="coder/diffs"
      planText=""
      openNonce={1}
      onFetchDiff={async (opts) => {
        calls.push(opts);
        return respond(opts);
      }}
      onCommit={async (message) => ({ subject: message })}
      onStagedPathsChange={(paths) => staged.push(paths)}
      onRevert={async (path) => ({ path })}
      onSuggest={async () => ({ message: "x" })}
      onComment={() => {}}
    />,
  );
  return { m, calls, staged };
}

const pressed = (view: Mounted, sel: string) =>
  view.query(sel)?.getAttribute("aria-pressed");

async function until(view: Mounted, ok: () => boolean, what: string) {
  for (let i = 0; i < 100 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 20));
    await view.flush();
  }
  assert.ok(ok(), what);
}

afterEach(() => {
  setDiffScope("t1", "uncommitted");
  setDiffSplit(false);
  setDiffWrap(false);
  setDiffIgnoreWhitespace(false);
});

describe("Git pane scope (#1493)", () => {
  it("defaults to Uncommitted with staging, and Whole branch is read-only and remembered", async () => {
    const { m, calls } = mountPanel((opts) =>
      opts?.scope === "branch" ? { ...DIFF, scopeLabel: "since main (abc1234)" } : DIFF,
    );
    const view = await m;
    await view.flush();
    assert.equal(calls[0], undefined, "default view sends no options");
    assert.equal(pressed(view, '[data-diff-scope="uncommitted"]'), "true");
    assert.ok(view.query("[data-stage-all]"));
    assert.ok(view.query("[data-commit-changes]"));

    await view.click(view.query('[data-diff-scope="branch"]'));
    await view.flush();
    assert.deepEqual(calls.at(-1), { scope: "branch" });
    assert.equal(pressed(view, '[data-diff-scope="branch"]'), "true");
    assert.equal(view.query("[data-diff-scope-label]")?.textContent, "since main (abc1234)");
    assert.equal(view.query("[data-stage-all]"), null, "no staging on a branch diff");
    assert.equal(view.query("[data-stage-file]"), null);
    assert.equal(view.query("[data-commit-changes]"), null);
    assert.ok(view.query("[data-review-hunk]"), "Mark reviewed still works");
    assert.ok(view.query("[data-diff-comment-gutter]"), "comments still work");
    assert.equal(getDiffScope("t1"), "branch");
    assert.equal(getDiffScope("other"), "uncommitted");
  });

  it("explains an empty This turn before any checkpoint", async () => {
    setDiffScope("t1", "turn");
    const { m, calls } = mountPanel(() => ({ files: [], patch: "", truncated: false, scopeLabel: "" }));
    const view = await m;
    await view.flush();
    assert.deepEqual(calls[0], { scope: "turn" });
    assert.match(view.text(), /No turn checkpoint yet/);
  });

  it("Ignore whitespace refetches with -w", async () => {
    const { m, calls } = mountPanel();
    const view = await m;
    await view.flush();
    await view.click(view.query('[data-diff-toggle="whitespace"]'));
    await view.flush();
    assert.deepEqual(calls.at(-1), { ignoreWhitespace: true });
    assert.equal(pressed(view, '[data-diff-toggle="whitespace"]'), "true");
  });
});

describe("Git pane per-file patches (#1493)", () => {
  it("fetches a lazy file's patch when it is opened", async () => {
    const { m, calls } = mountPanel((opts) =>
      opts?.path ? { files: [], patch: patchFor("src/lazy.ts", "const lazy = 9;"), truncated: false } : DIFF,
    );
    const view = await m;
    await view.flush();
    const row = view.queryAll("[data-file-row]").find((r) => /lazy\.ts/.test(r.textContent || ""));
    await view.click(row!);
    await view.flush();
    assert.deepEqual(calls.at(-1), { path: "src/lazy.ts" });
    assert.match(view.query("[data-review-hunk]")?.textContent || "", /const lazy = 9;/);
  });

  it("holds a large file behind Show anyway", async () => {
    const { m, calls } = mountPanel((opts) =>
      opts?.path ? { files: [], patch: patchFor("gen/big.json", '"k": 1'), truncated: true } : DIFF,
    );
    const view = await m;
    await view.flush();
    const row = view.queryAll("[data-file-row]").find((r) => /big\.json/.test(r.textContent || ""));
    await view.click(row!);
    assert.ok(view.query('[data-diff-large="gen/big.json"]'));
    assert.match(view.text(), /4,010 changed lines/);
    assert.equal(calls.length, 1, "nothing fetched until asked");
    await view.click(view.byText("Show anyway"));
    await view.flush();
    assert.deepEqual(calls.at(-1), { path: "gen/big.json", full: true });
    assert.match(view.query("[data-review-hunk]")?.textContent || "", /"k": 1/);
    assert.match(view.text(), /Diff cut at 1 MB/);
  });
});

describe("Git pane layout toggles (#1493)", () => {
  it("split pairs old and new lines and keeps the comment gutter", async () => {
    const { m } = mountPanel();
    const view = await m;
    await view.flush();
    await view.click(view.query('[data-diff-toggle="split"]'));
    const rows = view.queryAll("[data-diff-split-row]");
    // keep (ctx both sides), then -old paired with +fresh.
    assert.equal(rows.length, 2);
    const [left, right] = [...rows[1]!.children];
    assert.equal(left!.getAttribute("data-kind"), "del");
    assert.equal(right!.getAttribute("data-kind"), "add");
    assert.match(right!.textContent || "", /^2const fresh = 3;$/, "no +/- prefix in split");
    await view.click(right!.querySelector("[data-diff-comment-gutter]"));
    assert.ok(view.query("[data-diff-comment-box]"), "comment box opens from a split cell");
  });

  it("Wrap marks the patch for soft wrapping", async () => {
    const { m } = mountPanel();
    const view = await m;
    await view.flush();
    assert.equal(view.query("[data-wrap]"), null);
    await view.click(view.query('[data-diff-toggle="wrap"]'));
    assert.ok(view.query("[data-wrap]"));
  });
});

describe("syntax highlighting (#1493)", () => {
  it("maps paths and fences to languages", () => {
    assert.equal(languageForPath("src/a.tsx"), "typescript");
    assert.equal(languageForPath("electron/main.js"), "javascript");
    assert.equal(languageForPath("Dockerfile"), "bash");
    assert.equal(languageForPath("LICENSE"), null);
    assert.equal(languageForFence("shell"), "bash");
    assert.equal(languageForFence("py"), "python");
    assert.equal(languageForFence("nope"), null);
  });

  it("colours diff lines once the lazy engine loads, text unchanged", async () => {
    const { m } = mountPanel();
    const view = await m;
    await view.flush();
    await until(view, () => view.query(".hljs-keyword") != null, "keyword span rendered");
    const added = view.queryAll('[data-review-hunk] [data-kind="add"]')[0]!;
    assert.match(added.textContent || "", /^2\+const fresh = 3;$/);
    assert.ok(added.querySelector("[data-highlighted] .hljs-number"));
  });
});

describe("multi-line highlighting (#1512)", () => {
  it("closes spans at each line break and reopens them on the next line", () => {
    const html = '<span class="a">x\n<span class="b">y\nz</span></span>w\n<span class="c">open';
    assert.deepEqual(splitHighlightedLines(html), {
      lines: [
        '<span class="a">x</span>',
        '<span class="a"><span class="b">y</span></span>',
        '<span class="a"><span class="b">z</span></span>w',
        '<span class="c">open',
      ],
      open: 0,
    });
    // The engine closes scopes at the end of input; the last line still
    // reports what it inherited.
    assert.equal(splitHighlightedLines('<span class="c">a\n</span>').open, 1);
  });

  it("groups each hunk's old side and new side, skipping no-newline markers", () => {
    const rows = (...kinds: Array<[string, string]>) =>
      kinds.map(([kind, text]) => ({ kind: kind as "ctx", text }));
    assert.deepEqual(
      diffHighlightGroups([
        { rows: rows(["ctx", " a"], ["del", "-b"], ["add", "+c"]), offset: 0 },
        { rows: rows(["add", "+d"], ["ctx", "\\ No newline at end of file"]), offset: 3 },
      ]),
      [[0, 1], [0, 2], [], [3]],
    );
  });

  function Lines({ codes, groups }: { codes: string[]; groups?: number[][] }) {
    const html = useHighlightedLines("typescript", codes, groups);
    return (
      <>
        {codes.map((c, i) => (
          <div key={i} data-line={i} dangerouslySetInnerHTML={{ __html: html[i] ?? c }} />
        ))}
      </>
    );
  }
  const spanIn = (view: Mounted, line: number, cls: string) =>
    view.query(`[data-line="${line}"] .${cls}`) != null;

  it("colours every line of a block comment and a template string", async () => {
    const codes = ["/* starts here", "   still comment", "*/", "const s = `one", "two ${x}", "three`;"];
    const view = await mount(<Lines codes={codes} />);
    await until(view, () => spanIn(view, 5, "hljs-string"), "template string reaches its last line");
    for (const i of [0, 1, 2]) assert.ok(spanIn(view, i, "hljs-comment"), `comment on line ${i}`);
    for (const i of [3, 4, 5]) assert.ok(spanIn(view, i, "hljs-string"), `string on line ${i}`);
    assert.ok(spanIn(view, 4, "hljs-subst"), "the substitution nests inside the string");
    assert.equal(view.query('[data-line="1"]')!.textContent, "   still comment");
  });

  it("highlights each diff side apart, so a removed comment opener does not leak into added lines", async () => {
    const codes = ["/* old comment", "const added = 1;", "still old */"];
    const groups = [[0, 2], [1]];
    const view = await mount(<Lines codes={codes} groups={groups} />);
    await until(view, () => spanIn(view, 2, "hljs-comment"), "old side colours through");
    assert.ok(spanIn(view, 1, "hljs-keyword"), "the added line is code, not comment");
    assert.equal(spanIn(view, 1, "hljs-comment"), false);
  });

  it("slices a big file in blocks and still colours a comment across a block edge", async () => {
    const codes = Array.from({ length: 450 }, (_, i) => `const v${i} = ${i};`);
    codes[195] = "/* opens near the end of the first block";
    for (let i = 196; i < 260; i++) codes[i] = `   comment line ${i}`;
    codes[260] = "*/";
    const view = await mount(<Lines codes={codes} />);
    await until(view, () => spanIn(view, 449, "hljs-number"), "the last block lands");
    for (const i of [195, 199, 200, 230, 260]) {
      assert.ok(spanIn(view, i, "hljs-comment"), `comment on line ${i}`);
    }
    assert.ok(spanIn(view, 261, "hljs-keyword"), "code resumes after the comment");
  });
});
