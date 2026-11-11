/**
 * Files pane (#1506): lazy tree, ignored toggle, fuzzy filter, keyboard
 * navigation, previews and "Add to prompt". The main-process side (path
 * guards, gitignore, size cap) is electron/test/files-pane.test.js.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import {
  FilesPane,
  forgetFilesPaneMemory,
  fuzzyScore,
  type FilesPaneApi,
} from "../src/components/FilesPane";
import { pdfEngine, type PdfDoc } from "../src/components/PdfPreview";
import type { ReviewComment } from "../src/diffView";
import type { FilePreview, FileTreeEntry } from "../src/shared/ipc";

afterEach(() => {
  unmountAll();
  forgetFilesPaneMemory();
});

const TREE: Record<string, FileTreeEntry[]> = {
  "": [
    { name: "src", path: "src", dir: true },
    { name: "README.md", path: "README.md", dir: false },
  ],
  src: [
    { name: "a.ts", path: "src/a.ts", dir: false },
    { name: "b.ts", path: "src/b.ts", dir: false },
  ],
};

const FILES: Record<string, FilePreview> = {
  "src/a.ts": { kind: "text", size: 30, text: "const a = 1;\nconst b = 2;\nconst c = 3;\n" },
  "src/b.ts": { kind: "text", size: 4, text: "b\n" },
  "README.md": { kind: "text", size: 6, text: "# Hello\n" },
  "big.log": { kind: "tooLarge", size: 5 * 1024 * 1024 },
  "x.bin": { kind: "binary", size: 10 },
  "logo.png": { kind: "image", size: 3, dataUrl: "data:image/png;base64,AAA=" },
  "doc.pdf": { kind: "pdf", size: 4, data: btoa("%PDF") },
};

function fakeApi() {
  const calls: Array<[string, unknown]> = [];
  const api: FilesPaneApi = {
    async tree(input) {
      calls.push(["tree", input]);
      if (input.all) {
        return {
          entries: ["README.md", "src/a.ts", "src/b.ts"].map((p) => ({
            name: p.split("/").pop()!,
            path: p,
            dir: false,
          })),
          truncated: false,
        };
      }
      const entries = [...(TREE[input.dir ?? ""] ?? [])];
      if (!input.dir && input.showIgnored) {
        entries.unshift({ name: "dist", path: "dist", dir: true, ignored: true });
      }
      return { entries, truncated: false };
    },
    async read(input) {
      calls.push(["read", input]);
      const hit = FILES[input.path];
      if (!hit) throw new Error("Path does not exist");
      return hit;
    },
    async editors() {
      return [
        { id: "finder", name: "Finder" },
        { id: "vscode", name: "VS Code" },
      ];
    },
    async openIn(input) {
      calls.push(["openIn", input]);
    },
  };
  return { api, calls };
}

async function setup(
  props: { remote?: boolean; onAddToPrompt?: (c: ReviewComment) => void } = {},
) {
  const { api, calls } = fakeApi();
  const m = await mount(<FilesPane threadId="t1" api={api} {...props} />);
  await m.flush();
  return { m, api, calls };
}

const rowNames = (m: Awaited<ReturnType<typeof mount>>) =>
  m.queryAll("[data-files-row]").map((r) => r.getAttribute("data-files-row"));

describe("fuzzyScore", () => {
  it("matches subsequences and ranks word starts in the file name higher", () => {
    assert.equal(fuzzyScore("xyz", "src/a.ts"), null);
    assert.equal(fuzzyScore("", "anything"), 0);
    const pane = fuzzyScore("fp", "src/components/FilesPane.tsx")!;
    const loose = fuzzyScore("fp", "src/fixtures/deep/map.json")!;
    assert.ok(pane > loose, `${pane} > ${loose}`);
  });
});

describe("FilesPane", () => {
  it("lists the root and loads a directory only when it is expanded", async () => {
    const { m, calls } = await setup();
    assert.deepEqual(rowNames(m), ["src", "README.md"]);
    assert.equal(calls.filter(([k]) => k === "tree").length, 1);
    await m.click(m.query("[data-files-row='src']"));
    await m.flush();
    assert.deepEqual(rowNames(m), ["src", "src/a.ts", "src/b.ts", "README.md"]);
    assert.deepEqual(calls.at(-1), ["tree", { threadId: "t1", dir: "src", showIgnored: false }]);
    assert.equal(m.query("[data-files-row='src']")!.getAttribute("aria-expanded"), "true");
  });

  it("shows ignored entries when toggled", async () => {
    const { m } = await setup();
    assert.equal(m.query("[data-files-row='dist']"), null);
    await m.click(m.query("[data-files-show-ignored]"));
    await m.flush();
    const dist = m.query("[data-files-row='dist']");
    assert.ok(dist);
    assert.equal(dist!.hasAttribute("data-ignored"), true);
    assert.equal(m.query("[data-files-show-ignored]")!.getAttribute("aria-pressed"), "true");
  });

  it("navigates with the keyboard and opens a file with Enter", async () => {
    const { m, calls } = await setup();
    const tree = m.query("[data-files-tree]") as HTMLElement;
    await inAct(() => tree.focus());
    await m.pressFocused("ArrowRight");
    await m.flush();
    assert.deepEqual(rowNames(m), ["src", "src/a.ts", "src/b.ts", "README.md"]);
    await m.pressFocused("ArrowDown");
    assert.equal(
      tree.getAttribute("aria-activedescendant"),
      m.query("[data-files-row='src/a.ts']")!.id,
    );
    await m.pressFocused("Enter");
    await m.flush();
    assert.deepEqual(calls.at(-1), ["read", { threadId: "t1", path: "src/a.ts" }]);
    assert.equal(m.queryAll("[data-files-line]").length, 3);
    assert.match(m.text(), /const b = 2;/);
    await m.pressFocused("ArrowLeft");
    assert.equal(tree.getAttribute("aria-activedescendant"), m.query("[data-files-row='src']")!.id);
    await m.pressFocused("ArrowLeft");
    await m.flush();
    assert.deepEqual(rowNames(m), ["src", "README.md"]);
  });

  it("fuzzy-filters the whole tree", async () => {
    const { m, calls } = await setup();
    await m.type(m.query("[data-files-filter]"), "srb");
    await m.flush();
    assert.ok(calls.some(([k, i]) => k === "tree" && (i as { all?: boolean }).all));
    assert.deepEqual(rowNames(m), ["src/b.ts"]);
    const input = m.query("[data-files-filter]") as HTMLElement;
    await inAct(() => input.focus());
    await m.pressFocused("Enter");
    await m.flush();
    assert.deepEqual(calls.at(-1), ["read", { threadId: "t1", path: "src/b.ts" }]);
  });

  it("renders markdown, with a source toggle", async () => {
    const { m } = await setup();
    await m.click(m.query("[data-files-row='README.md']"));
    await m.flush();
    assert.ok(m.query("[data-files-markdown] h1"), "rendered heading");
    await m.click(m.query("[data-files-md-source]"));
    assert.equal(m.query("[data-files-markdown]"), null);
    assert.equal(m.queryAll("[data-files-line]").length, 1);
  });

  it("shows too-large, binary and image states", async () => {
    const { api } = fakeApi();
    for (const [path, selector] of [
      ["big.log", "[data-files-too-large]"],
      ["x.bin", "[data-files-binary]"],
      ["logo.png", "img[data-files-image]"],
    ] as const) {
      TREE[""]!.push({ name: path, path, dir: false });
      const m = await mount(<FilesPane threadId="t1" api={api} />);
      await m.flush();
      await m.click(m.query(`[data-files-row='${path}']`));
      await m.flush();
      assert.ok(m.query(selector), `${path} → ${selector}`);
      m.unmount();
      TREE[""]!.pop();
    }
  });

  it("adds a shift-click line range to the prompt as an excerpt chip", async () => {
    const added: ReviewComment[] = [];
    const { m } = await setup({ onAddToPrompt: (c) => added.push(c) });
    await m.click(m.query("[data-files-row='src']"));
    await m.flush();
    await m.click(m.query("[data-files-row='src/a.ts']"));
    await m.flush();
    await m.click(m.query("[data-files-line='2']"));
    const third = m.query("[data-files-line='3']") as HTMLElement;
    await inAct(() => {
      third.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    assert.equal(m.queryAll("[data-files-line][aria-pressed='true']").length, 2);
    await m.type(m.query("[data-files-selection] input"), "why two?");
    await m.click(m.query("[data-files-add]"));
    assert.equal(added.length, 1);
    const { id, ...rest } = added[0]!;
    assert.ok(id);
    assert.deepEqual(rest, {
      path: "src/a.ts",
      startLine: 2,
      endLine: 3,
      removed: false,
      code: "const b = 2;\nconst c = 3;",
      text: "why two?",
      excerpt: true,
    });
    assert.equal(m.query("[data-files-selection]"), null);
  });

  it("opens the file in the preferred real editor", async () => {
    const { m, calls } = await setup();
    await m.click(m.query("[data-files-row='README.md']"));
    await m.flush();
    await m.click(m.query("[data-files-open-in='vscode']"));
    await m.flush();
    assert.deepEqual(calls.at(-1), [
      "openIn",
      { threadId: "t1", path: "README.md", editor: "vscode" },
    ]);
  });

  it("says not available for remote projects without listing", async () => {
    const { m, calls } = await setup({ remote: true });
    assert.ok(m.query("[data-files-remote]"));
    assert.equal(calls.length, 0);
  });
});

/** Minimal fake DataTransfer: records setData calls, nothing else. */
function fakeDataTransfer() {
  const data: Record<string, string> = {};
  return {
    data,
    dt: {
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      getData: (type: string) => data[type] ?? "",
      effectAllowed: "",
    },
  };
}

