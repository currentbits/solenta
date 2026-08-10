/**
 * Archive undo toast (Synara-style, round 39).
 * Archive is immediate; toast offers Undo for ~6s.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom";
import {
  ArchiveToast,
  ARCHIVE_TOAST_MS,
} from "../src/components/ArchiveToast";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

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

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t-archive",
    projectId: "p1",
    title: "about to archive",
    branch: "coder/about-to-archive-xyz",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: FRESH,
    updatedAt: FRESH,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
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

function detail(t: ThreadInfo): ThreadDetail {
  return {
    thread: t,
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
  };
}

describe("ArchiveToast", () => {
  it("shows Archived + Undo and fires onUndo", async () => {
    let undone = false;
    let dismissed = false;
    const m = await mount(
      <ArchiveToast
        onUndo={() => {
          undone = true;
        }}
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
    // byText only matches button/a/label; "Archived" is a span.
    assert.ok(
      m.text().includes("Archived"),
      "toast must say Archived",
    );
    const undo = m.byText("Undo");
    assert.ok(undo, "Undo control must be present");
    await m.click(undo!);
    assert.equal(undone, true, "Undo must call onUndo");
    assert.equal(dismissed, false, "Undo alone does not dismiss via onDismiss");
    m.unmount();
  });

  it("auto-dismisses after ARCHIVE_TOAST_MS", async () => {
    let dismissed = false;
    const m = await mount(
      <ArchiveToast
        onUndo={() => {}}
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, ARCHIVE_TOAST_MS + 50));
    });
    assert.equal(dismissed, true, "toast must dismiss after the window");
    m.unmount();
  });
});

describe("ThreadView archive → toast flow (host wiring shape)", () => {
  /**
   * Mirrors App: archive is immediate, then toast; Undo calls setArchived(false, id).
   * Interesting thread id is not the default "t1" (fixture discipline).
   */
  it("archive action fires immediately and Undo restores", async () => {
    const calls: Array<{ archived: boolean; id?: string }> = [];

    function Host() {
      const [current, setCurrent] = React.useState(
        thread({ id: "t-mid-list", archived: false }),
      );
      const [toastId, setToastId] = React.useState<string | null>(null);
      return (
        <>
          {!current.archived && (
            <ThreadView
              detail={detail(current)}
              project={project}
              providers={providers}
              workflows={[]}
              hasProjects
              onAddProject={() => {}}
              onStartRun={() => {}}
              onStartWorkflow={() => {}}
              onSaveWorkflow={async (t) => t as never}
              onRemoveWorkflow={() => {}}
              onStopRun={() => {}}
              onSetPermissionMode={() => {}}
              onSetProvider={() => {}}
              onSetReasoningEffort={() => {}}
              onSetArchived={(archived) => {
                calls.push({ archived, id: current.id });
                if (archived) {
                  setToastId(current.id);
                  setCurrent((t) => ({ ...t, archived: true }));
                } else {
                  setToastId(null);
                  setCurrent((t) => ({ ...t, archived: false }));
                }
              }}
              onDeleteThread={() => {}}
              changesOpen={false}
              changesNonce={0}
              onCloseChanges={() => {}}
              onFetchDiff={async () => ({
                files: [],
                patch: "",
                truncated: false,
              })}
              onPush={async () => ({ remote: "origin", branch: "main" })}
            />
          )}
          {toastId && (
            <ArchiveToast
              onUndo={() => {
                calls.push({ archived: false, id: toastId });
                setCurrent((t) => ({ ...t, archived: false }));
                setToastId(null);
              }}
              onDismiss={() => {
                setToastId(null);
              }}
            />
          )}
        </>
      );
    }

    const m = await mount(<Host />);
    // Open the ··· menu and archive.
    const menuBtn = m
      .queryAll("button")
      .find((b) => b.getAttribute("aria-label") === "Thread actions");
    assert.ok(menuBtn, "thread overflow menu must exist");
    await m.click(menuBtn as HTMLElement);
    const archiveItem = m
      .queryAll("button")
      .find((b) => (b.textContent || "").includes("Archive thread"));
    assert.ok(archiveItem, "Archive thread menu item");
    await m.click(archiveItem as HTMLElement);

    assert.equal(calls[0]?.archived, true, "archive fires immediately");
    assert.ok(
      m.text().includes("Archived"),
      "toast appears after archive",
    );
    const undo = m.byText("Undo");
    assert.ok(undo, "Undo control on toast");
    await m.click(undo!);
    assert.ok(
      calls.some((c) => c.archived === false && c.id === "t-mid-list"),
      "Undo restores the archived thread by id",
    );
    m.unmount();
  });
});
