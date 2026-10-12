import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { viewedStatus } from "../src/prViewed.ts";

describe("viewedStatus", () => {
  it("is unseen without a mark", () => {
    assert.equal(viewedStatus(undefined, { headSha: "aaa" }), "unseen");
  });

  it("stays viewed on the same blob after a later head", () => {
    assert.equal(
      viewedStatus(
        { blobSha: "blob-1", headSha: "aaa" },
        { blobSha: "blob-1", headSha: "bbb" },
      ),
      "viewed",
    );
  });

  it("flips to changed when the file blob moved", () => {
    assert.equal(
      viewedStatus(
        { blobSha: "blob-1", headSha: "aaa" },
        { blobSha: "blob-2", headSha: "bbb" },
      ),
      "changed",
    );
  });

  it("uses head SHA when blob SHAs are missing", () => {
    assert.equal(
      viewedStatus({ headSha: "aaa" }, { headSha: "aaa" }),
      "viewed",
    );
    assert.equal(
      viewedStatus({ headSha: "aaa" }, { headSha: "bbb" }),
      "changed",
    );
  });
});
