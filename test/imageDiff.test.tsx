/**
 * Git pane image before/after (#1192): labels, sizes, missing sides, zoom,
 * stale reads dropped on thread switch, staging untouched.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/imageDiff.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import { ChangesPanel } from "../src/components/thread/ChangesPanel";
import { ImageDiff, isImagePath } from "../src/components/thread/ImageDiff";
import type {
  DiffResult,
  FileChange,
  ImageDiffInput,
  ImageDiffResult,
} from "../src/shared/ipc";

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

const RESULT: ImageDiffResult = {
  before: { label: "HEAD abc1234", exists: true, bytes: 2048, width: 4, height: 3, dataUrl: PIXEL },
  after: { label: "Working tree", exists: true, bytes: 3072, width: 8, height: 6, dataUrl: PIXEL },
};

const DIFF: DiffResult = {
  files: [
    { path: "assets/logo.png", oldPath: "assets/icon.png", status: "R", additions: 0, deletions: 0 },
    { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
  ],
  patch: [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,2 @@",
    " keep",
    "+new",
  ].join("\n"),
  truncated: false,
};

function panel(fetch: (input: ImageDiffInput) => Promise<ImageDiffResult>, commits: string[][]) {
  return (
    <ChangesPanel
      open
      threadId="t1"
      threadTitle="images"
      threadBranch="coder/images"
      planText=""
      openNonce={1}
      onFetchDiff={async () => DIFF}
      onFetchImageDiff={fetch}
      onCommit={async (message, paths) => {
        commits.push(paths ?? []);
        return { subject: message };
      }}
      onRevert={async (path) => ({ path })}
      onSuggest={async () => ({ message: "m" })}
    />
  );
}

describe("isImagePath", () => {
  it("takes rasters and leaves SVG to the text diff", () => {
    assert.ok(isImagePath("a/b.PNG"));
    assert.ok(isImagePath("x.jpeg"));
    assert.ok(isImagePath("x.webp"));
    assert.ok(!isImagePath("x.svg"));
    assert.ok(!isImagePath("png.ts"));
  });
});

describe("ChangesPanel image review", () => {
  it("shows labelled sides for the renamed image and keeps staging", async () => {
    const calls: ImageDiffInput[] = [];
    const commits: string[][] = [];
    const view = await mount(
      panel(async (input) => {
        calls.push(input);
        return RESULT;
      }, commits),
    );
    await view.flush();
    assert.deepEqual(calls, [
      { scope: "uncommitted", path: "assets/logo.png", oldPath: "assets/icon.png" },
    ]);
    const text = view.text();
    assert.match(text, /assets\/icon\.png → assets\/logo\.png/);
    assert.match(text, /BeforeHEAD abc12344 × 3 · 2\.0 KB/);
    assert.match(text, /AfterWorking tree8 × 6 · 3\.0 KB/);
    assert.equal(view.queryAll("[data-image-side] img").length, 2);
    assert.equal(view.query("[data-image-zoom='Fit']")?.getAttribute("aria-pressed"), "true");

    await view.click(view.query("[data-image-zoom='200%']"));
    const img = view.query("[data-image-side='after'] img") as HTMLImageElement;
    assert.equal(img.style.width, "16px");

    // Staging still stages the selected file (path list, not image bytes).
    await view.click(view.query('[data-stage-file="src/a.ts"]'));
    await view.type(view.query('textarea[aria-label="Commit message"]'), "msg");
    await view.click(view.query("[data-commit-changes]"));
    assert.deepEqual(commits, [["assets/logo.png"]]);
  });

  it("says which side is missing and why there is no preview", async () => {
    const view = await mount(
      <ImageDiff
        threadId="t1"
        scope="branch"
        file={{ path: "new.png", status: "A", additions: 0, deletions: 0 }}
        reloadKey={1}
        onFetch={async () => ({
          before: { label: "Merge base abc1234", exists: false },
          after: { label: "Working tree", exists: true, bytes: 9e6, note: "Too large to preview" },
        })}
      />,
    );
    await view.flush();
    assert.match(view.text(), /Not in Merge base abc1234: added/);
    assert.match(view.text(), /Too large to preview/);
    assert.equal(view.queryAll("img").length, 0);
  });

  it("drops a slow read from the previous thread", async () => {
    const file: FileChange = { path: "a.png", status: "M", additions: 0, deletions: 0 };
    let releaseOld: (r: ImageDiffResult) => void = () => {};
    const fetch = (input: ImageDiffInput & { t?: string }) =>
      input.t === "old"
        ? new Promise<ImageDiffResult>((resolve) => {
            releaseOld = resolve;
          })
        : Promise.resolve(RESULT);
    const el = (threadId: string) => (
      <ImageDiff
        threadId={threadId}
        scope="uncommitted"
        file={file}
        reloadKey={1}
        onFetch={(input) => fetch({ ...input, t: threadId === "t-old" ? "old" : "new" })}
      />
    );
    const view = await mount(el("t-old"));
    await view.rerender(el("t-new"));
    await view.flush();
    await inAct(() => {
      releaseOld({
        before: { label: "STALE", exists: false },
        after: { label: "STALE", exists: false },
      });
    });
    assert.doesNotMatch(view.text(), /STALE/);
    assert.match(view.text(), /HEAD abc1234/);
  });
});
