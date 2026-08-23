/**
 * Round 50: checkpoints list + restore wiring through real App.
 *
 * Fixture discipline: 3+ checkpoints, restore the MIDDLE one, source
 * thread not index 0. Mutant the reviewer will run: gutting
 * restore-truncates-later-checkpoints — this suite depends on it.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { CheckpointInfo, ThreadInfo } from "../src/shared/ipc";

const NOW = Date.now();

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  // The agents rail auto-collapses when a workspace pane opens (#147) and
  // that choice persists, so clear it or the previous test decides this one.
  window.localStorage.removeItem("coder.agents.collapsed");
  return mount(<App />);
}

/**
 * Re-open the agents rail. Opening the Git pane collapses it, so anything
 * that reads the Environment tab AFTER a restore has to ask for it back.
 */
async function expandAgents(m: Awaited<ReturnType<typeof mount>>) {
  const expand = m.query("[data-agents-expand]");
  if (expand) {
    await m.click(expand as HTMLElement);
    await m.flush();
  }
}

function decoy(): ThreadInfo {
  return thread({
    id: "t-decoy",
    title: "decoy first thread",
    status: "idle",
    worktreePath: null,
    updatedAt: NOW + 9000,
  });
}

/** Not index 0; has worktree + 3 checkpoints. */
function source(): ThreadInfo {
  return thread({
    id: "t-cp-source",
    title: "checkpoint source thread",
    status: "idle",
    worktreePath: "/tmp/wt/checkpoint-source",
    branch: "feat/cp",
    updatedAt: NOW + 1000,
  });
}

/** Newest-first: turn 3, turn 2 (middle), turn 1. */
function threeCheckpoints(): CheckpointInfo[] {
  return [
    {
      sha: "aaa1111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      turn: 3,
      message: "coder-checkpoint: turn 3",
      at: NOW - 60_000,
    },
    {
      sha: "bbb2222ccccccccccccccccccccccccccccccc",
      turn: 2,
      message: "coder-checkpoint: turn 2",
      at: NOW - 120_000,
    },
    {
      sha: "ccc3333ddddddddddddddddddddddddddddddd",
      turn: 1,
      message: "coder-checkpoint: turn 1",
      at: NOW - 180_000,
    },
  ];
}

async function selectThread(
  m: Awaited<ReturnType<typeof mount>>,
  title: string,
) {
  // aria-label may carry ", unread" / ", working" suffixes (#566).
  const card = m.query(`button[aria-label^="Select thread: ${title}"]`);
  assert.ok(card, `thread card for "${title}" must exist`);
  await m.click(card as HTMLElement);
  await m.flush();
}

async function openGitTab(m: Awaited<ReturnType<typeof mount>>) {
  await expandAgents(m);
  const git = m
    .queryAll("button")
    .find((b) => (b.textContent || "").trim() === "Environment");
  assert.ok(git, "Environment tab control must exist");
  await m.click(git as HTMLElement);
  await m.flush();
}

function makeFake(over: {
  sourceRow?: ThreadInfo;
  checkpoints?: CheckpointInfo[];
  fail?: Record<string, Error>;
} = {}) {
  const d = decoy();
  const s = over.sourceRow ?? source();
  const cps = over.checkpoints ?? threeCheckpoints();
  return createFakeCoder({
    projects: [project()],
    threads: [d, s],
    details: {
      "t-decoy": detail({ thread: d }),
      [s.id]: detail({ thread: s }),
    },
    checkpoints: { [s.id]: cps },
    fail: over.fail,
  });
}

