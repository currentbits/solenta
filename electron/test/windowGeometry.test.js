"use strict";

const assert = require("node:assert/strict");
const { it } = require("node:test");
const { windowGeometry } = require("../windowGeometry");

for (const [threadId, width] of [[null, 1440], ["thread", 960]]) {
  it(`${threadId ? "detached" : "main"} windows fit a 640 by 480 tile without changing launch size`, () => {
    const geometry = windowGeometry(threadId);
    assert.equal(geometry.width, width);
    assert.equal(geometry.height, 900);
    assert.ok(geometry.minWidth <= 640);
    assert.ok(geometry.minHeight <= 480);
    assert.ok(geometry.minWidth > 0);
    assert.ok(geometry.minHeight > 0);
    assert.equal("x" in geometry, false);
    assert.equal("y" in geometry, false);
  });
}
