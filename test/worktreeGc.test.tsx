/**
 * Worktree GC UI (#316): usage rows, batch cleanup, retention field.
 *
 * Run: node --import=./test/support/render.mjs --test test/worktreeGc.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { SettingsModal } from "../src/components/SettingsModal";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type {
  AppSettings,
  AppStatus,
  GcCandidate,
  GcCleanInput,
  GcCleanResult,
  GcScanResult,
  ProjectInfo,
} from "../src/shared/ipc";

const MB = 1024 * 1024;

function status(): AppStatus {
  return {
    spendTodayUsd: 0,
    memory: {
      running: false,
      adopted: false,
      port: null,
      entries: null,
      vectors: null,
      lastError: null,
    },
    build: { version: "0.1.0", sha: null, time: null },
  };
}

function candidate(over: Partial<GcCandidate> = {}): GcCandidate {
  return {
    path: "/tmp/wt/a",
    bytes: 5 * MB,
    reason: "orphan",
    threadId: null,
    title: null,
    projectId: "p1",
    branch: "solenta/a",
    ...over,
  };
}

function scanResult(over: Partial<GcScanResult> = {}): GcScanResult {
  return {
    candidates: [],
    usage: [],
    totalBytes: 0,
    ...over,
  };
}

interface GcStubs {
  scan?: GcScanResult;
  onScan?: () => Promise<GcScanResult>;
  onClean?: (input: GcCleanInput) => Promise<GcCleanResult>;
  projects?: ProjectInfo[];
}

function modal(stubs: GcStubs = {}) {
  const settings: AppSettings = {
    dailyBudgetUsd: null,
    autoSettleAfterDays: 3,
  };
  return (
    <SettingsModal
      open
      onClose={() => {}}
      settings={settings}
      status={status()}
      projects={
        stubs.projects ?? [
          project({ id: "p1", name: "ledger" }),
          project({ id: "p2", name: "inbox" }),
        ]
      }
      onGcScan={stubs.onScan ?? (async () => stubs.scan ?? scanResult())}
      onGcClean={
        stubs.onClean ??
        (async () => ({ removed: [], failed: [], bytes: 0 }))
      }
      onSaveSettings={async (patch) => ({
        dailyBudgetUsd: patch.dailyBudgetUsd ?? null,
        autoSettleAfterDays: patch.autoSettleAfterDays ?? 3,
      })}
    />
  );
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

describe("worktree GC usage", () => {
  it("renders one row per project with formatted sizes and a total", async () => {
    const m = await mount(
      modal({
        scan: scanResult({
          usage: [
            { projectId: "p1", worktrees: 3, bytes: 5 * MB },
            { projectId: "p2", worktrees: 1, bytes: 12 * MB },
          ],
          totalBytes: 17 * MB,
        }),
      }),
    );
    const t = m.text();
    assert.ok(m.query("[data-worktree-gc]"), "GC section must render");
    assert.ok(m.query('[data-gc-usage-row="p1"]'), "ledger row");
    assert.ok(m.query('[data-gc-usage-row="p2"]'), "inbox row");
    assert.ok(t.includes("ledger"), "project name");
    assert.ok(t.includes("worktrees 5.0 MB · 3"), "project rollup");
    assert.ok(t.includes("inbox"), "second project");
    assert.ok(t.includes("worktrees 12 MB · 1"), "second rollup");
    assert.ok(t.includes("Total 17 MB"), "total bytes");
    assert.equal(m.query("[data-gc-dialog]"), null, "cleanup dialog stays closed");
    m.unmount();
  });

  it("shows an empty state when the scan finds nothing", async () => {
    const m = await mount(modal({ scan: scanResult() }));
    assert.ok(m.query("[data-gc-empty]"), "empty state");
    assert.ok(m.text().includes("No worktrees on disk"));
    assert.equal(m.query("[data-gc-open]"), null, "no cleanup without candidates");
    m.unmount();
  });
});

describe("worktree GC batch cleanup", () => {
  const seed = scanResult({
    usage: [{ projectId: "p1", worktrees: 3, bytes: 10 * MB }],
    totalBytes: 10 * MB,
    candidates: [
      candidate({
        path: "/tmp/wt/orphan",
        title: null,
        reason: "orphan",
        bytes: 5 * MB,
        branch: "solenta/orphan",
      }),
      candidate({
        path: "/tmp/wt/old",
        title: "old settled thread",
        reason: "retention",
        bytes: 3 * MB,
        branch: "solenta/old",
      }),
      candidate({
        path: "/tmp/wt/dirty",
        title: "dirty worktree",
        reason: "orphan",
        bytes: 2 * MB,
        branch: "solenta/dirty",
        blocked: "uncommitted changes",
      }),
    ],
  });

  it("cannot select a blocked candidate", async () => {
    const m = await mount(modal({ scan: seed }));
    await m.click(m.query("[data-gc-open]"));
    const blocked = m.query(
      '[data-gc-candidate="/tmp/wt/dirty"]',
    ) as HTMLElement | null;
    assert.ok(blocked, "blocked row renders");
    const box = blocked.querySelector("input") as HTMLInputElement | null;
    assert.ok(box, "blocked checkbox");
    assert.equal(box.disabled, true, "blocked checkbox is disabled");
    assert.equal(box.checked, false, "blocked checkbox is not selected");
    assert.ok(
      m.text().includes("uncommitted changes"),
      "blocked reason is visible",
    );
    const confirm = m.query("[data-gc-confirm]") as HTMLButtonElement | null;
    assert.ok(confirm, "confirm button");
    assert.ok(
      (confirm.textContent || "").includes("Delete 2 worktrees (8.0 MB)"),
      `confirm labels the unblocked selection, got: ${confirm.textContent}`,
    );
    m.unmount();
  });

  it("confirms once with the selected paths", async () => {
    const cleans: GcCleanInput[] = [];
    const m = await mount(
      modal({
        scan: seed,
        onClean: async (input) => {
          cleans.push(input);
          return {
            removed: input.paths,
            failed: [],
            bytes: 8 * MB,
          };
        },
      }),
    );
    await m.click(m.query("[data-gc-open]"));
    await m.click(m.query("[data-gc-confirm]"));
    await m.flush();
    assert.equal(cleans.length, 1, "gcClean fires exactly once");
    assert.deepEqual(cleans[0]!.paths.slice().sort(), [
      "/tmp/wt/old",
      "/tmp/wt/orphan",
    ]);
    assert.ok(
      m.text().includes("Removed 2 worktrees (8.0 MB)"),
      `reclaimed report, got: ${m.text().slice(-160)}`,
    );
    m.unmount();
  });
});

describe("worktree GC unmerged candidates (#601)", () => {
  const seed = scanResult({
    usage: [{ projectId: "p1", worktrees: 2, bytes: 8 * MB }],
    totalBytes: 8 * MB,
    candidates: [
      candidate({
        path: "/tmp/wt/dead",
        title: "dead weight",
        reason: "retention",
        bytes: 5 * MB,
        branch: "solenta/dead",
      }),
      candidate({
        path: "/tmp/wt/unlanded",
        title: "worker nobody merged",
        reason: "retention",
        bytes: 3 * MB,
        branch: "solenta/unlanded",
        unmerged: 4,
      }),
    ],
  });

  it("never pre-selects an unmerged candidate but leaves it tickable", async () => {
    const m = await mount(modal({ scan: seed }));
    const open = m.query("[data-gc-open]") as HTMLButtonElement;
    assert.ok(
      (open.textContent || "").includes("Reclaim 5.0 MB"),
      `button offers only the clean bytes, got: ${open.textContent}`,
    );
    await m.click(open);

    const row = m.query(
      '[data-gc-candidate="/tmp/wt/unlanded"]',
    ) as HTMLElement | null;
    assert.ok(row, "unmerged row renders");
    const box = row.querySelector("input") as HTMLInputElement;
    assert.equal(box.disabled, false, "unmerged stays tickable by hand");
    assert.equal(box.checked, false, "unmerged is not pre-selected");
    assert.ok(m.query('[data-gc-unmerged="/tmp/wt/unlanded"]'), "warning row");
    assert.ok(
      m.text().includes("4 unmerged commits · branch kept"),
      `unmerged warning is visible, got: ${m.text().slice(-200)}`,
    );

    const confirm = m.query("[data-gc-confirm]") as HTMLButtonElement;
    assert.ok(
      (confirm.textContent || "").includes("Delete 1 worktree (5.0 MB)"),
      `confirm covers the clean candidate only, got: ${confirm.textContent}`,
    );
    m.unmount();
  });

  it("select all skips unmerged; ticking one by hand includes it", async () => {
    const cleans: GcCleanInput[] = [];
    const m = await mount(
      modal({
        scan: seed,
        onClean: async (input) => {
          cleans.push(input);
          return { removed: input.paths, failed: [], bytes: 8 * MB };
        },
      }),
    );
    await m.click(m.query("[data-gc-open]"));
    // Toggle off, then on: "select all" must still exclude the unmerged row.
    await m.click(m.query("[data-gc-select-all]"));
    await m.click(m.query("[data-gc-select-all]"));
    const row = m.query('[data-gc-candidate="/tmp/wt/unlanded"]') as HTMLElement;
    const box = row.querySelector("input") as HTMLInputElement;
    assert.equal(box.checked, false, "select all leaves unmerged alone");

    await m.click(box);
    await m.click(m.query("[data-gc-confirm]"));
    await m.flush();
    assert.equal(cleans.length, 1);
    assert.deepEqual(cleans[0]!.paths.slice().sort(), [
      "/tmp/wt/dead",
      "/tmp/wt/unlanded",
    ]);
    m.unmount();
  });
});

describe("worktree usage header (#559)", () => {
  it("renders the rollup in the sidebar without opening the GC dialog", async () => {
    const p1 = project({ id: "p1", name: "ledger", path: "/tmp/ledger" });
    const t1 = thread({
      id: "t1",
      projectId: "p1",
      worktreePath: "/tmp/wt/t1",
    });
    const t2 = thread({
      id: "t2",
      projectId: "p1",
      worktreePath: "/tmp/wt/t2",
    });
    const t3 = thread({ id: "t3", projectId: "p1" });
    const fake = createFakeCoder({
      projects: [p1],
      threads: [t1, t2, t3],
      details: {
        t1: detail({ thread: t1 }),
        t2: detail({ thread: t2 }),
        t3: detail({ thread: t3 }),
      },
      gcScan: scanResult({
        usage: [{ projectId: "p1", worktrees: 2, bytes: 5 * MB }],
        totalBytes: 5 * MB,
      }),
    });
    const m = await boot(fake);
    const usage = m.query("[data-worktree-usage]");
    assert.ok(usage, "sidebar must show a worktree usage line");
    assert.match(usage.textContent ?? "", /worktrees · 2/);
    assert.equal(m.query("[data-gc-dialog]"), null, "GC dialog is not open");
    assert.equal(
      m.query("[data-worktree-gc]"),
      null,
      "Settings GC section is not open yet",
    );

    await m.click(usage);
    await m.flush();
    assert.ok(
      m.query("[data-worktree-gc]"),
      "clicking the line opens Settings → Worktrees",
    );
    assert.equal(
      m.query("[data-gc-dialog]"),
      null,
      "cleanup dialog stays closed",
    );
    m.unmount();
  });
});

describe("worktree retention", () => {
  it("round-trips the retention input through projects.update", async () => {
    const p1 = project({ id: "p1", name: "ledger", path: "/tmp/ledger" });
    const t1 = thread({ id: "t1", projectId: "p1" });
    const fake = createFakeCoder({
      projects: [p1],
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const m = await boot(fake);

    await m.click(m.query("[data-scope-trigger]"));
    await m.click(m.query('[data-scope-edit="p1"]'));
    const input = m.query(
      "[data-edit-project-retention]",
    ) as HTMLInputElement | null;
    assert.ok(input, "retention input must exist");
    await m.type(input, "4");
    await m.click(m.query("[data-edit-project-submit]"));
    await m.flush();

    const calls = fake.of("projects.update");
    assert.equal(calls.length, 1, "submit records exactly one update");
    const patch = calls[0]!.args[0] as { worktreeRetention?: number };
    assert.equal(patch.worktreeRetention, 4);
    m.unmount();
  });
});
