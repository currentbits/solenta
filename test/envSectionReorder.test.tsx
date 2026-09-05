/**
 * Environment tab: persistent drag/keyboard reorder of tool sections.
 *
 * Run: node --import=./test/support/render.mjs --test test/envSectionReorder.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import { ENV_DRAG_MIME, GitTab } from "../src/components/AgentsPanel";
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
  GitRepoInfo,
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
  onRepoInfo?: (id: string) => Promise<GitRepoInfo>;
  repoInfo?: GitRepoInfo;
  onOpenPrs?: () => void;
  onFork?: () => void;
} = {}) {
  const repoInfo = over.repoInfo ?? ({ ok: false } as const);
  return (
    <GitTab
      thread={over.thread === undefined ? thread() : over.thread}
      project={over.project ?? project}
      onViewChanges={() => {}}
      listCheckpoints={async () => []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
      gitRepoInfo={over.onRepoInfo ?? (async () => repoInfo)}
      gitPull={
        over.onPull ??
        (async () => ({ ok: true, summary: "Already up to date" }))
      }
      onOpenPrs={over.onOpenPrs}
      onFork={over.onFork}
    />
  );
}

function emptyBody(container: Element, id: string): boolean {
  const section = container.querySelector(`[data-env-section="${id}"]`);
  const body = section?.querySelector("[data-env-body]");
  return Boolean(section && body && body.childElementCount === 0);
}

function dataTransfer(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  return {
    dropEffect: "none",
    effectAllowed: "all",
    files: [] as File[],
    items: [] as Array<{ kind: string }>,
    get types() {
      return Object.keys(data);
    },
    setData(type: string, value: string) {
      data[type] = value;
    },
    getData(type: string) {
      return data[type] ?? "";
    },
    clearData() {
      for (const key of Object.keys(data)) delete data[key];
    },
    setDragImage() {},
  };
}

function textTransfer(text: string) {
  return {
    dropEffect: "none",
    effectAllowed: "copy",
    files: [] as File[],
    items: [] as Array<{ kind: string }>,
    types: ["text/plain"],
    setData() {},
    getData(type: string) {
      return type === "text/plain" ? text : "";
    },
    clearData() {},
    setDragImage() {},
  };
}

function fileTransfer() {
  const file = new File(["hi"], "note.txt", { type: "text/plain" });
  return {
    dropEffect: "none",
    effectAllowed: "copy",
    files: [file],
    items: [{ kind: "file", type: "text/plain", getAsFile: () => file }],
    types: ["Files"],
    setData() {},
    getData() {
      return "";
    },
    clearData() {},
    setDragImage() {},
  };
}

function fireDrag(
  el: Element,
  type: string,
  dt: ReturnType<typeof dataTransfer> | ReturnType<typeof textTransfer> | ReturnType<typeof fileTransfer>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dt });
  el.dispatchEvent(event);
  return event;
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
    assert.equal(m.query("[data-scm-card]"), null);
    assert.ok(emptyBody(m.container, "scm"), "plain git still mounts ScmCard");
    assert.ok(
      emptyBody(m.container, "repository"),
      "no-origin RepositoryCard still mounts",
    );
    assert.equal(m.query("[data-repo-card]"), null);
    assert.ok(!visibleSectionIds(m.container).includes("scm"));
    assert.ok(!visibleSectionIds(m.container).includes("repository"));
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
    const dt = dataTransfer();

    await inAct(() => {
      fireDrag(changesGrip, "dragstart", dt);
      const over = fireDrag(recap, "dragover", dt);
      assert.equal(over.defaultPrevented, true, "env dragover is accepted");
      fireDrag(recap, "drop", dt);
      fireDrag(changesGrip, "dragend", dt);
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

  it("still fetches repo info when the card renders null", async () => {
    const seen: string[] = [];
    const m = await mount(
      tab({
        onRepoInfo: async (id) => {
          seen.push(id);
          return { ok: false };
        },
      }),
    );
    await m.flush();
    assert.deepEqual(seen, ["t1"]);
    assert.equal(m.query("[data-repo-card]"), null);
    assert.ok(m.query('[data-env-section="repository"]'));
    assert.ok(emptyBody(m.container, "repository"));
    m.unmount();
  });

  it("shows Repository once origin resolves, and skips it while empty", async () => {
    const m = await mount(
      tab({
        repoInfo: {
          ok: true,
          owner: "acme",
          repo: "widgets",
          webUrl: "https://github.com/acme/widgets",
        },
      }),
    );
    await m.flush();
    assert.ok(m.query("[data-repo-card]"));
    assert.ok(visibleSectionIds(m.container).includes("repository"));
    m.unmount();
  });

  it("keyboard moves skip empty wrappers between filled sections", async () => {
    setEnvSectionOrder([
      "recap",
      "scm",
      "repository",
      "changes",
      ...ENV_SECTION_IDS.filter(
        (id) =>
          id !== "recap" &&
          id !== "scm" &&
          id !== "repository" &&
          id !== "changes",
      ),
    ]);
    const m = await mount(tab({}));
    await m.flush();
    assert.ok(emptyBody(m.container, "scm"));
    assert.ok(emptyBody(m.container, "repository"));
    const recapGrip = m.query('[data-env-section="recap"] [data-env-grip]');
    assert.ok(recapGrip);
    (recapGrip as HTMLElement).focus();
    await m.pressFocused("ArrowDown", { altKey: true });
    assert.deepEqual(visibleSectionIds(m.container).slice(0, 2), [
      "changes",
      "recap",
    ]);
    assert.ok(
      getEnvSectionOrder().indexOf("scm") <
        getEnvSectionOrder().indexOf("changes"),
    );
    assert.ok(
      getEnvSectionOrder().indexOf("repository") <
        getEnvSectionOrder().indexOf("changes"),
    );
    m.unmount();
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
    assert.ok(emptyBody(m.container, "scm"));
    assert.ok(!visibleSectionIds(m.container).includes("scm"));
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

  it("clears the gesture on a same-section drop", async () => {
    const m = await mount(tab({}));
    await m.flush();
    const recap = m.query('[data-env-section="recap"]');
    const grip = m.query('[data-env-section="recap"] [data-env-grip]');
    assert.ok(recap && grip);
    const dt = dataTransfer();
    await inAct(() => {
      fireDrag(grip, "dragstart", dt);
    });
    await m.flush();
    assert.equal(recap.getAttribute("data-dragging"), "true");
    await inAct(() => {
      fireDrag(recap, "drop", dt);
      fireDrag(grip, "dragend", dt);
    });
    await m.flush();
    assert.equal(recap.getAttribute("data-dragging"), null);
    assert.deepEqual(visibleSectionIds(m.container)[0], "recap");
    m.unmount();
  });

  it("ignores an external file/text drop", async () => {
    const m = await mount(tab({}));
    await m.flush();
    const before = visibleSectionIds(m.container);
    const recap = m.query('[data-env-section="recap"]');
    assert.ok(recap);
    const textDrop = fireDrag(recap, "drop", textTransfer("hello"));
    const fileOver = fireDrag(recap, "dragover", fileTransfer());
    const fileDrop = fireDrag(recap, "drop", fileTransfer());
    assert.equal(textDrop.defaultPrevented, false);
    assert.equal(fileOver.defaultPrevented, false);
    assert.equal(fileDrop.defaultPrevented, false);
    assert.deepEqual(visibleSectionIds(m.container), before);
    assert.ok(
      getEnvSectionOrder().every((id, i) => id === ENV_SECTION_IDS[i]),
    );
    m.unmount();
  });

  it("canceled drag unmount does not steal a later external drop", async () => {
    const m = await mount(tab({}));
    await m.flush();
    const grip = m.query('[data-env-section="changes"] [data-env-grip]');
    assert.ok(grip);
    const dt = dataTransfer();
    await inAct(() => {
      fireDrag(grip, "dragstart", dt);
    });
    assert.equal(dt.getData(ENV_DRAG_MIME), "changes");
    m.unmount();

    const m2 = await mount(tab({}));
    await m2.flush();
    const before = visibleSectionIds(m2.container);
    const recap = m2.query('[data-env-section="recap"]');
    assert.ok(recap);
    const textOver = fireDrag(recap, "dragover", textTransfer("hello"));
    const textDrop = fireDrag(recap, "drop", textTransfer("hello"));
    const filesDrop = fireDrag(recap, "drop", fileTransfer());
    assert.equal(textOver.defaultPrevented, false);
    assert.equal(textDrop.defaultPrevented, false);
    assert.equal(filesDrop.defaultPrevented, false);
    assert.deepEqual(visibleSectionIds(m2.container), before);
    assert.ok(
      getEnvSectionOrder().every((id, i) => id === ENV_SECTION_IDS[i]),
    );
    m2.unmount();
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
