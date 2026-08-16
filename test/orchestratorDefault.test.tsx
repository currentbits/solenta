/**
 * Which MODE does plain "New thread" create? The precedence rule lives in
 * useCoder.createThread and every other test stubs it out: the sidebar tests
 * assert the caret's explicit options, the electron tests assert what
 * threads:create does with `orchestrate`. Nothing covered the resolution in
 * between, where an orchestrator must beat a worktree and a remote project
 * must beat both.
 *
 * Mutant: drop the `!orchestrate &&` guard and a defaultOrchestrate user
 * silently gets worktree threads that never delegate.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, inAct } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";

async function boot(fake: FakeCoder) {
  // window must exist before the fake is installed, and dom.ts creates it on
  // first mount, so mount an empty shell first.
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

/** Click the sidebar's plain "New thread" button (no explicit mode). */
async function clickNewThread(m: Awaited<ReturnType<typeof boot>>) {
  const btn = m.query('button[aria-label^="New thread in"]');
  assert.ok(btn, "sidebar has a plain New thread button");
  await inAct(() => btn.click());
}

describe("plain New thread mode resolution", () => {
  it("defaultOrchestrate wins over defaultWorktree", async () => {
    // Both defaults on: an orchestrator never holds a worktree itself — its
    // worker does — so the worktree flag must not ride along.
    const fake = createFakeCoder({
      settings: {
        dailyBudgetUsd: null,
        orchestrationBudgetUsd: null,
        autoSettleAfterDays: 3,
        mcpServers: [],
        defaultWorktree: true,
        defaultOrchestrate: true,
        updateChannel: null,
      },
    });
    const m = await boot(fake);
    await clickNewThread(m);

    const created = fake.of("threads.create");
    assert.equal(created.length, 1);
    const input = created[0].args[0] as Record<string, unknown>;
    assert.equal(input.orchestrate, true);
    assert.equal(input.worktree, undefined);
    m.unmount();
  });

  it("defaultWorktree alone still creates a worktree thread", async () => {
    const fake = createFakeCoder({
      settings: {
        dailyBudgetUsd: null,
        orchestrationBudgetUsd: null,
        autoSettleAfterDays: 3,
        mcpServers: [],
        defaultWorktree: true,
        defaultOrchestrate: false,
        updateChannel: null,
      },
    });
    const m = await boot(fake);
    await clickNewThread(m);

    const input = fake.of("threads.create")[0].args[0] as Record<
      string,
      unknown
    >;
    assert.equal(input.worktree, true);
    assert.equal(input.orchestrate, undefined);
    m.unmount();
  });

  it("remote projects get a plain thread whatever the defaults say", async () => {
    // Worktrees are local-only, and an orchestrator's worker needs one.
    const fake = createFakeCoder({
      projects: [project({ remoteHost: "box", remotePath: "/srv/repo" })],
      settings: {
        dailyBudgetUsd: null,
        orchestrationBudgetUsd: null,
        autoSettleAfterDays: 3,
        mcpServers: [],
        defaultWorktree: true,
        defaultOrchestrate: true,
        updateChannel: null,
      },
    });
    const m = await boot(fake);
    await clickNewThread(m);

    const input = fake.of("threads.create")[0].args[0] as Record<
      string,
      unknown
    >;
    assert.equal(input.orchestrate, undefined);
    assert.equal(input.worktree, undefined);
    m.unmount();
  });
});
