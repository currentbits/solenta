/**
 * DevCoder / FakeCoder harness import twins.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/harnessImportTwins.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";

describe("harness import twins", () => {
  it("detects Claude Code and installs a previewed skill", async () => {
    for (const api of [createFakeCoder().api, createDevCoder()]) {
      const sources = await api.harness.detectSources();
      assert.equal(sources.find((s) => s.id === "claude")?.present, true);
      assert.equal(sources.find((s) => s.id === "cursor")?.present, false);
      const preview = await api.harness.previewImport({ source: "claude" });
      assert.equal(preview.source.id, "claude");
      assert.ok(preview.skills.some((s) => s.name === "house-style"));
      assert.ok(preview.commands.some((c) => c.name === "draft"));
      const result = await api.harness.installImport({
        previewId: preview.previewId,
        selected: ["skill:house-style", "command:user:draft"],
        replace: false,
        trustLocal: false,
      });
      assert.equal(result.skills[0].status, "installed");
      assert.equal(result.commands[0].status, "installed");
      const listed = await api.skills.list();
      assert.ok(listed.some((s) => s.name === "house-style"));
    }
  });
});
