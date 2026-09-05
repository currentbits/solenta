/**
 * Environment tab: persistent drag/keyboard reorder of tool sections.
 *
 * Run: node --import=./test/support/render.mjs --test test/envSectionReorder.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import { GitTab } from "../src/components/AgentsPanel";
import {
  ENV_ORDER_KEY,
  ENV_SECTION_IDS,
  getEnvSectionOrder,
  reloadEnvSectionOrder,
  resetEnvSectionOrder,
  setEnvSectionOrder,
} from "../src/envSectionOrder";
import type {
  GitPullResult,
  ProjectInfo,
  ThreadInfo,
} from "../src/shared/ipc";

const project = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
} as ProjectInfo;

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "ship it",
    branch: "coder/ship-it",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: 1,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    ...over,
  } as ThreadInfo;
}

function tab(over: {
  thread?: ThreadInfo | null;
  project?: ProjectInfo;
  onPull?: (id: string) => Promise<GitPullResult>;
  onOpenPrs?: () => void;
  onFork?: () => void;
} = {}) {
  return (
    <GitTab
      thread={over.thread === undefined ? thread() : over.thread}
      project={over.project ?? project}
      onViewChanges={() => {}}
      listCheckpoints={async () => []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
      gitPull={
        over.onPull ??
        (async () => ({ ok: true, summary: "Already up to date" }))
      }
      onOpenPrs={over.onOpenPrs}
      onFork={over.onFork}
    />
  );
}

function visibleSectionIds(container: Element): string[] {
  return [...container.querySelectorAll("[data-env-section]")]
    .filter((el) => {
      const body = el.querySelector("[data-env-body]");
      return Boolean(body && body.childElementCount > 0);
    })
    .map((el) => el.getAttribute("data-env-section") || "")
    .filter(Boolean);
}

afterEach(() => {
  resetEnvSectionOrder();
  try {
    window.localStorage?.removeItem(ENV_ORDER_KEY);
  } catch {
    // ignore
  }
  reloadEnvSectionOrder();
});

describe("Environment section reorder", () => {
  it("renders the default visible order and hides empty wrappers", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.deepEqual(visibleSectionIds(m.container), [
      "recap",
      "changes",
      "display",
      "pull",
      "devServer",
      "localServers",
      "editor",
      "checkpoints",
    ]);
    assert.equal(m.query('[data-env-section="scm"]'), null);
    assert.equal(m.query("[data-scm-card]"), null);
    assert.equal(m.query("[data-repo-card]"), null);
    assert.equal(m.query("[data-prs-card]"), null);
    assert.equal(m.query("[data-thread-fork-card]"), null);
    assert.equal(m.query("[data-verify-card]"), null);
    assert.equal(m.query("[data-remote-unavailable]"), null);
    const grip = m.query("[data-env-grip]");
    assert.ok(grip, "reorder handle");
    assert.equal(grip!.getAttribute("draggable"), "true");
    assert.equal(m.query("[data-pull-btn]")!.getAttribute("draggable"), null);
    assert.match(m.text(), /Drag to reorder/);
    m.unmount();
  });

  it("reorders DOM from a handle drop and keeps card state", async () => {
    const m = await mount(tab({}));
    await m.flush();
    const pullBtn = m.query("[data-pull-btn]");
    assert.ok(pullBtn);
    await m.click(pullBtn);
    assert.equal(
      (m.query("[data-pull-result]")?.textContent || "").trim(),
      "Already up to date",
    );

    const changesGrip = m.query(
      '[data-env-section="changes"] [data-env-grip]',
    );
    const recap = m.query('[data-env-section="recap"]');
    assert.ok(changesGrip && recap);

    await inAct(() => {
      changesGrip.dispatchEvent(
        new Event("dragstart", { bubbles: true, cancelable: true }),
      );
      recap.dispatchEvent(
        new Event("drop", { bubbles: true, cancelable: true }),
      );
    });

    assert.deepEqual(visibleSectionIds(m.container).slice(0, 3), [
      "changes",
      "recap",
      "display",
    ]);
    assert.equal(
      (m.query("[data-pull-result]")?.textContent || "").trim(),
      "Already up to date",
      "PullCard state survives the move",
    );
    assert.equal(getEnvSectionOrder()[0], "scm");
    assert.ok(getEnvSectionOrder().indexOf("changes") < getEnvSectionOrder().indexOf("recap"));
    m.unmount();
  });

  it("restores the saved order after remount", async () => {
    const next = [
      "display",
      ...ENV_SECTION_IDS.filter((id) => id !== "display"),
    ];
    setEnvSectionOrder(next);
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(visibleSectionIds(m.container)[0], "display");
    m.unmount();

    const m2 = await mount(tab({}));
    await m2.flush();
    assert.equal(visibleSectionIds(m2.container)[0], "display");
    assert.equal(
      window.localStorage.getItem(ENV_ORDER_KEY),
      JSON.stringify(next),
    );
    m2.unmount();
  });

  it("falls back when storage is malformed", async () => {
    window.localStorage.setItem(ENV_ORDER_KEY, "{not json");
    reloadEnvSectionOrder();
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(visibleSectionIds(m.container)[0], "recap");
    m.unmount();

    window.localStorage.setItem(ENV_ORDER_KEY, '{"display":0}');
    reloadEnvSectionOrder();
    const m2 = await mount(tab({}));
    await m2.flush();
    assert.equal(visibleSectionIds(m2.container)[0], "recap");
    m2.unmount();
  });

  it("keeps a hidden section's slot when neighboring tools move", async () => {
    setEnvSectionOrder([
      "scm",
      "display",
      "changes",
      ...ENV_SECTION_IDS.filter(
        (id) => id !== "scm" && id !== "display" && id !== "changes",
      ),
    ]);
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query('[data-env-section="scm"]'), null);
    assert.equal(visibleSectionIds(m.container)[0], "display");

    const displayGrip = m.query(
      '[data-env-section="display"] [data-env-grip]',
    );
    assert.ok(displayGrip);
    (displayGrip as HTMLElement).focus();
    await m.pressFocused("ArrowDown", { altKey: true });
    assert.deepEqual(visibleSectionIds(m.container).slice(0, 2), [
      "changes",
      "display",
    ]);
    assert.equal(getEnvSectionOrder()[0], "scm");
    m.unmount();
  });

  it("moves a focused handle with Alt+Arrow and announces it", async () => {
    const m = await mount(tab({}));
    await m.flush();
    const recapGrip = m.query('[data-env-section="recap"] [data-env-grip]');
    assert.ok(recapGrip);
    (recapGrip as HTMLElement).focus();
    await m.pressFocused("ArrowDown", { altKey: true });
    assert.deepEqual(visibleSectionIds(m.container).slice(0, 2), [
      "changes",
      "recap",
    ]);
    assert.match(m.query("[data-env-live]")?.textContent || "", /Recap moved down/);
    m.unmount();
  });

  it("ignores an external file/text drop", async () => {
    const m = await mount(tab({}));
    await m.flush();
    const before = visibleSectionIds(m.container);
    const recap = m.query('[data-env-section="recap"]');
    assert.ok(recap);
    await inAct(() => {
      recap.dispatchEvent(
        new Event("drop", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(visibleSectionIds(m.container), before);
    assert.ok(
      getEnvSectionOrder().every((id, i) => id === ENV_SECTION_IDS[i]),
    );
    m.unmount();
  });

  it("Reset order restores the default and keeps existing actions", async () => {
    setEnvSectionOrder([
      "display",
      ...ENV_SECTION_IDS.filter((id) => id !== "display"),
    ]);
    let opened = 0;
    const m = await mount(
      tab({
        onOpenPrs: () => {
          opened += 1;
        },
      }),
    );
    await m.flush();
    assert.equal(visibleSectionIds(m.container)[0], "display");
    const reset = m.query("[data-env-reset]") as HTMLButtonElement;
    assert.ok(reset);
    assert.equal(reset.disabled, false);
    await m.click(reset);
    assert.equal(visibleSectionIds(m.container)[0], "pullRequests");
    await m.click(m.query("[data-open-prs]"));
    assert.equal(opened, 1);
    await m.click(m.query("[data-pull-btn]"));
    assert.equal(
      (m.query("[data-pull-result]")?.textContent || "").trim(),
      "Already up to date",
    );
    m.unmount();
  });

  it("still hides remote-only tools on an SSH project", async () => {
    const remoteProject: ProjectInfo = {
      ...project,
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    };
    const m = await mount(tab({ project: remoteProject }));
    await m.flush();
    const ids = visibleSectionIds(m.container);
    assert.ok(ids.includes("remote"));
    assert.ok(ids.includes("changes"));
    assert.ok(!ids.includes("localServers"));
    assert.ok(!ids.includes("checkpoints"));
    assert.ok(!ids.includes("pull"));
    m.unmount();
  });
});
