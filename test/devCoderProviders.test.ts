/**
 * Dev-mode providers.list + threads.setProvider lock semantics.
 * Run: node --experimental-strip-types --test test/devCoderProviders.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

describe("providers.list", () => {
  it("returns claude/codex/opencode available, grok unavailable, claude models only", async () => {
    const api = createDevCoder();
    const list = await api.providers.list();
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));

    assert.equal(byId.claude?.available, true);
    assert.equal(byId.claude?.name, "Claude Code");
    assert.deepEqual(byId.claude?.models, [
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);

    assert.equal(byId.codex?.available, true);
    assert.deepEqual(byId.codex?.models, []);

    assert.equal(byId.grok?.available, false);
    assert.equal(byId.grok?.name, "Grok");
    assert.deepEqual(byId.grok?.models, []);

    assert.equal(byId.opencode?.available, true);
    assert.deepEqual(byId.opencode?.models, []);
  });
});

describe("threads.setProvider", () => {
  it("createThread defaults model to null", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    assert.equal(t.model, null);
    assert.equal(t.provider, "claude");
    assert.equal(t.sessionId, null);
  });

  it("allows provider switch before sessionId is set and clears model", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await api.threads.setProvider({
      threadId: t.id,
      model: "claude-opus-5",
    });
    const updated = await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
    });
    assert.equal(updated.provider, "codex");
    assert.equal(updated.model, null);
  });

  it("rejects provider change after sessionId is set", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    // Start a run so sessionId is stamped (first turn).
    await api.runs.start({ threadId: t.id, prompt: "hello" });
    await api.runs.stop({ threadId: t.id });
    const after = await api.threads.get(t.id);
    assert.ok(after.thread.sessionId);

    await assert.rejects(
      () =>
        api.threads.setProvider({
          threadId: t.id,
          provider: "codex",
        }),
      /already has a claude session/i,
    );
    const still = await api.threads.get(t.id);
    assert.equal(still.thread.provider, "claude");
  });

  it("allows model-only change for claude with sessionId", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await api.runs.start({ threadId: t.id, prompt: "hello" });
    await api.runs.stop({ threadId: t.id });

    const updated = await api.threads.setProvider({
      threadId: t.id,
      model: "claude-sonnet-5",
    });
    assert.equal(updated.model, "claude-sonnet-5");
    assert.equal(updated.provider, "claude");
    assert.ok(updated.sessionId);
  });

  it("accepts custom non-empty model for providers with empty models list", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await api.threads.setProvider({ threadId: t.id, provider: "codex" });
    const updated = await api.threads.setProvider({
      threadId: t.id,
      model: "o3",
    });
    assert.equal(updated.provider, "codex");
    assert.equal(updated.model, "o3");
  });

  it("trims custom models and rejects empty or over-long for empty-list providers", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await api.threads.setProvider({ threadId: t.id, provider: "codex" });

    const trimmed = await api.threads.setProvider({
      threadId: t.id,
      model: "  gpt-5.1-codex  ",
    });
    assert.equal(trimmed.model, "gpt-5.1-codex");

    await assert.rejects(
      () =>
        api.threads.setProvider({
          threadId: t.id,
          model: "   ",
        }),
      /Model must be a non-empty string/,
    );

    await assert.rejects(
      () =>
        api.threads.setProvider({
          threadId: t.id,
          model: "x".repeat(101),
        }),
      /Model must be a non-empty string/,
    );
  });

  it("keeps a valid custom model when switching to an empty-list provider", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    const updated = await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
      model: "o4-mini",
    });
    assert.equal(updated.provider, "codex");
    assert.equal(updated.model, "o4-mini");
  });

  it("rejects model not in a non-empty models list", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await assert.rejects(
      () =>
        api.threads.setProvider({
          threadId: t.id,
          model: "not-a-claude-model",
        }),
      /not in provider|model list|not supported/i,
    );
  });

  it("clears model to default (null) for empty-list providers", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await api.threads.setProvider({ threadId: t.id, provider: "codex" });
    await api.threads.setProvider({ threadId: t.id, model: "o3" });
    const cleared = await api.threads.setProvider({
      threadId: t.id,
      model: null,
    });
    assert.equal(cleared.model, null);
  });

  it("does not bump updatedAt on setProvider", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    const before = t.updatedAt;
    // tiny wait so a buggy bump would be visible if it used Date.now()
    await new Promise((r) => setTimeout(r, 5));
    const updated = await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
    });
    assert.equal(updated.updatedAt, before);
  });

  it("rejects unknown provider id", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await assert.rejects(
      () =>
        api.threads.setProvider({
          threadId: t.id,
          provider: "not-a-real-provider",
        }),
      /Unknown provider/i,
    );
  });

  it("fake run works for non-claude providers", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await api.threads.setProvider({ threadId: t.id, provider: "codex" });
    const { runId } = await api.runs.start({
      threadId: t.id,
      prompt: "do a thing",
    });
    assert.ok(runId);
    const detail = await api.threads.get(t.id);
    assert.equal(detail.thread.status, "working");
    assert.equal(detail.thread.provider, "codex");
    await api.runs.stop({ threadId: t.id });
  });
});
