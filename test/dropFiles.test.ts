/**
 * filesFromDataTransfer: Finder folders live on items, not FileList.
 *
 * Run: node --import=./test/support/render.mjs --test test/dropFiles.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DROP_OVERLAY_MESSAGE,
  DROP_REJECT_MESSAGE,
  filesFromDataTransfer,
  foldersFromDataTransfer,
  isFileDrag,
} from "../src/dropFiles";

if (typeof FileReader === "undefined") {
  (globalThis as unknown as { FileReader: typeof FileReader }).FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      this.result = `data:${blob.type || "application/octet-stream"};base64,`;
      this.onload?.();
    }
  } as unknown as typeof FileReader;
}

function fileEntry(file: File) {
  return {
    isDirectory: false as const,
    isFile: true as const,
    name: file.name,
    file: (success: (f: File) => void) => success(file),
  };
}

function dirEntry(
  name: string,
  children: Array<ReturnType<typeof fileEntry> | ReturnType<typeof dirEntry>>,
) {
  return {
    isDirectory: true as const,
    isFile: false as const,
    name,
    createReader: () => {
      let sent = false;
      return {
        readEntries: (success: (entries: unknown[]) => void) => {
          if (sent) {
            success([]);
            return;
          }
          sent = true;
          success(children);
        },
      };
    },
  };
}

function item(
  file: File | null,
  over: {
    kind?: string;
    directory?: boolean;
    entry?: ReturnType<typeof fileEntry> | ReturnType<typeof dirEntry> | null;
  } = {},
) {
  return {
    kind: over.kind ?? "file",
    type: file?.type ?? "",
    getAsFile: () => file,
    webkitGetAsEntry: () => {
      if (over.entry !== undefined) return over.entry;
      if (!file) return null;
      if (over.directory) return dirEntry(file.name, []);
      return fileEntry(file);
    },
  };
}

function dt(
  over: {
    files?: File[];
    items?: ReturnType<typeof item>[];
    types?: string[];
  } = {},
): DataTransfer {
  return {
    files: over.files ?? [],
    items: over.items ?? [],
    types: over.types ?? ["Files"],
  } as unknown as DataTransfer;
}

describe("filesFromDataTransfer", () => {
  it("prefers items so a directory missing from FileList still arrives", () => {
    const folder = new File([], "fixtures", { type: "" });
    const out = filesFromDataTransfer(
      dt({
        files: [],
        items: [item(folder, { directory: true })],
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "fixtures");
  });

  it("falls back to FileList when items is empty", () => {
    const image = new File([Uint8Array.from([1])], "shot.png", {
      type: "image/png",
    });
    const out = filesFromDataTransfer(dt({ files: [image], items: [] }));
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "shot.png");
  });

  it("skips non-file items and empty getAsFile", () => {
    const image = new File([Uint8Array.from([1])], "shot.png", {
      type: "image/png",
    });
    const out = filesFromDataTransfer(
      dt({
        items: [
          item(null, { kind: "string" }),
          item(null),
          item(image),
        ],
      }),
    );
    assert.deepEqual(
      out.map((f) => f.name),
      ["shot.png"],
    );
  });

  it("collects a mixed image + folder drop from items", () => {
    const image = new File([Uint8Array.from([1])], "shot.png", {
      type: "image/png",
    });
    const folder = new File([], "fixtures", { type: "" });
    const out = filesFromDataTransfer(
      dt({
        files: [image],
        items: [item(image), item(folder, { directory: true })],
      }),
    );
    assert.deepEqual(
      out.map((f) => f.name),
      ["shot.png", "fixtures"],
    );
  });
});

describe("foldersFromDataTransfer", () => {
  it("walks webkitGetAsEntry directories via createReader, not FileList", async () => {
    const nested = new File(["# a"], "a.md", { type: "text/markdown" });
    const inner = new File(["b"], "b.txt", { type: "text/plain" });
    const folder = new File([], "fixtures", { type: "" });
    const out = await foldersFromDataTransfer(
      dt({
        files: [],
        items: [
          item(folder, {
            directory: true,
            entry: dirEntry("fixtures", [
              fileEntry(nested),
              dirEntry("nested", [fileEntry(inner)]),
            ]),
          }),
        ],
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "fixtures");
    assert.deepEqual(
      out[0].files.map((f) => f.relativePath),
      ["a.md", "nested/b.txt"],
    );
    assert.ok(out[0].files.every((f) => f.dataUrl.startsWith("data:")));
  });

  it("does not flatten a dropped directory into loose files", async () => {
    const nested = new File(["# a"], "a.md", { type: "text/markdown" });
    const folder = new File([], "specs", { type: "" });
    const transfer = dt({
      files: [nested],
      items: [
        item(folder, {
          directory: true,
          entry: dirEntry("specs", [fileEntry(nested)]),
        }),
      ],
    });
    const files = filesFromDataTransfer(transfer);
    const folders = await foldersFromDataTransfer(transfer);
    assert.deepEqual(
      files.map((f) => f.name),
      ["specs"],
      "FileList still exposes the directory File for native droppedFilePath",
    );
    assert.equal(folders.length, 1);
    assert.equal(folders[0].name, "specs");
    assert.equal(folders[0].files.length, 1);
    assert.equal(folders[0].files[0].relativePath, "a.md");
  });

  it("keeps a sibling file next to a walked folder", async () => {
    const notes = new File(["# notes"], "notes.md", { type: "text/markdown" });
    const nested = new File(["# a"], "a.md", { type: "text/markdown" });
    const folder = new File([], "specs", { type: "" });
    const out = await foldersFromDataTransfer(
      dt({
        items: [
          item(notes),
          item(folder, {
            directory: true,
            entry: dirEntry("specs", [fileEntry(nested)]),
          }),
        ],
      }),
    );
    assert.deepEqual(
      out.map((f) => f.name),
      ["specs"],
    );
  });
});

describe("isFileDrag", () => {
  it("accepts the Files type used by Finder / Explorer", () => {
    assert.equal(isFileDrag(dt({ types: ["Files"] })), true);
    assert.equal(isFileDrag(dt({ types: ["text/plain"] })), false);
    assert.equal(isFileDrag(null), false);
  });
});

describe("DROP_REJECT_MESSAGE", () => {
  it("is a single line the banner can show", () => {
    assert.equal(DROP_REJECT_MESSAGE.includes("\n"), false);
    assert.match(DROP_REJECT_MESSAGE, /files or folders/i);
  });
});

describe("DROP_OVERLAY_MESSAGE", () => {
  it("names files, not only images", () => {
    assert.match(DROP_OVERLAY_MESSAGE, /files or folders/i);
    assert.equal(DROP_OVERLAY_MESSAGE.includes("\n"), false);
  });
});
