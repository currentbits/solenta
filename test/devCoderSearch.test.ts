/**
 * Dev-mode threads.search: titles + message text, newest first, max 50.
 * Run: CODER_GROK_MCP_DISABLE=1 node --experimental-strip-types --test test/devCoderSearch.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

describe("threads.search", () => {
  it("returns [] for empty and 1-char queries", async () => {
    const api = createDevCoder();
    assert.deepEqual(await api.threads.search({ query: "" }), []);
    assert.deepEqual(await api.threads.search({ query: " " }), []);
    assert.deepEqual(await api.threads.search({ query: "a" }), []);
    assert.deepEqual(await api.threads.search({ query: " x " }), []);
  });

  it("matches thread titles case-insensitively", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const projectId = projects[0]!.id;
    const created = await api.threads.create({
      projectId,
      title: "UniqueTitleZebraSearchProbe",
    });
    const hits = await api.threads.search({ query: "uniqueTitlezebra" });
    assert.ok(
      hits.some((t) => t.id === created.id),
      "title substring must match case-insensitively",
    );
  });

  it("matches message text (content hit)", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const projectId = projects[0]!.id;
    const created = await api.threads.create({
      projectId,
      title: "Neutral Title No Keyword",
    });
    // Seed a message with a unique phrase via start (dev renames New Thread only;
    // we already set a non-default title so title won't match the token).
    await api.runs.start({
      threadId: created.id,
      prompt: "please find unique-content-token-xyz in this body",
    });
    const hits = await api.threads.search({
      query: "unique-content-token-xyz",
    });
    assert.ok(
      hits.some((t) => t.id === created.id),
      "message text must match even when title does not",
    );
    // Title does not contain the query.
    const hit = hits.find((t) => t.id === created.id)!;
    assert.ok(!hit.title.toLowerCase().includes("unique-content-token-xyz"));
  });

  it("dedupes a thread that hits on both title and message", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const projectId = projects[0]!.id;
    const token = "dedupe-token-aabbcc";
    const created = await api.threads.create({
      projectId,
      title: `About ${token} in title`,
    });
    await api.runs.start({
      threadId: created.id,
      prompt: `also mention ${token} in the message body`,
    });
    const hits = await api.threads.search({ query: token });
    const ids = hits.filter((t) => t.id === created.id);
    assert.equal(ids.length, 1, "same thread must appear once");
  });

  it("includes archived threads", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const projectId = projects[0]!.id;
    const created = await api.threads.create({
      projectId,
      title: "ArchivedSearchOnlyTitleQq",
    });
    await api.threads.setArchived({ threadId: created.id, archived: true });
    const hits = await api.threads.search({ query: "ArchivedSearchOnlyTitleQq" });
    assert.ok(
      hits.some((t) => t.id === created.id && t.archived === true),
      "archived threads must be included",
    );
  });

  it("sorts by updatedAt DESC and caps at 50", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const projectId = projects[0]!.id;
    const marker = "cap-marker-sort-xyz";
    const createdIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const t = await api.threads.create({
        projectId,
        title: `${marker} thread ${i}`,
      });
      createdIds.push(t.id);
    }
    const hits = await api.threads.search({ query: marker });
    assert.ok(hits.length <= 50, `expected cap 50, got ${hits.length}`);
    assert.equal(hits.length, 50);
    for (let i = 1; i < hits.length; i++) {
      assert.ok(
        hits[i - 1]!.updatedAt >= hits[i]!.updatedAt,
        "results must be sorted by updatedAt descending",
      );
    }
    // Newest create lands first in the list (create prepends + bumps updatedAt).
    assert.equal(hits[0]!.id, createdIds[createdIds.length - 1]);
  });
});
