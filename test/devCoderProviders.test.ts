/**
 * Dev-mode providers.list + threads.setProvider lock semantics.
 * Run: node --experimental-strip-types --test test/devCoderProviders.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

describe("providers.list", () => {
  it("returns claude/codex/opencode available, grok unavailable, with each provider's models", async () => {
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
    // Every provider now offers models; the dev harness mirrors the real
    // registry, so an empty list here means the two have drifted apart again.
    assert.ok(
      (byId.codex?.models.length ?? 0) > 0,
      "codex must offer models in dev, as it does in production",
    );

    assert.equal(byId.grok?.available, false);
    assert.equal(byId.grok?.name, "Grok");
    assert.deepEqual(byId.grok?.models, ["grok-4.5"]);

    assert.equal(byId.opencode?.available, true);
    assert.ok(
      (byId.opencode?.models.length ?? 0) > 0,
      "opencode must offer models in dev, as it does in production",
    );
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

  it("accepts a custom model id that the published list does not know", async () => {
    // The list is a suggestion, not an allowlist: it is a snapshot of the CLI's
    // catalogue and goes stale when a new model ships. Blocking an unlisted id
    // would stop a user reaching a model their CLI already supports.
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0].id,
      title: "custom model",
    });
    const set = await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
      model: "gpt-6-unreleased",
    });
    assert.equal(
      set.model,
      "gpt-6-unreleased",
      "an id outside the snapshot must still be accepted",
    );
  });

  it("trims a model id and rejects empty", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0].id,
      title: "trim rules",
    });
    const ok = await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
      model: "  gpt-5.5  ",
    });
    assert.equal(ok.model, "gpt-5.5", "a padded id must be trimmed, not rejected");
    await assert.rejects(
      () =>
        api.threads.setProvider({
          threadId: t.id,
          provider: "codex",
          model: "   ",
        }),
      /non-empty/,
    );
  });

  it("keeps a listed model when switching provider", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0].id,
      title: "switch rules",
    });
    const set = await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
      model: "gpt-5.5",
    });
    assert.equal(set.model, "gpt-5.5");
  });

  it("accepts an unlisted model rather than blocking the user", async () => {
    // Was: rejects a model outside the list. The list is now a suggestion, so
    // an id our snapshot does not know still reaches the CLI, which is the
    // thing that can authoritatively reject it.
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    const set = await api.threads.setProvider({
      threadId: t.id,
      model: "claude-something-new-5",
    });
    assert.equal(set.model, "claude-something-new-5");
  });

  it("still rejects an empty or over-long model id", async () => {
    // Suggestions, not anarchy: the guards that protect argv still apply.
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    await assert.rejects(
      () => api.threads.setProvider({ threadId: t.id, model: "   " }),
      /non-empty/i,
    );
    await assert.rejects(
      () =>
        api.threads.setProvider({ threadId: t.id, model: "x".repeat(101) }),
      /100 characters/i,
    );
  });

  it("trims before membership check for non-empty models list (matches electron)", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "T",
    });
    // Backend trims first; " claude-sonnet-5 " must be accepted as claude-sonnet-5.
    const updated = await api.threads.setProvider({
      threadId: t.id,
      model: " claude-sonnet-5 ",
    });
    assert.equal(updated.model, "claude-sonnet-5");

    await assert.rejects(
      () =>
        api.threads.setProvider({
          threadId: t.id,
          model: "   ",
        }),
      /Model must be a non-empty string/,
    );
  });

  it("clears model to default (null)", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0].id,
      title: "clear rules",
    });
    await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
      model: "gpt-5.5",
    });
    const cleared = await api.threads.setProvider({
      threadId: t.id,
      provider: "codex",
      model: null,
    });
    assert.equal(cleared.model, null, "null must mean the provider default");
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

describe("dev harness matches production on provider change", () => {
  it("clears a stranded reasoning effort", async () => {
    // The dev harness carries a comment saying it matches services.setProvider
    // exactly. It did not, so `npm run dev` reproduced the very bug the shipped
    // path had just fixed, which reads as the fix not landing.
    const api = createDevCoder();
    const projects = await api.projects.list();
    // A fresh thread: a seeded one has a session, which locks the provider.
    const t = await api.threads.create({
      projectId: projects[0].id,
      title: "effort parity",
    });
    await api.threads.setProvider({ threadId: t.id, provider: "claude" });
    await api.threads.setReasoningEffort({ threadId: t.id, effort: "max" });
    const before = (await api.threads.get(t.id)).thread;
    assert.equal(before.reasoningEffort, "max");

    await api.threads.setProvider({ threadId: t.id, provider: "grok" });
    const after = (await api.threads.get(t.id)).thread;
    assert.equal(
      after.reasoningEffort,
      null,
      "dev must clear an effort the new provider cannot honour, like production",
    );
  });
});