async function dragStart(el: Element | null): Promise<Record<string, string>> {
  assert.ok(el, "drag source must exist");
  const { dt, data } = fakeDataTransfer();
  const ev = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  await inAct(() => {
    el!.dispatchEvent(ev);
  });
  return data;
}

describe("FilesPane row drag (#1794)", () => {
  it("a file row's drag data is the repo-relative path on both the mention MIME and text/plain", async () => {
    const { m } = await setup();
    const data = await dragStart(m.query("[data-files-row='README.md']"));
    assert.equal(data["application/x-solenta-path"], "README.md");
    assert.equal(data["text/plain"], "README.md");
  });

  it("a folder row's drag data has a trailing slash", async () => {
    const { m } = await setup();
    const data = await dragStart(m.query("[data-files-row='src']"));
    assert.equal(data["application/x-solenta-path"], "src/");
    assert.equal(data["text/plain"], "src/");
  });
});

describe("FilesPane PDF viewer (#1938)", () => {
  const realOpen = pdfEngine.open;
  afterEach(() => {
    pdfEngine.open = realOpen;
    TREE[""] = TREE[""]!.filter((e) => e.path !== "doc.pdf");
    FILES["doc.pdf"] = { kind: "pdf", size: 4, data: btoa("%PDF") };
  });

  /** Stub engine: records opened bytes, renders and destroys. */
  function stubEngine(numPages = 3) {
    const log = { opened: [] as string[], renders: [] as string[], destroyed: 0 };
    pdfEngine.open = async (data) => {
      log.opened.push(new TextDecoder().decode(data));
      const doc: PdfDoc = {
        numPages,
        pageWidth: 600,
        render(page, zoom) {
          log.renders.push(`${page}@${zoom}`);
          return { promise: Promise.resolve(), cancel() {} };
        },
        destroy() {
          log.destroyed += 1;
        },
      };
      return doc;
    };
    return log;
  }

  async function openPdf(threadId: string, api: FilesPaneApi) {
    TREE[""]!.push({ name: "doc.pdf", path: "doc.pdf", dir: false });
    const m = await mount(<FilesPane threadId={threadId} api={api} />);
    await m.flush();
    await m.click(m.query("[data-files-row='doc.pdf']"));
    await m.flush();
    await m.flush();
    return m;
  }

  const pageText = (m: Awaited<ReturnType<typeof mount>>) =>
    m.query("[data-files-pdf-page]")!.textContent;

  it("renders pages, pages and zooms, and keeps the place across a thread switch", async () => {
    const log = stubEngine(3);
    const { api } = fakeApi();
    let m = await openPdf("t1", api);
    assert.deepEqual(log.opened, ["%PDF"]);
    assert.equal(pageText(m), "1 / 3");
    assert.equal(m.query("[data-files-pdf-prev]")!.hasAttribute("disabled"), true);
    await m.click(m.query("[data-files-pdf-next]"));
    await m.click(m.query("[data-files-pdf-zoom-in]"));
    assert.equal(pageText(m), "2 / 3");
    assert.equal(m.query("[data-files-pdf-zoom]")!.textContent, "125%");
    assert.equal(log.renders.at(-1), "2@1.25");
    const pages = m.query("[data-files-pdf] [role='document']") as HTMLElement;
    await inAct(() => pages.focus());
    await m.pressFocused("End");
    assert.equal(pageText(m), "3 / 3");
    assert.equal(m.query("[data-files-pdf-next]")!.hasAttribute("disabled"), true);

    // Switching threads remounts the pane (ThreadView keys it by thread).
    m.unmount();
    assert.equal(log.destroyed, 1, "the document dies with its preview");
    const other = await mount(<FilesPane threadId="t2" api={api} />);
    await other.flush();
    assert.equal(other.query("[data-files-pdf]"), null);
    other.unmount();

    m = await mount(<FilesPane threadId="t1" api={api} />);
    await m.flush();
    await m.flush();
    assert.equal(pageText(m), "3 / 3");
    assert.equal(m.query("[data-files-pdf-zoom]")!.textContent, "125%");
    assert.equal(log.renders.at(-1), "3@1.25");
  });

  it("clamps a remembered page when the PDF shrank", async () => {
    stubEngine(3);
    const { api } = fakeApi();
    const m = await openPdf("t1", api);
    await m.click(m.query("[data-files-pdf-next]"));
    await m.click(m.query("[data-files-pdf-next]"));
    m.unmount();
    const log = stubEngine(1);
    const again = await mount(<FilesPane threadId="t1" api={api} />);
    await again.flush();
    await again.flush();
    assert.equal(pageText(again), "1 / 1");
    assert.equal(log.renders.at(-1), "1@1");
  });

  it("forgets a deleted PDF instead of reopening it", async () => {
    stubEngine();
    const { api } = fakeApi();
    const m = await openPdf("t1", api);
    m.unmount();
    delete FILES["doc.pdf"];
    const gone = await mount(<FilesPane threadId="t1" api={api} />);
    await gone.flush();
    assert.match(gone.text(), /Path does not exist/);
    gone.unmount();
    const fresh = await mount(<FilesPane threadId="t1" api={api} />);
    await fresh.flush();
    assert.match(fresh.text(), /Pick a file to preview it/);
  });

  it("falls back to a message when pdf.js cannot open the file", async () => {
    pdfEngine.open = async () => {
      throw new Error("Invalid PDF structure.");
    };
    const { api } = fakeApi();
    const m = await openPdf("t1", api);
    assert.match(
      m.query("[data-files-pdf-error]")!.textContent!,
      /Could not open this PDF: Invalid PDF structure\./,
    );
  });

  it("says an oversized PDF stops at 32 MB", async () => {
    FILES["doc.pdf"] = { kind: "tooLarge", size: 40 * 1024 * 1024 };
    const { api } = fakeApi();
    const m = await openPdf("t1", api);
    assert.match(m.query("[data-files-too-large]")!.textContent!, /stop at 32 MB/);
  });
});
