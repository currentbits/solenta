/**
 * Dev-mode memory.search/recent/get/store.
 * Run: node --experimental-strip-types --test test/devCoderMemory.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

describe("memory.recent", () => {
  it("returns seeded entries sorted by updatedAt desc, respects limit", async () => {
    const api = createDevCoder();
    const all = await api.memory.recent();
    assert.ok(all.length >= 6, `expected >= 6 seeds, got ${all.length}`);
    for (let i = 1; i < all.length; i++) {
      assert.ok(
        all[i - 1]!.updatedAt >= all[i]!.updatedAt,
        "recent must be sorted by updatedAt descending",
      );
    }
    const limited = await api.memory.recent({ limit: 3 });
    assert.equal(limited.length, 3);
    assert.equal(limited[0]!.id, all[0]!.id);
  });

  it("seeds multiple types and projects", async () => {
    const api = createDevCoder();
    const all = await api.memory.recent({ limit: 50 });
    const types = new Set(all.map((e) => e.type));
    assert.ok(types.has("knowledge"));
    assert.ok(types.has("convention"));
    assert.ok(types.has("task"));
    const withProject = all.filter((e) => e.project != null);
    const global = all.filter((e) => e.project == null);
    assert.ok(withProject.length >= 1);
    assert.ok(global.length >= 1);
  });

  it("filters by optional project when provided", async () => {
    const api = createDevCoder();
    await api.memory.store({
      type: "knowledge",
      title: "Recent project alpha",
      body: "scoped recent body",
      project: "demo/alpha",
    });
    await api.memory.store({
      type: "knowledge",
      title: "Recent project beta",
      body: "other recent body",
      project: "demo/beta",
    });
    const hits = await api.memory.recent({
      limit: 50,
      project: "demo/alpha",
    });
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((e) => e.project === "demo/alpha"));
    assert.ok(hits.some((e) => e.title === "Recent project alpha"));
  });
});

describe("memory.search", () => {
  it("substring-matches title and body case-insensitively", async () => {
    const api = createDevCoder();
    const seeds = await api.memory.recent({ limit: 50 });
    const target = seeds[0]!;
    const titleHit = await api.memory.search({
      query: target.title.slice(0, Math.min(8, target.title.length)),
    });
    assert.ok(titleHit.some((e) => e.id === target.id));

    // Store a unique body phrase so we can assert body search.
    const { id } = await api.memory.store({
      type: "knowledge",
      title: "Body search probe",
      body: "unique-zebra-token-xyz for body match",
    });
    const bodyHit = await api.memory.search({ query: "unique-zebra-token-xyz" });
    assert.ok(bodyHit.some((e) => e.id === id));

    const empty = await api.memory.search({ query: "zzz-no-such-memory-qqq" });
    assert.equal(empty.length, 0);
  });

  it("filters by optional project when provided", async () => {
    const api = createDevCoder();
    const { id } = await api.memory.store({
      type: "knowledge",
      title: "Project scoped token",
      body: "project-only-alpha-token body",
      project: "demo/alpha",
    });
    await api.memory.store({
      type: "knowledge",
      title: "Other project token",
      body: "project-only-alpha-token other",
      project: "demo/beta",
    });
    const hits = await api.memory.search({
      query: "project-only-alpha-token",
      project: "demo/alpha",
    });
    assert.ok(hits.some((e) => e.id === id));
    assert.ok(hits.every((e) => e.project === "demo/alpha"));
    assert.equal(hits.length, 1);
  });
});

describe("memory.get", () => {
  it("returns full body for a known id", async () => {
    const api = createDevCoder();
    const longBody =
      "Line one of a long memory body.\nLine two with detail.\nLine three finishes it.";
    const { id } = await api.memory.store({
      type: "convention",
      title: "Full body fixture",
      body: longBody,
    });
    const entry = await api.memory.get({ id });
    assert.equal(entry.id, id);
    assert.equal(entry.body, longBody);
    assert.equal(entry.type, "convention");
    assert.equal(entry.title, "Full body fixture");
  });

  it("rejects unknown ids", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.memory.get({ id: "no-such-memory-id" }),
      /not found|unknown/i,
    );
  });
});

describe("memory.store", () => {
  it("appends and appears in recent", async () => {
    const api = createDevCoder();
    const before = await api.memory.recent({ limit: 50 });
    const { id } = await api.memory.store({
      type: "task",
      title: "Fresh store entry",
      body: "Just remembered this.",
      project: "coder",
    });
    assert.ok(id);
    const after = await api.memory.recent({ limit: 50 });
    assert.equal(after.length, before.length + 1);
    assert.equal(after[0]!.id, id);
    assert.equal(after[0]!.title, "Fresh store entry");
    assert.equal(after[0]!.type, "task");
    assert.equal(after[0]!.project, "coder");
  });
});
