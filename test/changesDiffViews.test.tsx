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
  getChangesPanelSnap,
  resetChangesPanelSnaps,
  setChangesPanelSnap,
} from "../src/components/thread/changesPanelMemory";
import {
  languageForFence,
  languageForPath,
  splitHighlightedLines,
  useHighlightedLines,
} from "../src/syntaxHighlight";
import { diffHighlightGroups } from "../src/diffView";
import {
  getDiffScope,
  setDiffFilesCollapsed,
  setDiffHideTests,
  setDiffIgnoreWhitespace,
  setDiffScope,
  setDiffSplit,
  setDiffTreeView,
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

function mountPanel(
  respond: (opts?: DiffOptions) => DiffResult = () => DIFF,
  focus: { path: string } | null = null,
) {
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
      focus={focus}
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
  setDiffHideTests(false);
  setDiffTreeView(false);
  setDiffFilesCollapsed(false);
  resetChangesPanelSnaps();
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

const TEST_DIFF: DiffResult = {
  files: [
    { path: "src/a.ts", status: "M", additions: 1, deletions: 1 },
    { path: "src/a.test.ts", status: "M", additions: 1, deletions: 1 },
    { path: "src/__mocks__/fs.ts", status: "M", additions: 1, deletions: 1 },
  ],
  patch: ["src/a.ts", "src/a.test.ts", "src/__mocks__/fs.ts"]
    .map((p) => patchFor(p, "const fresh = 3;"))
    .join("\n"),
  truncated: false,
};

describe("Git pane Hide tests (#1745)", () => {
  const rows = (view: Mounted) =>
    view.queryAll("[data-file-row]").map((el) => el.getAttribute("data-file-path"));

  it("hides test files from the list, remembers it, and the hidden count restores them", async () => {
    const view = await mountPanel(() => TEST_DIFF).m;
    await view.flush();
    assert.deepEqual(rows(view).sort(), ["src/__mocks__/fs.ts", "src/a.test.ts", "src/a.ts"]);
    assert.equal(view.query("[data-tests-hidden]"), null);

    await view.click(view.query("[data-hide-tests]"));
    await view.flush();
    assert.deepEqual(rows(view), ["src/a.ts"]);
    assert.equal(pressed(view, "[data-hide-tests]"), "true");
    assert.equal(view.query("[data-tests-hidden]")?.textContent, "2 test files hidden");
    assert.equal(window.localStorage.getItem("coder.diffHideTests"), "on");
    assert.ok(
      view.queryAll("[data-file-row][data-selected]").every(
        (el) => el.getAttribute("data-file-path") === "src/a.ts",
      ),
    );
    assert.equal(
      view.query("[data-stage-all]")?.parentElement?.textContent?.includes("3/3 staged"),
      true,
      "staging still counts the full list",
    );

    await view.click(view.query("[data-tests-hidden]"));
    await view.flush();
    assert.equal(rows(view).length, 3);
    assert.equal(window.localStorage.getItem("coder.diffHideTests"), "off");
  });

  it("keeps a linked test file visible while hiding", async () => {
    setDiffHideTests(true);
    const view = await mountPanel(() => TEST_DIFF, { path: "src/a.test.ts" }).m;
    await view.flush();
    assert.deepEqual(rows(view).sort(), ["src/a.test.ts", "src/a.ts"]);
    assert.equal(
      view.query("[data-file-row][data-selected]")?.getAttribute("data-file-path"),
      "src/a.test.ts",
    );
    assert.equal(view.query("[data-tests-hidden]")?.textContent, "1 test file hidden");
  });

  it("shows no toggle when the diff has no test files", async () => {
    const view = await mountPanel().m;
    await view.flush();
    assert.equal(view.query("[data-hide-tests]"), null);
  });
});

describe("Git pane remembers its spot per thread (#1779)", () => {
  function panel(opts: {
    threadId: string;
    diff: DiffResult;
    focus?: { path: string } | null;
  }) {
    return (
      <ChangesPanel
        open
        threadId={opts.threadId}
        threadTitle="diffs"
        threadBranch="coder/diffs"
        planText=""
        openNonce={1}
        focus={opts.focus ?? null}
        onFetchDiff={async () => opts.diff}
        onCommit={async (message) => ({ subject: message })}
        onStagedPathsChange={() => {}}
        onRevert={async (path) => ({ path })}
        onSuggest={async () => ({ message: "x" })}
        onComment={() => {}}
      />
    );
  }

  const DIFF_A: DiffResult = {
    files: [
      { path: "dirA/one.ts", status: "M", additions: 1, deletions: 1 },
      { path: "dirB/two.ts", status: "M", additions: 1, deletions: 1 },
    ],
    patch: [patchFor("dirA/one.ts", "aa"), patchFor("dirB/two.ts", "bb")].join("\n"),
    truncated: false,
  };
  const DIFF_B: DiffResult = {
    files: [{ path: "dirC/three.ts", status: "M", additions: 1, deletions: 1 }],
    patch: patchFor("dirC/three.ts", "cc"),
    truncated: false,
  };

  async function selectFile(view: Mounted, path: string) {
    const row = view
      .queryAll("[data-file-row]")
      .find((r) => r.getAttribute("data-file-path") === path);
    assert.ok(row, `file row for ${path}`);
    await view.click(row!);
  }

  const selectedFile = (view: Mounted) =>
    view.query("[data-file-row][data-selected]")?.getAttribute("data-file-path") ?? null;

  it("restores the selected file, scroll position and collapsed folders after a visit to another thread", async () => {
    setDiffTreeView(true);
    const view = await mount(panel({ threadId: "tA", diff: DIFF_A }));
    await view.flush();
    assert.equal(selectedFile(view), "dirA/one.ts", "defaults to the first file");

    await selectFile(view, "dirB/two.ts");
    assert.equal(selectedFile(view), "dirB/two.ts");

    await view.click(view.query('[data-dir-row="dirA"]'));
    assert.equal(
      view.query('[data-dir-row="dirA"]')?.getAttribute("aria-expanded"),
      "false",
      "dirA collapsed",
    );

    const fileList = view.query(".changesFiles") as HTMLElement;
    const diffBody = view.query(".changesDiff") as HTMLElement;
    assert.ok(fileList && diffBody, "scroll containers render");
    fileList.scrollTop = 40;
    diffBody.scrollTop = 80;

    // Switch away: B must show none of A's selection, collapse or scroll.
    await view.rerender(panel({ threadId: "tB", diff: DIFF_B }));
    await view.flush();
    assert.equal(selectedFile(view), "dirC/three.ts", "B never shows A's selection");
    assert.equal(
      view.query('[data-dir-row="dirA"]'),
      null,
      "B has no dirA to begin with, let alone collapsed",
    );
    assert.equal((view.query(".changesFiles") as HTMLElement).scrollTop, 0);
    assert.equal((view.query(".changesDiff") as HTMLElement).scrollTop, 0);

    // Back to A: selection, collapse and scroll all come back.
    await view.rerender(panel({ threadId: "tA", diff: DIFF_A }));
    await view.flush();
    assert.equal(selectedFile(view), "dirB/two.ts", "A's selected file is restored");
    assert.equal(
      view.query('[data-dir-row="dirA"]')?.getAttribute("aria-expanded"),
      "false",
      "A's collapsed folder is restored",
    );
    await until(
      view,
      () => (view.query(".changesFiles") as HTMLElement)?.scrollTop === 40,
      "file-list scroll restored",
    );
    await until(
      view,
      () => (view.query(".changesDiff") as HTMLElement)?.scrollTop === 80,
      "diff-body scroll restored",
    );
  });

  it("collapse all / expand all persists through a thread switch (#1796)", async () => {
    setDiffTreeView(true);
    const view = await mount(panel({ threadId: "tA", diff: DIFF_A }));
    await view.flush();
    await view.click(view.query("[data-tree-collapse-all]")!);
    await view.flush();
    assert.equal(
      view.query('[data-dir-row="dirA"]')?.getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      view.query('[data-dir-row="dirB"]')?.getAttribute("aria-expanded"),
      "false",
    );

    await view.rerender(panel({ threadId: "tB", diff: DIFF_B }));
    await view.flush();
    assert.equal(
      view.query("[data-tree-collapse-all]")?.textContent,
      "Collapse all",
      "tB starts with nothing collapsed",
    );

    await view.rerender(panel({ threadId: "tA", diff: DIFF_A }));
    await view.flush();
    assert.equal(
      view.query('[data-dir-row="dirA"]')?.getAttribute("aria-expanded"),
      "false",
      "tA's collapse-all is restored",
    );
    assert.equal(view.query("[data-tree-collapse-all]")?.textContent, "Expand all");
  });

  it("falls back to the default selection when the saved path no longer exists", async () => {
    const view = await mount(panel({ threadId: "tA", diff: DIFF_A }));
    await view.flush();
    await selectFile(view, "dirB/two.ts");
    assert.equal(selectedFile(view), "dirB/two.ts");

    await view.rerender(panel({ threadId: "tB", diff: DIFF_B }));
    await view.flush();

    // dirB/two.ts is gone by the time thread A comes back into view.
    const diffA2: DiffResult = {
      files: [{ path: "dirA/one.ts", status: "M", additions: 1, deletions: 1 }],
      patch: patchFor("dirA/one.ts", "aa2"),
      truncated: false,
    };
    await view.rerender(panel({ threadId: "tA", diff: diffA2 }));
    await view.flush();
    assert.equal(selectedFile(view), "dirA/one.ts", "stale path falls back to the default");
  });
});

describe("Changes panel per-thread memory cap (#1779)", () => {
  it("evicts the oldest thread once the cap is reached", () => {
    const snap = (n: number) => ({
      selectedPath: `file${n}.ts`,
      fileListScrollTop: n,
      diffScrollTop: n,
      collapsedDirs: [],
    });
    for (let i = 0; i < 51; i++) {
      setChangesPanelSnap(`cap-${i}`, snap(i));
    }
    assert.equal(getChangesPanelSnap("cap-0"), null, "oldest thread evicted once the 51st arrives");
    assert.equal(getChangesPanelSnap("cap-1")?.selectedPath, "file1.ts", "next-oldest survives");
    assert.equal(getChangesPanelSnap("cap-50")?.selectedPath, "file50.ts", "newest survives");
  });
});

describe("Git pane per-file collapse (#1787)", () => {
  const COLLAPSE_DIFF: DiffResult = {
    files: [
      { path: "src/a.ts", status: "M", additions: 1, deletions: 1 },
      { path: "notes.txt", status: "A", additions: 1, deletions: 0 },
    ],
    patch: [
      patchFor("src/a.ts", "const fresh = 3;"),
      patchFor("notes.txt", "hello"),
    ].join("\n"),
    truncated: false,
  };

  it("renders no collapse header and a fully expanded body with the pref off", async () => {
    const { m } = mountPanel(() => COLLAPSE_DIFF);
    const view = await m;
    await view.flush();
    assert.equal(view.query("[data-diff-file-header]"), null);
    assert.match(view.query("[data-review-hunk]")?.textContent || "", /const fresh = 3;/);
  });

  it("starts collapsed with the pref on; the header click expands it", async () => {
    setDiffFilesCollapsed(true);
    const { m } = mountPanel(() => COLLAPSE_DIFF);
    const view = await m;
    await view.flush();
    const header = view.query("[data-diff-file-header='src/a.ts']");
    assert.ok(header, "collapse header renders for the default-selected file");
    assert.equal(header!.getAttribute("aria-expanded"), "false");
    assert.equal(view.query("[data-review-hunk]"), null, "body starts hidden");

    await view.click(header as HTMLElement);
    await view.flush();
    assert.equal(
      view.query("[data-diff-file-header='src/a.ts']")?.getAttribute("aria-expanded"),
      "true",
    );
    assert.match(view.query("[data-review-hunk]")?.textContent || "", /const fresh = 3;/);
  });

  it("selecting a file from the list expands it", async () => {
    setDiffFilesCollapsed(true);
    const { m } = mountPanel(() => COLLAPSE_DIFF);
    const view = await m;
    await view.flush();
    assert.equal(
      view.query("[data-diff-file-header='src/a.ts']")?.getAttribute("aria-expanded"),
      "false",
    );

    await view.click(view.query("[data-file-path='notes.txt']"));
    await view.flush();
    assert.equal(
      view.query("[data-diff-file-header='notes.txt']")?.getAttribute("aria-expanded"),
      "true",
      "selecting a file from the list expands it",
    );
    assert.match(view.query("[data-review-hunk]")?.textContent || "", /hello/);
  });
});
