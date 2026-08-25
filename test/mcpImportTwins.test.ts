/**
 * DevCoder / FakeCoder MCP catalog/import twins.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/mcpImportTwins.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";

describe("MCP import twins", () => {
  it("lists the same three catalog entries and stamps catalog installs curated", async () => {
    for (const api of [createFakeCoder().api, createDevCoder()]) {
      const catalog = await api.mcp.catalog();
      assert.equal(catalog.length, 3);
      assert.deepEqual(catalog.map((e) => e.id).sort(), [
        "context7",
        "linear",
        "playwright",
      ]);
      assert.equal(catalog.every((e) => e.installed === false), true);
      const preview = await api.mcp.previewImport({
        kind: "catalog",
        id: "context7",
      });
      assert.equal(preview.source.kind, "catalog");
      assert.equal(preview.servers[0].name, "context7");
      const installed = await api.mcp.installImport({
        previewId: preview.previewId,
        selected: ["context7"],
        replace: false,
        trustLocalCommands: false,
      });
      assert.equal(installed.installed[0].provenance, "curated");
      assert.equal(installed.installed[0].catalogId, "context7");
      assert.equal((await api.mcp.catalog()).find((e) => e.id === "context7")?.installed, true);
    }
  });

  it("stamps GitHub imports added and requires exact trust for stdio", async () => {
    for (const api of [createFakeCoder().api, createDevCoder()]) {
      const preview = await api.mcp.previewImport({
        kind: "github",
        url: "https://github.com/acme/tools",
      });
      assert.equal(preview.source.kind, "github");
      const stdio = preview.servers.find((s) => s.transport === "stdio");
      if (stdio) {
        assert.equal(stdio.trusted, false);
        await assert.rejects(
          () =>
            api.mcp.installImport({
              previewId: preview.previewId,
              selected: [stdio.name],
              replace: false,
              trustLocalCommands: true,
            }),
          /trust|secret|preview/i,
        );
      }
      const remote = preview.servers.find((s) => s.transport !== "stdio");
      assert.ok(remote);
      const secrets = Object.fromEntries(
        (remote.requiredSecrets || []).map((d) => [d.id, "twin-secret"]),
      );
      const result = await api.mcp.installImport({
        previewId: preview.previewId,
        selected: [remote.name],
        replace: false,
        trustLocalCommands: false,
        secrets,
      });
      assert.equal(result.installed[0].provenance, "added");
      assert.equal(result.installed[0].catalogId, undefined);
    }
  });

  it("pickImport returns null in browser twins and discard is a no-op", async () => {
    const fake = createFakeCoder();
    assert.equal(await fake.api.mcp.pickImport(), null);
    await fake.api.mcp.discardImport({ previewId: "0".repeat(32) });
    const api = createDevCoder();
    assert.equal(await api.mcp.pickImport(), null);
    await api.mcp.discardImport({ previewId: "0".repeat(32) });
  });
});