describe("App checkpoints wiring (round 50)", () => {
  it("lists newest-first with turn, short sha, and age", async () => {
    const fake = makeFake();
    const m = await boot(fake);
    await selectThread(m, "checkpoint source thread");
    await openGitTab(m);

    assert.ok(m.query("[data-checkpoints]"), "Checkpoints section present");
    const rows = m.queryAll("[data-checkpoint]");
    assert.equal(rows.length, 3, "three checkpoints");
    // Newest-first: turn 3, then 2, then 1.
    assert.equal(rows[0]!.getAttribute("data-checkpoint-turn"), "3");
    assert.equal(rows[1]!.getAttribute("data-checkpoint-turn"), "2");
    assert.equal(rows[2]!.getAttribute("data-checkpoint-turn"), "1");
    assert.ok(
      (rows[0]!.textContent || "").includes("aaa1111"),
      "short sha of newest",
    );
    assert.ok(
      (rows[0]!.textContent || "").includes("Turn 3"),
      "turn label visible",
    );
    // Relative age from formatRelativeAge — recent → "1m" or "2m" for 60s.
    assert.ok(
      /[0-9]+m|now|h|d/.test(rows[0]!.textContent || ""),
      "relative age rendered",
    );
    assert.ok(
      fake.of("git.listCheckpoints").length >= 1,
      "listCheckpoints called on Git tab open",
    );
    m.unmount();
  });

  it("empty worktree shows No checkpoints yet; no worktree hides section", async () => {
    const d = decoy();
    const emptyWt = thread({
      id: "t-empty-wt",
      title: "empty worktree thread",
      worktreePath: "/tmp/wt/empty",
      updatedAt: NOW + 500,
    });
    const noWt = thread({
      id: "t-no-wt",
      title: "no worktree thread",
      worktreePath: null,
      updatedAt: NOW + 400,
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [d, emptyWt, noWt],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-empty-wt": detail({ thread: emptyWt }),
        "t-no-wt": detail({ thread: noWt }),
      },
      checkpoints: { "t-empty-wt": [] },
    });
    const m = await boot(fake);

    await selectThread(m, "empty worktree thread");
    await openGitTab(m);
    assert.ok(m.query("[data-checkpoints]"), "section when worktree exists");
    assert.ok(
      m.query("[data-checkpoints-empty]"),
      "empty state when list is empty",
    );
    assert.ok(
      (m.query("[data-checkpoints-empty]")!.textContent || "").includes(
        "No checkpoints yet",
      ),
    );

    await selectThread(m, "no worktree thread");
    // Git tab may remount or just re-render with new thread.
    await openGitTab(m);
    await m.flush();
    assert.equal(
      m.queryAll("[data-checkpoints]").length,
      0,
      "Checkpoints section hidden without worktree",
    );
    m.unmount();
  });

  it("confirm copy carries real turn+sha; Cancel records nothing; Confirm restores middle", async () => {
    const cps = threeCheckpoints();
    const middle = cps[1]!; // turn 2
    const fake = makeFake({ checkpoints: cps });
    const m = await boot(fake);
    await selectThread(m, "checkpoint source thread");
    await openGitTab(m);

    const restoreBtn = m.query(
      `[data-checkpoint-restore="${middle.sha}"]`,
    );
    assert.ok(restoreBtn, "Restore on middle checkpoint");
    await m.click(restoreBtn as HTMLElement);
    await m.flush();

    const dialog = m.query(`[data-restore-confirm="${middle.sha}"]`);
    assert.ok(dialog, "confirm dialog open");
    const copy = dialog!.textContent || "";
    assert.ok(copy.includes("turn 2") || copy.includes("Turn 2"));
    assert.ok(
      copy.includes(middle.sha.slice(0, 7)),
      `confirm names short sha, got: ${copy}`,
    );
    assert.ok(
      copy.includes("resets the worktree") &&
        copy.includes("main repository is not touched"),
      "destructive body present",
    );

    // Cancel path first — empty assertion is non-vacuous only if Confirm records.
    await m.click(m.query("[data-restore-confirm-cancel]") as HTMLElement);
    await m.flush();
    assert.equal(
      fake.of("git.restoreCheckpoint").length,
      0,
      "Cancel must not call restoreCheckpoint",
    );

    // Confirm path: restore MIDDLE.
    await m.click(
      m.query(`[data-checkpoint-restore="${middle.sha}"]`) as HTMLElement,
    );
    await m.flush();
    const listsBeforeConfirm = fake.of("git.listCheckpoints").length;
    await m.click(m.query("[data-restore-confirm-submit]") as HTMLElement);
    await m.flush();

    const restores = fake.of("git.restoreCheckpoint");
    assert.equal(restores.length, 1);
    assert.deepEqual(restores[0]!.args[0], {
      threadId: "t-cp-source",
      sha: middle.sha,
    });

    // B-R2: explicit post-restore refresh is load-bearing once App passes
    // stable useCoder callbacks (no re-render churn). Deleting
    // await refreshCheckpoints() after restore leaves the list stale.
    assert.ok(
      fake.of("git.listCheckpoints").length > listsBeforeConfirm,
      "successful restore must re-call listCheckpoints (explicit refresh)",
    );

    // Restore reopens the Git pane, which collapses the rail (#147).
    await expandAgents(m);

    // List refreshed: turn 3 (newer) gone; turn 2 + 1 remain.
    // This depends on fake truncating later checkpoints (reviewer mutant).
    const rows = m.queryAll("[data-checkpoint]");
    const turns = rows.map((r) => r.getAttribute("data-checkpoint-turn"));
    assert.deepEqual(
      turns,
      ["2", "1"],
      "restore middle must drop later checkpoints from the list",
    );
    assert.equal(
      m.queryAll(`[data-checkpoint="${cps[0]!.sha}"]`).length,
      0,
      "newest (turn 3) must be gone after restore of middle",
    );
    m.unmount();
  });

  it("restore failure surfaces error without crashing", async () => {
    const middle = threeCheckpoints()[1]!;
    const backendMsg = "Cannot restore a checkpoint while a run is active";
    const fake = makeFake({
      fail: {
        "git.restoreCheckpoint": new Error(backendMsg),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "checkpoint source thread");
    await openGitTab(m);

    await m.click(
      m.query(`[data-checkpoint-restore="${middle.sha}"]`) as HTMLElement,
    );
    await m.flush();
    await m.click(m.query("[data-restore-confirm-submit]") as HTMLElement);
    await m.flush();

    const err = m.query("[data-checkpoint-error]");
    assert.ok(err, "error surface after failed restore");
    assert.ok(
      (err!.textContent || "").includes(backendMsg),
      `error must show backend string, got: ${err!.textContent}`,
    );
    m.unmount();
  });

  it("working thread disables restore; click records nothing", async () => {
    const working = thread({
      id: "t-cp-source",
      title: "checkpoint source thread",
      status: "working",
      worktreePath: "/tmp/wt/checkpoint-source",
      branch: "feat/cp",
      updatedAt: NOW + 1000,
      runStartedAt: NOW,
    });
    const fake = makeFake({ sourceRow: working });
    const m = await boot(fake);
    await selectThread(m, "checkpoint source thread");
    await openGitTab(m);

    const btns = m.queryAll("[data-checkpoint-restore]");
    assert.ok(btns.length >= 1, "restore buttons still rendered");
    for (const b of btns) {
      assert.equal(
        (b as HTMLButtonElement).disabled,
        true,
        "restore disabled while working",
      );
      assert.equal(
        b.getAttribute("title"),
        "Cannot restore a checkpoint while a run is active",
      );
    }
    // Click despite disabled — synthetic click may still fire handlers if we
    // don't guard; our onClick returns early when disabled.
    await m.click(btns[0] as HTMLElement);
    await m.flush();
    assert.equal(
      fake.of("git.restoreCheckpoint").length,
      0,
      "working restore click must not hit the channel",
    );
    assert.equal(
      m.queryAll("[data-restore-confirm]").length,
      0,
      "confirm must not open while working",
    );
    m.unmount();
  });
});

describe("fakeCoder restore truncates later checkpoints", () => {
  it("list after restore of middle drops newer entries only", async () => {
    const cps = threeCheckpoints();
    const sourceRow = source();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [sourceRow],
      details: { "t-cp-source": detail({ thread: sourceRow }) },
      checkpoints: { "t-cp-source": cps },
    });
    const before = await fake.api.git.listCheckpoints({
      threadId: "t-cp-source",
    });
    assert.equal(before.length, 3);
    assert.equal(before[0]!.turn, 3);

    await fake.api.git.restoreCheckpoint({
      threadId: "t-cp-source",
      sha: cps[1]!.sha,
    });
    const after = await fake.api.git.listCheckpoints({
      threadId: "t-cp-source",
    });
    assert.deepEqual(
      after.map((c) => c.turn),
      [2, 1],
    );
    assert.equal(after[0]!.sha, cps[1]!.sha);
  });
});

