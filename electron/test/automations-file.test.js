"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseAutomations,
  automationsHash,
  readAutomations,
  presentAutomationsFile,
  slugFromName,
  sharedId,
  MAX_SHARED_AUTOMATIONS,
} = require("../automations-file.js");
const { parseRepoConfig } = require("../repoConfig.js");

const ROW = {
  id: "pr-triage",
  name: "PR triage",
  prompt: "Triage the new pull request.",
  provider: "claude",
  model: null,
  preset: "hourly",
  hour: null,
  trigger: { type: "github", event: "pr_opened" },
  tier: null,
};

describe("parseAutomations", () => {
  it("accepts a valid row and hashes independently of commands", () => {
    const section = parseAutomations({ setup: "npm ci", automations: [ROW] });
    assert.equal(section.error, undefined);
    assert.equal(section.automations.length, 1);
    assert.equal(section.automations[0].id, "pr-triage");
    assert.match(section.hash, /^[0-9a-f]{64}$/);
    const commands = parseRepoConfig({ setup: "npm ci", automations: [ROW] });
    assert.notEqual(section.hash, commands.hash);
    const tweaked = parseAutomations({
      setup: "npm ci",
      automations: [{ ...ROW, prompt: "Different" }],
    });
    assert.notEqual(section.hash, tweaked.hash);
    const sameAuto = parseAutomations({
      setup: "evil",
      automations: [ROW],
    });
    assert.equal(section.hash, sameAuto.hash);
  });

  it("one bad row fails only the automations section", () => {
    const data = {
      setup: "npm ci",
      automations: [{ ...ROW, id: "BAD" }],
    };
    const section = parseAutomations(data);
    assert.match(section.error, /id/);
    assert.deepEqual(section.automations, []);
    const commands = parseRepoConfig(data);
    assert.equal(commands.setup, "npm ci");
    assert.equal(commands.error, undefined);
  });

  it("rejects a 17th row, a duplicate id, and a too-long prompt", () => {
    const many = Array.from({ length: MAX_SHARED_AUTOMATIONS + 1 }, (_, i) => ({
      ...ROW,
      id: `job-${i}`,
    }));
    assert.match(parseAutomations({ automations: many }).error, /16/);
    assert.match(
      parseAutomations({ automations: [ROW, { ...ROW, name: "Other" }] }).error,
      /duplicate/i,
    );
    assert.match(
      parseAutomations({ automations: [{ ...ROW, prompt: "x".repeat(4001) }] })
        .error,
      /4000/,
    );
  });

  it("an automations-only file still presents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    fs.writeFileSync(
      path.join(dir, "solenta.json"),
      JSON.stringify({ automations: [ROW] }),
    );
    assert.equal(parseRepoConfig({ automations: [ROW] }), null);
    const section = readAutomations(dir);
    assert.equal(section.automations[0].id, "pr-triage");
    const presented = presentAutomationsFile({ path: dir });
    assert.equal(presented.count, 1);
    assert.equal(presented.trusted, false);
    assert.equal(presentAutomationsFile({ remoteHost: "h", path: dir }), null);
  });
});

describe("slugFromName", () => {
  it("derives pr-triage and falls back to auto", () => {
    assert.equal(slugFromName("PR triage", []), "pr-triage");
    assert.equal(slugFromName("PR triage", ["pr-triage"]), "pr-triage-2");
    assert.equal(slugFromName("!!!", []), "auto");
    assert.equal(slugFromName("!!!", ["auto"]), "auto-2");
  });
});

describe("sharedId", () => {
  it("is shared:project:slug", () => {
    assert.equal(sharedId("p1", "pr-triage"), "shared:p1:pr-triage");
  });
});
