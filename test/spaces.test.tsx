/**
 * Spaces retired (#568): no sidebar chrome, no edit-project picker.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { Sidebar } from "../src/components/Sidebar";
import App from "../src/App";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  space,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const FRESH = Date.now();

function t(
  over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): ThreadInfo {
  const createdAt = over.createdAt ?? FRESH;
  const updatedAt = over.updatedAt ?? createdAt;
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt,
    updatedAt,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt:
      over.lastVisitedAt !== undefined ? over.lastVisitedAt : updatedAt,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

describe("Spaces retired (#568)", () => {
  it("sidebar has no add-space control or space headers", async () => {
    const m = await mount(
      <Sidebar
        appName="Solenta"
        searchPlaceholder="Search threads..."
        projectsHeader="All projects"
        projects={[
          project({ id: "p1", name: "ledger" }),
          project({ id: "p2", name: "notes" }),
        ]}
        threads={[
          t({ id: "t1", projectId: "p1", title: "one" }),
          t({ id: "t2", projectId: "p2", title: "two" }),
        ]}
        providers={providers}
        activeThreadId={null}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onAddProject={() => {}}
        searchThreads={async () => []}
      />,
    );
    assert.equal(m.query("[data-space-add]"), null);
    assert.equal(m.query("[data-space-header]"), null);
    assert.equal(m.query("[data-space-section]"), null);
    assert.equal(m.query("[data-group-chevron]"), null, "project groups are gone");
    assert.ok(m.query("[data-scope-trigger]"), "projects live in the scope dropdown");
    assert.ok(
      m.query('[data-thread-card="t1"] [data-card-slug]'),
      "cards carry their own project slug",
    );
    m.unmount();
  });

  it("edit project has no space select even when the store still lists spaces", async () => {
    const s1 = space({ id: "s1", name: "Client work" });
    const p1 = project({ id: "p1", name: "ledger", spaceId: "s1" });
    const t1 = thread({ id: "t1", projectId: "p1" });
    const fake = createFakeCoder({
      spaces: [s1],
      projects: [p1],
      threads: [t1],
      details: { t1: detail({ thread: t1 }) },
    });
    const m = await boot(fake);
    await m.click(m.query("[data-scope-trigger]"));
    await m.click(m.query('[data-scope-edit="p1"]'));
    assert.ok(m.query("[data-edit-project]"), "edit modal opens");
    assert.equal(
      m.query("[data-edit-project-space]"),
      null,
      "space picker is gone",
    );
    m.unmount();
  });
});
