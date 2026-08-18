/**
 * Vibe Kanban import Settings section (#399).
 *
 * Run: node --import=./test/support/render.mjs --test test/vibeKanbanSection.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { VibeKanbanSection } from "../src/components/VibeKanbanSection";
import { SettingsModal } from "../src/components/SettingsModal";
import {
  createFakeCoder,
  installFakeCoder,
} from "./support/fakeCoder.ts";
import type {
  AppSettings,
  AppStatus,
  VibeKanbanImportResult,
  VibeKanbanPreview,
} from "../src/shared/ipc";

afterEach(unmountAll);

function preview(over: Partial<VibeKanbanPreview> = {}): VibeKanbanPreview {
  return {
    found: true,
    dataDir: "/tmp/ai.bloop.vibe-kanban",
    dbPath: "/tmp/ai.bloop.vibe-kanban/db.v2.sqlite",
    projects: [
      {
        name: "demo-app",
        path: "/tmp/demo-app",
        exists: true,
        taskCount: 2,
        worktreeCount: 1,
      },
    ],
    taskCount: 2,
    worktreeCount: 1,
    alreadyImported: 0,
    ...over,
  };
}

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

async function mountWithCoder(fake: ReturnType<typeof createFakeCoder>) {
  // jsdom (and window.coder) only exist after the first mount.
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
}

describe("VibeKanbanSection", () => {
  it("shows a found preview and imports on click", async () => {
    const fake = createFakeCoder();
    const imported: VibeKanbanImportResult = {
      dataDir: "/tmp/ai.bloop.vibe-kanban",
      dbPath: "/tmp/ai.bloop.vibe-kanban/db.v2.sqlite",
      projectsAdded: 1,
      projectsReused: 0,
      threadsCreated: 2,
      threadsSkipped: 0,
      worktreesMapped: 1,
      skipped: [],
    };
    fake.api.vibeKanban.preview = async () => preview();
    fake.api.vibeKanban.import = async () => imported;
    await mountWithCoder(fake);

    const m = await mount(<VibeKanbanSection active />);
    await m.flush();
    const found = m.query("[data-vk-preview]");
    assert.ok(found, "preview must render");
    assert.match(found.textContent || "", /2 cards/);
    assert.match(m.text(), /demo-app/);

    await m.click(m.query("[data-vk-import]"));
    await m.flush();
    const report = m.query("[data-vk-report]");
    assert.ok(report, "import report must render");
    assert.match(report.textContent || "", /2 threads/);
    m.unmount();
  });

  it("disables import when nothing is found", async () => {
    const fake = createFakeCoder();
    fake.api.vibeKanban.preview = async () =>
      preview({
        found: false,
        dbPath: null,
        projects: [],
        taskCount: 0,
        worktreeCount: 0,
      });
    await mountWithCoder(fake);
    const m = await mount(<VibeKanbanSection active />);
    await m.flush();
    assert.ok(m.query("[data-vk-missing]"));
    assert.equal(
      (m.query("[data-vk-import]") as HTMLButtonElement).disabled,
      true,
    );
    m.unmount();
  });

  it("exports JSON and reports the path", async () => {
    const fake = createFakeCoder();
    fake.api.vibeKanban.preview = async () =>
      preview({ found: false, projects: [] });
    fake.api.vibeKanban.export = async () => "/tmp/solenta-export.json";
    await mountWithCoder(fake);
    const m = await mount(<VibeKanbanSection active />);
    await m.flush();
    await m.click(m.query("[data-vk-export]"));
    await m.flush();
    assert.match(
      m.query("[data-vk-report]")?.textContent || "",
      /solenta-export\.json/,
    );
    m.unmount();
  });
});

describe("SettingsModal hosts the import section", () => {
  it("renders the Your data section", async () => {
    const settings: AppSettings = {
      dailyBudgetUsd: null,
      autoSettleAfterDays: 3,
    };
    const m = await mount(
      <SettingsModal
        open
        onClose={() => {}}
        settings={settings}
        status={status()}
        onSaveSettings={async (p) => ({
          dailyBudgetUsd: p.dailyBudgetUsd ?? null,
          autoSettleAfterDays: p.autoSettleAfterDays ?? 3,
        })}
      />,
    );
    assert.ok(m.query("[data-vibe-kanban]"));
    m.unmount();
  });
});
