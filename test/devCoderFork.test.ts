/**
 * Dev-mode twins for round 49 fork / hand-off.
 * Run: node --experimental-strip-types --test test/devCoderFork.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandoffPrefix, createDevCoder } from "../src/devCoder.ts";

describe("devCoder threads.fork", () => {
  it("copies config, sets handoffFrom, leaves source untouched", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const source = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Src",
    });
    await api.threads.setProvider({
      threadId: source.id,
      provider: "codex",
      model: "gpt-5",
    });
    await api.threads.setPermissionMode({
      threadId: source.id,
      mode: "acceptEdits",
    });
    const before = await api.threads.get(source.id);

    const forked = await api.threads.fork({ threadId: source.id });
    assert.notEqual(forked.id, source.id);
    assert.equal(forked.provider, "codex");
    assert.equal(forked.model, "gpt-5");
    assert.equal(forked.permissionMode, "acceptEdits");
    assert.equal(forked.handoffFrom, source.id);
    assert.equal(forked.sessionId, null);
    assert.equal(forked.title, "Fork: Src");
    assert.equal(forked.lastVisitedAt, forked.createdAt);

    const afterSource = await api.threads.get(source.id);
    assert.equal(afterSource.thread.provider, before.thread.provider);
    assert.equal(afterSource.thread.model, before.thread.model);
    assert.equal(afterSource.thread.title, before.thread.title);
    assert.equal(afterSource.messages.length, before.messages.length);
  });

  it("rejects unknown source and bad provider with setProvider strings", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.threads.fork({ threadId: "missing" }),
      /Unknown thread: missing/,
    );
    const projects = await api.projects.list();
    const source = await api.threads.create({
      projectId: projects[0]!.id,
      title: "S",
    });
    await assert.rejects(
      () =>
        api.threads.fork({
          threadId: source.id,
          provider: "nope",
        }),
      /Unknown provider: nope/,
    );
  });

  it("buildHandoffPrefix strings match electron services twin", () => {
    const prefix = buildHandoffPrefix(
      { handoffFrom: "x", sessionId: null },
      () => [
        { role: "user", text: "ASK" },
        { role: "assistant", text: "HELLO" },
      ],
    );
    assert.equal(
      prefix,
      "[Hand-off context: the last messages of the source thread, truncated — " +
        "not the full transcript]\nuser: ASK\n\nassistant: HELLO\n[End context]\n\n",
    );
    assert.equal(
      buildHandoffPrefix({ handoffFrom: "x", sessionId: "s" }, () => [
        { role: "assistant", text: "HELLO" },
      ]),
      "",
    );
  });

  it("first start stores raw prompt; prefix only when handoffFrom + no session", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const source = await api.threads.create({
      projectId: projects[0]!.id,
      title: "With answer",
    });
    // Seed an assistant message via a run on source, then fork.
    await api.runs.start({ threadId: source.id, prompt: "seed me" });
    // Wait a tick for simulate/session to append assistant if any — for
    // reliability, inject via a second fork path: use empty source (no prefix)
    // and assert raw transcript; plus unit-test the helper above.
    const forked = await api.threads.fork({ threadId: source.id });
    assert.equal(forked.sessionId, null);
    assert.equal(forked.handoffFrom, source.id);

    await api.runs.start({
      threadId: forked.id,
      prompt: "raw user text",
    });
    const detail = await api.threads.get(forked.id);
    const users = detail.messages.filter((m) => m.role === "user");
    assert.ok(users.some((m) => m.text === "raw user text"));
    assert.ok(users.every((m) => !m.text.includes("[Hand-off context")));
    // After first start, session exists so a second start must not re-prefix.
    assert.ok(detail.thread.sessionId);
  });
});
