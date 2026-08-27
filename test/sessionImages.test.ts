/**
 * Grok image_gen / image_edit results name the file as images/N.jpg in
 * markdown. The abs path lives on the tool output JSON.
 *
 * Run: node --experimental-strip-types --test test/sessionImages.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionImagePathsFromMessages } from "../src/sessionImages.ts";

describe("sessionImagePathsFromMessages", () => {
  it("maps images/N.jpg onto the Grok session file from ImageGen JSON", () => {
    const abs =
      "/Users/willem/.grok/sessions/ironman/abc/images/15.jpg";
    const map = sessionImagePathsFromMessages([
      {
        tool: {
          output: JSON.stringify({
            type: "ImageGen",
            path: abs,
            filename: "15.jpg",
            session_folder: "images",
          }),
        },
      },
    ]);
    assert.equal(map["images/15.jpg"], abs);
    assert.equal(map["15.jpg"], abs);
  });

  it("accepts ImageEdit the same way", () => {
    const abs = "/tmp/grok/images/2.jpg";
    const map = sessionImagePathsFromMessages([
      {
        tool: {
          output: JSON.stringify({
            type: "ImageEdit",
            path: abs,
            filename: "2.jpg",
            session_folder: "images",
          }),
        },
      },
    ]);
    assert.equal(map["images/2.jpg"], abs);
  });

  it("skips non-image tool output and malformed JSON", () => {
    assert.deepEqual(
      sessionImagePathsFromMessages([
        { tool: { output: "plain text" } },
        { tool: { output: "{not json" } },
        { tool: { output: null } },
        {},
      ]),
      {},
    );
  });

  it("skips video results", () => {
    assert.deepEqual(
      sessionImagePathsFromMessages([
        {
          tool: {
            output: JSON.stringify({
              type: "ImageToVideo",
              path: "/tmp/v.mp4",
              filename: "1.mp4",
              session_folder: "videos",
            }),
          },
        },
      ]),
      {},
    );
  });
});
