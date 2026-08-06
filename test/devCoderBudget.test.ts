/**
 * Dev-mode app.status / settings / git.push / daily budget gate.
 * Run: node --experimental-strip-types --test test/devCoderBudget.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";

function usd(n: number): string {
  return n.toFixed(2);
}

function budgetMsg(spent: number, budget: number): string {
  return `Daily budget reached ($${usd(spent)} of $${usd(budget)}). Raise or clear the cap in Settings.`;
}

async function waitDone(
  api: ReturnType<typeof createDevCoder>,
  threadId: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const d = await api.threads.get(threadId);
    if (d.thread.status === "done") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not complete");
}

async function createThread(opts?: { withBranch?: boolean }) {
  const api = createDevCoder();
  const projects = await api.projects.list();
  let t = await api.threads.create({
    projectId: projects[0]!.id,
    title: "Budget thread",
  });
  if (opts?.withBranch) {
    t = await api.git.setupWorktree({ threadId: t.id });
  }
  return { api, threadId: t.id, thread: t };
}

describe("settings.get/set", () => {
  it("defaults dailyBudgetUsd to null", async () => {
    const api = createDevCoder();
    const s = await api.settings.get();
    assert.equal(s.dailyBudgetUsd, null);
  });

  it("sets and returns a positive daily budget", async () => {
    const api = createDevCoder();
    const s = await api.settings.set({ dailyBudgetUsd: 5 });
    assert.equal(s.dailyBudgetUsd, 5);
    const again = await api.settings.get();
    assert.equal(again.dailyBudgetUsd, 5);
  });

  it("clears budget when set to null", async () => {
    const api = createDevCoder();
    await api.settings.set({ dailyBudgetUsd: 2 });
    const s = await api.settings.set({ dailyBudgetUsd: null });
    assert.equal(s.dailyBudgetUsd, null);
  });

  it("rejects non-positive budgets with exact validation copy", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.settings.set({ dailyBudgetUsd: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Daily budget must be a positive number or null",
        );
        return true;
      },
    );
    await assert.rejects(
      () => api.settings.set({ dailyBudgetUsd: -1 }),
      /Daily budget must be a positive number or null/,
    );
    await assert.rejects(
      () =>
        api.settings.set({
          dailyBudgetUsd: "nope" as unknown as number,
        }),
      /Daily budget must be a positive number or null/,
    );
  });
});

describe("app.status", () => {
  it("reports memory server running on fixed port, not adopted", async () => {
    const api = createDevCoder();
    const status = await api.app.status();
    assert.equal(status.memory.running, true);
    assert.equal(status.memory.adopted, false);
    assert.equal(status.memory.port, 49999);
    assert.equal(typeof status.spendTodayUsd, "number");
    assert.ok(status.spendTodayUsd >= 0);
  });

  it("accumulates spendTodayUsd as fake runs complete", async () => {
    const { api, threadId } = await createThread();
    const before = await api.app.status();
    await api.runs.start({ threadId, prompt: "cheap turn" });
    await waitDone(api, threadId);
    const after = await api.app.status();
    assert.ok(
      after.spendTodayUsd > before.spendTodayUsd,
      `expected spend to grow: ${before.spendTodayUsd} -> ${after.spendTodayUsd}`,
    );
  });
});

describe("git.push", () => {
  it("succeeds after a delay when the thread has a branch", async () => {
    const { api, threadId, thread } = await createThread({ withBranch: true });
    assert.ok(thread.branch);
    const started = Date.now();
    const result = await api.git.push({ threadId });
    const elapsed = Date.now() - started;
    assert.equal(result.branch, thread.branch);
    assert.ok(result.remote);
    assert.ok(elapsed >= 100, "expected a short delay before resolve");
  });

  it("rejects when no branch is set", async () => {
    const { api, threadId } = await createThread({ withBranch: false });
    await assert.rejects(
      () => api.git.push({ threadId }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "No git remote configured for this project.");
        return true;
      },
    );
  });
});

describe("daily budget gate", () => {
  it("rejects runs.start with exact backend message when over budget", async () => {
    const { api, threadId } = await createThread();
    await api.settings.set({ dailyBudgetUsd: 0.01 });
    await api.runs.start({ threadId, prompt: "first turn" });
    await waitDone(api, threadId);

    const status = await api.app.status();
    assert.ok(status.spendTodayUsd >= 0.01);
    const budget = (await api.settings.get()).dailyBudgetUsd!;

    await assert.rejects(
      () => api.runs.start({ threadId, prompt: "blocked" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, budgetMsg(status.spendTodayUsd, budget));
        return true;
      },
    );
  });

  it("rejects startWorkflow with the same budget message", async () => {
    const { api, threadId } = await createThread();
    await api.settings.set({ dailyBudgetUsd: 0.01 });
    await api.runs.start({ threadId, prompt: "spend some" });
    await waitDone(api, threadId);

    const status = await api.app.status();
    const budget = (await api.settings.get()).dailyBudgetUsd!;

    await assert.rejects(
      () =>
        api.runs.startWorkflow({
          threadId,
          prompt: "build blocked",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, budgetMsg(status.spendTodayUsd, budget));
        return true;
      },
    );
  });

  it("allows start when budget is cleared", async () => {
    const { api, threadId } = await createThread();
    await api.settings.set({ dailyBudgetUsd: 0.01 });
    await api.runs.start({ threadId, prompt: "spend" });
    await waitDone(api, threadId);
    await api.settings.set({ dailyBudgetUsd: null });
    const { runId } = await api.runs.start({
      threadId,
      prompt: "allowed again",
    });
    assert.ok(runId);
    await api.runs.stop({ threadId });
  });
});
