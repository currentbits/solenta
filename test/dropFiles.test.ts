/**
 * filesFromDataTransfer: Finder folders live on items, not FileList.
 *
 * Run: node --import=./test/support/render.mjs --test test/dropFiles.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DROP_REJECT_MESSAGE,
  filesFromDataTransfer,
  isFileDrag,
} from "../src/dropFiles";

function item(
  file: File | null,
  over: { kind?: string; directory?: boolean } = {},
) {
  return {
    kind: over.kind ?? "file",
    type: file?.type ?? "",
    getAsFile: () => file,
    webkitGetAsEntry: () =>
      file
        ? {
            isDirectory: Boolean(over.directory),
            isFile: !over.directory,
            name: file.name,
          }
        : null,
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
    assert.match(DROP_REJECT_MESSAGE, /images or folders/i);
  });
});