describe("fakeCoder restoreCheckpoint error strings (byte-equal production)", () => {
  it("rejects working / no-worktree / unknown-sha with electron strings", async () => {
    const cps = threeCheckpoints();
    const withWt = source();
    const working = thread({
      ...withWt,
      id: "t-working",
      status: "working",
      worktreePath: "/tmp/wt/w",
    });
    const bare = thread({
      id: "t-bare",
      title: "bare",
      worktreePath: null,
      status: "idle",
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [withWt, working, bare],
      details: {
        "t-cp-source": detail({ thread: withWt }),
        "t-working": detail({ thread: working }),
        "t-bare": detail({ thread: bare }),
      },
      checkpoints: {
        "t-cp-source": cps,
        "t-working": cps,
      },
    });

    await assert.rejects(
      () =>
        fake.api.git.restoreCheckpoint({
          threadId: "t-working",
          sha: cps[0]!.sha,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Cannot restore a checkpoint while a run is active",
        );
        return true;
      },
    );

    await assert.rejects(
      () =>
        fake.api.git.restoreCheckpoint({
          threadId: "t-bare",
          sha: cps[0]!.sha,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Thread t-bare has no worktree; call setupWorktree first",
        );
        return true;
      },
    );

    const foreign = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await assert.rejects(
      () =>
        fake.api.git.restoreCheckpoint({
          threadId: "t-cp-source",
          sha: foreign,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, `Unknown checkpoint: ${foreign}`);
        return true;
      },
    );
  });
});

describe("App stable listCheckpoints wiring (round 50 rework B-R2)", () => {
  it("unrelated App re-render does not re-list checkpoints", async () => {
    const fake = makeFake();
    const m = await boot(fake);
    await selectThread(m, "checkpoint source thread");
    await openGitTab(m);
    const afterOpen = fake.of("git.listCheckpoints").length;
    assert.ok(afterOpen >= 1, "initial list on Git open");

    // Open settings — App state change re-renders with Git tab still mounted.
    // Inline lambdas for listCheckpoints would re-create refreshCheckpoints and
    // re-fetch; stable useCoder callbacks must not.
    const settingsBtn = m
      .queryAll("button")
      .find((b) => {
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        const text = (b.textContent || "").toLowerCase();
        return label.includes("settings") || text.includes("settings");
      });
    assert.ok(settingsBtn, "settings control must exist for re-render probe");
    await m.click(settingsBtn as HTMLElement);
    await m.flush();

    assert.equal(
      fake.of("git.listCheckpoints").length,
      afterOpen,
      "stable listCheckpoints prop must not re-fetch on unrelated re-render",
    );
    m.unmount();
  });
});
