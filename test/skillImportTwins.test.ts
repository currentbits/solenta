/**
 * DevCoder / FakeCoder skill-import twins stamp catalog installs as curated.
 * Run: node --experimental-strip-types --test test/skillImportTwins.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillImportPreview } from "../src/shared/ipc";
import { createDevCoder } from "../src/devCoder.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";

const INSTALL = {
  previewId: "0".repeat(32),
  selected: ["review-pr"],
  replace: true,
  trustPluginCode: false,
};

describe("skill import twins", () => {
  it("FakeCoder stamps catalog installs curated and GitHub/local as added", async () => {
    const fake = createFakeCoder();
    await fake.api.skills.previewImport({ kind: "catalog", id: "ponytail" });
    await fake.api.skills.installImport(INSTALL);
    const afterCatalog = (await fake.api.skills.list()).find(
      (s) => s.name === "review-pr",
    );
    assert.equal(afterCatalog?.provenance, "curated");
    assert.equal(afterCatalog?.origin?.catalogId, "ponytail");
    assert.equal((await fake.api.skills.catalog())[0].installed, true);

    await fake.api.skills.previewImport({
      kind: "github",
      url: "https://github.com/acme/tools",
    });
    await fake.api.skills.installImport({
      ...INSTALL,
      selected: ["ship-it"],
      replace: false,
    });
    const github = (await fake.api.skills.list()).find((s) => s.name === "ship-it");
    assert.equal(github?.provenance, "added");
    assert.equal(github?.origin?.catalogId, undefined);
  });

  it("DevCoder stamps catalog installs curated and GitHub as added", async () => {
    const api = createDevCoder();
    await api.skills.previewImport({ kind: "catalog", id: "ponytail" });
    await api.skills.installImport(INSTALL);
    const afterCatalog = (await api.skills.list()).find(
      (s) => s.name === "review-pr",
    );
    assert.equal(afterCatalog?.provenance, "curated");
    assert.equal(afterCatalog?.origin?.catalogId, "ponytail");
    assert.equal((await api.skills.catalog())[0].installed, true);

    await api.skills.previewImport({
      kind: "github",
      url: "https://github.com/acme/tools",
    });
    await api.skills.installImport({
      ...INSTALL,
      selected: ["ship-it"],
      replace: false,
    });
    const github = (await api.skills.list()).find((s) => s.name === "ship-it");
    assert.equal(github?.provenance, "added");
    assert.equal(github?.origin?.catalogId, undefined);
  });

  it("returns production-shaped Ponytail plugin statuses for trusted catalog installs", async () => {
    const expectPonytailPlugins = (
      plugins: Awaited<
        ReturnType<
          ReturnType<typeof createFakeCoder>["api"]["skills"]["installImport"]
        >
      >["plugins"],
    ) => {
      const byProvider = Object.fromEntries(
        plugins.map((row) => [row.provider, row]),
      );
      assert.equal(byProvider.claude.status, "manual");
      assert.deepEqual(byProvider.claude.instructions, [
        "/plugin marketplace add DietrichGebert/ponytail",
        "/plugin install ponytail@ponytail",
      ]);
      assert.equal(byProvider.codex.status, "activated");
      assert.equal(byProvider.grok.status, "activated");
      assert.equal(byProvider.plugin.status, "covered");
      assert.equal(byProvider.hooks.status, "covered");
      assert.equal(byProvider.commands.status, "covered");
    };

    const fake = createFakeCoder();
    await fake.api.skills.previewImport({ kind: "catalog", id: "ponytail" });
    const fakeResult = await fake.api.skills.installImport({
      ...INSTALL,
      trustPluginCode: true,
    });
    expectPonytailPlugins(fakeResult.plugins);

    const api = createDevCoder();
    await api.skills.previewImport({ kind: "catalog", id: "ponytail" });
    const devResult = await api.skills.installImport({
      ...INSTALL,
      trustPluginCode: true,
    });
    expectPonytailPlugins(devResult.plugins);
  });

  it("exposes production-shaped Ponytail extras on catalog preview so the trust gate can run", async () => {
    const expectPreviewExtras = (preview: SkillImportPreview) => {
      assert.deepEqual(
        preview.plugins.map((p) => p.activation.kind).sort(),
        [
          "claude-plugin",
          "codex-plugin",
          "commands",
          "grok-plugin",
          "hooks",
          "plugin",
        ],
      );
      for (const extra of preview.plugins) {
        assert.equal(extra.activation.status, "pending");
        assert.ok(extra.provider);
        assert.ok(extra.label);
        assert.ok(Array.isArray(extra.executableFiles));
      }
      const hooks = preview.plugins.find((p) => p.activation.kind === "hooks");
      assert.ok(hooks);
      assert.ok(hooks.executableFiles.length > 0);
    };

    const fake = createFakeCoder();
    const fakePreview = await fake.api.skills.previewImport({
      kind: "catalog",
      id: "ponytail",
    });
    expectPreviewExtras(fakePreview);
    const fakeGithub = await fake.api.skills.previewImport({
      kind: "github",
      url: "https://github.com/acme/tools",
    });
    assert.deepEqual(fakeGithub.plugins, []);

    const api = createDevCoder();
    const devPreview = await api.skills.previewImport({
      kind: "catalog",
      id: "ponytail",
    });
    expectPreviewExtras(devPreview);
    const devGithub = await api.skills.previewImport({
      kind: "github",
      url: "https://github.com/acme/tools",
    });
    assert.deepEqual(devGithub.plugins, []);
  });
});
