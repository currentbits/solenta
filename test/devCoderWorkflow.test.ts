/**
 * Dev-mode runs.startWorkflow: claude-only Build orchestration.
 * Run: node --experimental-strip-types --test test/devCoderWorkflow.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

async function createClaudeThread() {
  const api = createDevCoder();
  const projects = await api.projects.list();
  const t = await api.threads.create({
    projectId: projects[0]!.id,
    title: "Workflow thread",
  });
  assert.equal(t.provider, "claude");
  return { api, threadId: t.id };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const intervalMs = opts.intervalMs ?? 50;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describe("runs.startWorkflow", () => {
  it("rejects non-claude threads with the exact provider message", async () => {
    const api = createDevCoder();
    const projects = await api.projects.list();
    const t = await api.threads.create({
      projectId: projects[0]!.id,
      title: "Codex thread",
    });
    await api.threads.setProvider({ threadId: t.id, provider: "codex" });

    await assert.rejects(
      () =>
        api.runs.startWorkflow({
          threadId: t.id,
          prompt: "build something",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Workflow runs currently require the Claude provider.",
        );
        return true;
      },
    );
  });

  it("rejects while a run is already active", async () => {
    const { api, threadId } = await createClaudeThread();
    await api.runs.start({ threadId, prompt: "session turn" });

    await assert.rejects(
      () =>
        api.runs.startWorkflow({
          threadId,
          prompt: "build while busy",
        }),
      /already active/i,
    );

    await api.runs.stop({ threadId });
  });

  it("starts seed→analyze(2)→synthesize workflow with kickoff, work log, and answer", async () => {
    const { api, threadId } = await createClaudeThread();
    const updates: import("../src/shared/ipc.ts").ThreadDetail[] = [];
    const unsub = api.on("thread:updated", (d) => {
      updates.push(d);
    });

    const { runId } = await api.runs.startWorkflow({
      threadId,
      prompt: "Wire the Build button",
    });
    assert.ok(runId);

    const first = await api.threads.get(threadId);
    assert.equal(first.thread.status, "working");
    assert.ok(first.workflow);
    assert.equal(first.workflow!.complete, false);
    assert.equal(first.workflow!.total, 4);
    assert.deepEqual(
      first.workflow!.phases.map((p) => p.name),
      ["seed", "analyze", "synthesize"],
    );
    assert.equal(first.workflow!.phases[0]!.agents.length, 1);
    assert.equal(first.workflow!.phases[1]!.agents.length, 2);
    assert.equal(first.workflow!.phases[2]!.agents.length, 1);

    const userMsg = first.messages.find((m) => m.role === "user");
    assert.ok(userMsg);
    assert.equal(userMsg!.text, "Wire the Build button");
    assert.equal(userMsg!.runId, runId);

    const kickoff = first.messages.find((m) => m.role === "event");
    assert.ok(kickoff);
    assert.ok(kickoff!.text.includes("\n"), "kickoff body is multi-line");
    assert.match(kickoff!.text, /seed|Seed/i);
    assert.match(kickoff!.text, /analyze|Analyze/i);
    assert.match(kickoff!.text, /synthesize|Synthesize/i);

    await waitFor(async () => {
      const d = await api.threads.get(threadId);
      return d.thread.status === "done" && d.workflow?.complete === true;
    });

    const done = await api.threads.get(threadId);
    assert.equal(done.thread.status, "done");
    assert.ok(done.workflow?.complete);
    assert.equal(done.workflow!.settled, 4);
    assert.ok(done.workflow!.tokensTotal > 0);

    const answer = done.messages.find(
      (m) => m.role === "assistant" && m.text.startsWith("Workflow answer:"),
    );
    assert.ok(answer, "final assistant message starts with Workflow answer:");
    assert.equal(answer!.runId, runId);

    const phaseLabels = ["Seed", "Analyze", "Synthesize"];
    for (const label of phaseLabels) {
      const item = done.workLog.find(
        (w) => w.runId === runId && w.label === label,
      );
      assert.ok(item, `work log has ${label}`);
      assert.equal(item!.done, true);
    }

    assert.ok(done.usage);
    assert.ok(done.usage!.turns >= 1);
    assert.ok(done.usage!.inputTokens > 0);
    assert.ok(updates.length >= 2, "live updates via thread:updated");

    unsub();
  });

  it("stop fails running agents, idles thread, and posts Run stopped", async () => {
    const { api, threadId } = await createClaudeThread();
    await api.runs.startWorkflow({
      threadId,
      prompt: "stop me mid-build",
    });

    await waitFor(async () => {
      const d = await api.threads.get(threadId);
      return Boolean(
        d.workflow?.phases.some((p) =>
          p.agents.some((a) => a.status === "running"),
        ),
      );
    });

    await api.runs.stop({ threadId });
    const after = await api.threads.get(threadId);
    assert.equal(after.thread.status, "idle");
    assert.equal(after.thread.runStartedAt, null);

    const runningLeft = after.workflow?.phases
      .flatMap((p) => p.agents)
      .filter((a) => a.status === "running");
    assert.equal(runningLeft?.length ?? 0, 0);

    const failed = after.workflow?.phases
      .flatMap((p) => p.agents)
      .filter((a) => a.status === "failed");
    assert.ok((failed?.length ?? 0) >= 1, "at least one agent marked failed");

    const stopEvt = after.messages.find(
      (m) => m.role === "event" && m.text === "Run stopped",
    );
    assert.ok(stopEvt);
  });
});
