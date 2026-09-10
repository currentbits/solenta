/**
 * Sidebar picker for importing a Kimi CLI session into the current project.
 *
 * Run: npm run test:renderer -- --test-name-pattern "Kimi session import"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom";
import { Sidebar } from "../src/components/Sidebar";
import type {
  CliSessionCandidate,
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};

const providers: ProviderInfo[] = [
  {
    id: "kimi",
    name: "Kimi",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const FRESH = Date.now();

const thread: ThreadInfo = {
  id: "t1",
  projectId: "p1",
  title: "existing",
  branch: null,
  prNumber: null,
  prUrl: null,
  status: "idle",
  createdAt: FRESH,
  updatedAt: FRESH,
  runStartedAt: null,
  archived: false,
  settledOverride: null,
  settledAt: null,
  pinnedAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastVisitedAt: FRESH,
  prState: null,
  provider: "claude",
  model: null,
  sessionId: null,
  permissionMode: "default",
  reasoningEffort: null,
  worktreePath: null,
  handoffFrom: null,
  lastError: null,
  lastErrorKind: null,
  tags: [],
};

const SESSION_A = "session_aaaa1111-2222-3333-4444-aaaaaaaaaaaa";
const SESSION_B = "session_bbbb2222-3333-4444-5555-bbbbbbbbbbbb";

const sessions: CliSessionCandidate[] = [
  { sessionId: SESSION_A, mtimeMs: FRESH },
  { sessionId: SESSION_B, mtimeMs: FRESH - 60_000 },
];

function sidebarProps(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return {
    appName: "Solenta",
    searchPlaceholder: "Search threads...",
    projectsHeader: "All projects",
    projects: [project],
    threads: [thread],
    providers,
    activeThreadId: null as string | null,
    onSelectThread: () => {},
    onCreateThread: () => {},
    onAddProject: () => {},
    searchThreads: async () => [],
    ...over,
  };
}

describe("Kimi session import picker", () => {
  it("lists sessions and imports the chosen one into the current project", async () => {
    const listed: unknown[] = [];
    const imported: unknown[] = [];
    const selected: string[] = [];
    const m = await mount(
      <Sidebar
        {...sidebarProps({
          onSelectThread: (id) => selected.push(id),
          listCliSessions: async (input) => {
            listed.push(input);
            return sessions;
          },
          importCliSession: async (input) => {
            imported.push(input);
            return {
              ...thread,
              id: "t-imported",
              provider: "kimi",
              sessionId: input.sessionId,
              title: "Imported Kimi session",
            };
          },
        })}
      />,
    );

    await m.click(m.query("[data-new-thread-caret]"));
    const openBtn = m.query("[data-import-kimi-session]");
    assert.ok(openBtn, "import item renders when list/import props are set");
    assert.match(openBtn!.textContent || "", /Import Kimi session/i);

    await m.click(openBtn);
    await m.flush();

    assert.equal(listed.length, 1, "opening the picker lists sessions once");
    assert.deepEqual(listed[0], { provider: "kimi" });
    const rowA = m.query(`[data-cli-session="${SESSION_A}"]`);
    const rowB = m.query(`[data-cli-session="${SESSION_B}"]`);
    assert.ok(rowA, "session A is listed");
    assert.ok(rowB, "session B is listed");

    await m.click(rowA);
    await m.flush();

    assert.equal(imported.length, 1);
    assert.deepEqual(imported[0], {
      sessionId: SESSION_A,
      projectId: "p1",
      provider: "kimi",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(imported[0] as object, "home"),
      false,
      "renderer must not send a home path",
    );
    assert.deepEqual(selected, ["t-imported"]);
    assert.equal(
      m.query("[data-import-cli-session-modal]"),
      null,
      "picker closes after a successful import",
    );

    m.unmount();
  });

  it("shows an empty state when no Kimi sessions exist", async () => {
    const m = await mount(
      <Sidebar
        {...sidebarProps({
          listCliSessions: async () => [],
          importCliSession: async () => thread,
        })}
      />,
    );
    await m.click(m.query("[data-new-thread-caret]"));
    await m.click(m.query("[data-import-kimi-session]"));
    await m.flush();
    const empty = m.query("[data-cli-session-empty]");
    assert.ok(empty, "empty copy renders");
    assert.match(empty!.textContent || "", /No Kimi CLI sessions/i);
    m.unmount();
  });

  it("shows a list error with Retry", async () => {
    let calls = 0;
    const m = await mount(
      <Sidebar
        {...sidebarProps({
          listCliSessions: async () => {
            calls += 1;
            if (calls === 1) throw new Error("KIMI_CODE_HOME missing");
            return sessions;
          },
          importCliSession: async () => thread,
        })}
      />,
    );
    await m.click(m.query("[data-new-thread-caret]"));
    await m.click(m.query("[data-import-kimi-session]"));
    await m.flush();
    const error = m.query("[data-cli-session-error]");
    assert.ok(error);
    assert.match(error!.textContent || "", /KIMI_CODE_HOME missing/);
    await m.click(m.query("[data-cli-session-retry]"));
    await m.flush();
    assert.ok(m.query(`[data-cli-session="${SESSION_A}"]`));
    m.unmount();
  });

  it("keeps the picker open when import fails", async () => {
    const m = await mount(
      <Sidebar
        {...sidebarProps({
          listCliSessions: async () => sessions,
          importCliSession: async () => {
            throw new Error("Kimi session not found");
          },
        })}
      />,
    );
    await m.click(m.query("[data-new-thread-caret]"));
    await m.click(m.query("[data-import-kimi-session]"));
    await m.flush();
    await m.click(m.query(`[data-cli-session="${SESSION_A}"]`));
    await m.flush();
    assert.ok(m.query("[data-import-cli-session-modal]"));
    const error = m.query("[data-cli-session-error]");
    assert.ok(error);
    assert.match(error!.textContent || "", /Kimi session not found/);
    m.unmount();
  });

  it("does not render the menu item when the optional props are omitted", async () => {
    const m = await mount(<Sidebar {...sidebarProps()} />);
    await m.click(m.query("[data-new-thread-caret]"));
    assert.equal(m.query("[data-import-kimi-session]"), null);
    assert.ok(m.query("[data-new-thread]"), "existing New thread button remains");
    m.unmount();
  });
});
