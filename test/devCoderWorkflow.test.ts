/**
 * Dev-mode runs.startWorkflow: template-driven Build orchestration.
 * Run: node --experimental-strip-types --test test/devCoderWorkflow.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

async function createThread(provider = "claude") {
  const api = createDevCoder();
  const projects = await api.projects.list();
  let t = await api.threads.create({
    projectId: projects[0]!.id,
    title: "Workflow thread",
  });
  if (provider !== t.provider) {
    t = await api.threads.setProvider({ threadId: t.id, provider });
  }
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
  it("allows non-claude threads when all phase providers are available", async () => {
    const { api, threadId } = await createThread("codex");
    const { runId } = await api.runs.startWorkflow({
      threadId,
      prompt: "build on codex",
    });
    assert.ok(runId);
    await api.runs.stop({ threadId });
  });

  it("rejects while a run is already active", async () => {
    const { api, threadId } = await createThread();
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

  it("rejects unknown templateId", async () => {
    const { api, threadId } = await createThread();
    await assert.rejects(
      () =>
        api.runs.startWorkflow({
          threadId,
          prompt: "go",
          templateId: "does-not-exist",
        }),
      /template|not found|unknown/i,
    );
  });

  it("rejects when a phase provider is unavailable", async () => {
    const { api, threadId } = await createThread();
    const saved = await api.workflows.save({
      name: "Needs Grok",
      phases: [
        {
          name: "plan",
          agentCount: 1,
          instruction: "Plan it",
          provider: "grok",
          model: null,
        },
      ],
    });
    await assert.rejects(
      () =>
        api.runs.startWorkflow({
          threadId,
          prompt: "go",
          templateId: saved.id,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /grok/i);
        assert.match(err.message, /not available|unavailable|not installed/i);
        return true;
      },
    );
  });

  it("defaults to standard: seed→analyze(2)→synthesize with kickoff, work log, dossiers, answer", async () => {
    const { api, threadId } = await createThread();
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

    const dossiers = done.messages.filter(
      (m) => m.role === "tool" && m.tool && m.runId === runId,
    );
    assert.equal(dossiers.length, 4, "one dossier tool message per agent");
    for (const d of dossiers) {
      assert.ok(d.tool);
      assert.equal(d.tool!.done, true);
      assert.ok(d.tool!.output && d.tool!.output.length > 0);
    }

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

  it("simulates custom template phase names and agent counts", async () => {
    const { api, threadId } = await createThread();
    const saved = await api.workflows.save({
      name: "Two phase",
      phases: [
        {
          name: "scout",
          agentCount: 3,
          instruction: "Scout the repo",
          provider: "claude",
          model: null,
        },
        {
          name: "ship",
          agentCount: 1,
          instruction: "Ship it",
          provider: "claude",
          model: "claude-sonnet-5",
        },
      ],
    });

    const { runId } = await api.runs.startWorkflow({
      threadId,
      prompt: "custom template run",
      templateId: saved.id,
    });

    const first = await api.threads.get(threadId);
    assert.deepEqual(
      first.workflow!.phases.map((p) => ({
        name: p.name,
        n: p.agents.length,
      })),
      [
        { name: "scout", n: 3 },
        { name: "ship", n: 1 },
      ],
    );
    assert.equal(first.workflow!.total, 4);
    assert.equal(first.workflow!.name, "Two phase");

    await waitFor(async () => {
      const d = await api.threads.get(threadId);
      return d.thread.status === "done" && d.workflow?.complete === true;
    });

    const done = await api.threads.get(threadId);
    const dossiers = done.messages.filter(
      (m) => m.role === "tool" && m.runId === runId,
    );
    assert.equal(dossiers.length, 4);

    for (const label of ["Scout", "Ship"]) {
      const item = done.workLog.find(
        (w) => w.runId === runId && w.label === label,
      );
      assert.ok(item, `work log has ${label}`);
      assert.equal(item!.done, true);
    }
  });

  it("stop fails running agents, idles thread, and posts Run stopped", async () => {
    const { api, threadId } = await createThread();
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
