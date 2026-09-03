/**
 * speech-spike.yml must stay workflow_dispatch-only. The leftover 3b4108
 * copy had on: push + pull_request and would download a ~700 MB GGUF on
 * every main commit (#860 / #845).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ymlPath = path.join(__dirname, "..", "..", ".github", "workflows", "speech-spike.yml");

describe("speech-spike.yml triggers", () => {
  const src = fs.readFileSync(ymlPath, "utf8");
  const on = src.match(/^on:\n([\s\S]*?)\n(?:permissions:|jobs:)/m);

  it("declares an on: block before permissions/jobs", () => {
    assert.ok(on, "missing on: block");
  });

  it("is workflow_dispatch only", () => {
    assert.ok(on, "missing on: block");
    const body = on[1];
    assert.match(body, /^\s*workflow_dispatch:\s*$/m);
    assert.doesNotMatch(body, /^\s*push:/m);
    assert.doesNotMatch(body, /^\s*pull_request:/m);
    assert.equal(body.replace(/^\s*workflow_dispatch:\s*$/m, "").trim(), "");
  });
});
