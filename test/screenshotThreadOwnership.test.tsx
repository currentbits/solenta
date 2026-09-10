/**
 * Screenshot handoff must stay with the originating thread (#1206).
 *
 * Run: node --import=./test/support/render.mjs --test test/screenshotThreadOwnership.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { useState } from "react";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  AttachmentInfo,
  CoderApi,
  PreviewSnapshot,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

afterEach(unmountAll);

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

const workflows: WorkflowTemplateInfo[] = [];
const FRESH = Date.now();

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t-a",
    projectId: "p1",
    title: "thread A",
    branch: "coder/thread-a",
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
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    ...over,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: over.thread ?? thread(),
    messages: over.messages ?? [],
    workLog: over.workLog ?? [],
    workflow: over.workflow ?? null,
    usage: over.usage ?? null,
    pendingPermission: over.pendingPermission,
    artifacts: over.artifacts,
  };
}

const SNAP: PreviewSnapshot = {
  url: "http://localhost:5173/",
  title: "app",
  canGoBack: false,
  canGoForward: false,
};

const SHOT = { ...SNAP, dataUrl: "data:image/png;base64,aaa" };

function fakePreview(
  over: Partial<CoderApi["preview"]> = {},
): CoderApi["preview"] {
  return {
    bind: async () => ({
      url: "",
      title: "",
      canGoBack: false,
      canGoForward: false,
    }),
    unbind: async () => ({ ok: true }),
    navigate: async (input) => ({ ...SNAP, url: input.url }),
    reload: async () => SNAP,
    goBack: async () => SNAP,
    goForward: async () => SNAP,
    info: async () => SNAP,
    screenshot: async () => SHOT,
    click: async () => SNAP,
    type: async () => SNAP,
    ...over,
  };
}

function imageAtt(name: string): AttachmentInfo {
  return { kind: "image", path: `/tmp/${name}`, name };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function view(props: {
  detail?: ThreadDetail | null;
  preview?: CoderApi["preview"] | null;
  onSaveAttachmentImage?: (
    dataUrl: string,
  ) => Promise<AttachmentInfo | null>;
  onListSnapWindows?: () => Promise<Array<{ id: string; name: string }>>;
  onCaptureSnapWindow?: (sourceId: string) => Promise<AttachmentInfo | null>;
}) {
  return (
    <ThreadView
      detail={props.detail === undefined ? detail() : props.detail}
      project={project}
      providers={providers}
      workflows={workflows}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
      preview={props.preview}
      onSaveAttachmentImage={props.onSaveAttachmentImage}
      onListSnapWindows={props.onListSnapWindows}
      onCaptureSnapWindow={props.onCaptureSnapWindow}
    />
  );
}

async function openBrowser(m: Awaited<ReturnType<typeof mount>>) {
  await m.click(m.query("[data-views-btn]"));
  await m.click(m.query("[data-views-item='browser']"));
  await m.flush();
  assert.ok(m.query("[data-browser-pane]"), "Browser pane mounts");
}

async function bindAndLoad(m: Awaited<ReturnType<typeof mount>>) {
  const wv = m.query("webview") as HTMLElement | null;
  assert.ok(wv, "webview guest");
  (wv as unknown as { getWebContentsId: () => number }).getWebContentsId =
    () => 11;
  await inAct(() => {
    wv.dispatchEvent(new Event("did-attach"));
  });
  await m.flush();
  const input = m.query("[data-browser-url]") as HTMLInputElement;
  await m.type(input, "http://localhost:5173/");
  await m.click(m.query("[data-browser-go]"));
  await m.flush();
}

async function openAppSnap(m: Awaited<ReturnType<typeof mount>>) {
  await inAct(() => {
    for (const type of ["keydown", "keyup", "keydown", "keyup"] as const) {
      window.dispatchEvent(
        new KeyboardEvent(type, { key: "Alt", bubbles: true }),
      );
    }
  });
  await m.flush();
  assert.ok(m.query("[data-appsnap]"), "appsnap overlay open");
}

function chip(m: Awaited<ReturnType<typeof mount>>, name: string) {
  return m.query(`[aria-label="Remove ${name}"]`);
}

type Selected = "t-a" | "t-b" | null;

function Switcher(props: {
  preview?: CoderApi["preview"] | null;
  onSaveAttachmentImage?: (
    dataUrl: string,
  ) => Promise<AttachmentInfo | null>;
  onListSnapWindows?: () => Promise<Array<{ id: string; name: string }>>;
  onCaptureSnapWindow?: (sourceId: string) => Promise<AttachmentInfo | null>;
}) {
  const [selected, setSelected] = useState<Selected>("t-a");
  const current =
    selected == null
      ? null
      : detail({
          thread: thread({
            id: selected,
            title: selected === "t-a" ? "thread A" : "thread B",
          }),
        });
  return (
    <>
      <button type="button" data-go="t-a" onClick={() => setSelected("t-a")}>
        A
      </button>
      <button type="button" data-go="t-b" onClick={() => setSelected("t-b")}>
        B
      </button>
      <button
        type="button"
        data-go="loading"
        onClick={() => setSelected(null)}
      >
        loading
      </button>
      {view({
        detail: current,
        preview: props.preview,
        onSaveAttachmentImage: props.onSaveAttachmentImage,
        onListSnapWindows: props.onListSnapWindows,
        onCaptureSnapWindow: props.onCaptureSnapWindow,
      })}
    </>
  );
}

describe("ThreadView screenshot ownership (issue #1206)", () => {
  it("same-thread screenshot attaches once and keeps unsent text and chips", async () => {
    const saves: string[] = [];
    const preview = fakePreview();
    const m = await mount(
      view({
        preview,
        onSaveAttachmentImage: async () => {
          if (saves.length === 0) {
            saves.push("first");
            return imageAtt("keep.png");
          }
          saves.push("second");
          return imageAtt("A screenshot.png");
        },
      }),
    );
    await openBrowser(m);
    await bindAndLoad(m);
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "keep this draft");
    await m.click(m.query("[data-browser-screenshot]"));
    await m.flush();
    assert.ok(chip(m, "keep.png"), "first chip");
    await m.click(m.query("[data-browser-screenshot]"));
    await m.flush();
    assert.ok(chip(m, "keep.png"), "existing chip stays");
    assert.ok(chip(m, "A screenshot.png"), "new screenshot attaches once");
    assert.equal(
      m.queryAll('[data-attachment-kind="image"]').length,
      2,
      "two distinct chips, not a duplicate of one",
    );
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "keep this draft",
    );
    assert.deepEqual(saves, ["first", "second"]);
    m.unmount();
  });

  it("deferred capture across A → B cannot put A's image in B", async () => {
    const held = deferred<typeof SHOT>();
    let saved = 0;
    const m = await mount(
      <Switcher
        preview={fakePreview({
          screenshot: async () => held.promise,
        })}
        onSaveAttachmentImage={async () => {
          saved += 1;
          return imageAtt("A screenshot.png");
        }}
      />,
    );
    await openBrowser(m);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-screenshot]"));
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    await inAct(async () => {
      held.resolve(SHOT);
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(saved, 0, "parent save must not start for a stale capture");
    assert.equal(chip(m, "A screenshot.png"), null);
    m.unmount();
  });

  it("deferred save across A → B cannot put A's image in B", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      <Switcher
        preview={fakePreview()}
        onSaveAttachmentImage={async () => held.promise}
      />,
    );
    await openBrowser(m);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-screenshot]"));
    await m.flush();
    assert.equal(chip(m, "A screenshot.png"), null, "B has no chip yet");
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    assert.equal(
      chip(m, "A screenshot.png"),
      null,
      "B must not have the chip before the save resolves",
    );
    await inAct(async () => {
      held.resolve(imageAtt("A screenshot.png"));
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(
      chip(m, "A screenshot.png"),
      null,
      "A's screenshot must not land on B",
    );
    m.unmount();
  });

  it("deferred save across A → loading → B cannot put A's image in B", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      <Switcher
        preview={fakePreview()}
        onSaveAttachmentImage={async () => held.promise}
      />,
    );
    await openBrowser(m);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-screenshot]"));
    await m.click(m.query("[data-go='loading']"));
    await m.flush();
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    await inAct(async () => {
      held.resolve(imageAtt("A screenshot.png"));
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(chip(m, "A screenshot.png"), null);
    m.unmount();
  });

  it("A → B → A does not revive a cancelled screenshot", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      <Switcher
        preview={fakePreview()}
        onSaveAttachmentImage={async () => held.promise}
      />,
    );
    await openBrowser(m);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-screenshot]"));
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    await m.click(m.query("[data-go='t-a']"));
    await m.flush();
    await inAct(async () => {
      held.resolve(imageAtt("A screenshot.png"));
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(
      chip(m, "A screenshot.png"),
      null,
      "returning to A must not revive the cancelled capture",
    );
    m.unmount();
  });

  it("closing and reopening the Browser pane does not revive a cancelled save", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      view({
        preview: fakePreview(),
        onSaveAttachmentImage: async () => held.promise,
      }),
    );
    await openBrowser(m);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-screenshot]"));
    await m.click(m.query("[data-pane-type='browser'] [data-pane-close]"));
    await m.flush();
    assert.equal(m.query("[data-browser-pane]"), null);
    await openBrowser(m);
    await bindAndLoad(m);
    await inAct(async () => {
      held.resolve(imageAtt("A screenshot.png"));
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(chip(m, "A screenshot.png"), null);
    m.unmount();
  });

  it("save failure on the owning thread reports in the Browser pane and keeps the draft", async () => {
    const m = await mount(
      view({
        preview: fakePreview(),
        onSaveAttachmentImage: async () => {
          throw new Error("disk full");
        },
      }),
    );
    await openBrowser(m);
    await bindAndLoad(m);
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "keep this draft");
    await m.click(m.query("[data-browser-screenshot]"));
    await m.flush();
    const err = m.query("[data-browser-error]");
    assert.ok(err, "owning pane shows the save failure");
    assert.match(err!.textContent || "", /disk full/);
    assert.equal(chip(m, "A screenshot.png"), null);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "keep this draft",
    );
    m.unmount();
  });

  it("save failure after switching threads does not report on B", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      <Switcher
        preview={fakePreview()}
        onSaveAttachmentImage={async () => held.promise}
      />,
    );
    await openBrowser(m);
    await bindAndLoad(m);
    await m.click(m.query("[data-browser-screenshot]"));
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    await inAct(async () => {
      held.reject(new Error("disk full"));
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(m.query("[data-browser-error]"), null);
    assert.ok(!m.text().includes("disk full"));
    assert.equal(chip(m, "A screenshot.png"), null);
    m.unmount();
  });

  it("app-window capture across A → B cannot put A's image in B", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      <Switcher
        onListSnapWindows={async () => [{ id: "win-a", name: "Alpha" }]}
        onCaptureSnapWindow={async () => held.promise}
      />,
    );
    await openAppSnap(m);
    await m.click(m.query('[data-appsnap-window="win-a"]') as HTMLElement);
    await m.flush();
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    assert.equal(m.query("[data-appsnap]"), null, "dialog closes on switch");
    assert.equal(chip(m, "A screenshot.png"), null);
    await inAct(async () => {
      held.resolve(imageAtt("A screenshot.png"));
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(chip(m, "A screenshot.png"), null);
    assert.equal(m.query("[data-appsnap]"), null);
    m.unmount();
  });

  it("app-window capture A → B → A does not revive a cancelled snap", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      <Switcher
        onListSnapWindows={async () => [{ id: "win-a", name: "Alpha" }]}
        onCaptureSnapWindow={async () => held.promise}
      />,
    );
    await openAppSnap(m);
    await m.click(m.query('[data-appsnap-window="win-a"]') as HTMLElement);
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    await m.click(m.query("[data-go='t-a']"));
    await m.flush();
    await inAct(async () => {
      held.resolve(imageAtt("A screenshot.png"));
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(chip(m, "A screenshot.png"), null);
    m.unmount();
  });

  it("late app-window rejection after a switch leaves B intact", async () => {
    const held = deferred<AttachmentInfo | null>();
    const m = await mount(
      <Switcher
        onListSnapWindows={async () => [{ id: "win-a", name: "Alpha" }]}
        onCaptureSnapWindow={async () => held.promise}
      />,
    );
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "b draft later");
    await openAppSnap(m);
    await m.click(m.query('[data-appsnap-window="win-a"]') as HTMLElement);
    await m.click(m.query("[data-go='t-b']"));
    await m.flush();
    const bTa = m.query("textarea") as HTMLTextAreaElement | null;
    if (bTa) await m.type(bTa, "thread B text");
    await inAct(async () => {
      held.resolve(null);
      await Promise.resolve();
    });
    await m.flush();
    assert.equal(chip(m, "A screenshot.png"), null);
    assert.equal(m.query("[data-appsnap]"), null);
    assert.ok(!m.text().includes("Could not capture that window"));
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "thread B text",
    );
    m.unmount();
  });

  it("same-thread app-window capture attaches once", async () => {
    const m = await mount(
      view({
        onListSnapWindows: async () => [{ id: "win-a", name: "Alpha" }],
        onCaptureSnapWindow: async () => imageAtt("snap.png"),
      }),
    );
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "keep this draft");
    await openAppSnap(m);
    await m.click(m.query('[data-appsnap-window="win-a"]') as HTMLElement);
    await m.flush();
    assert.ok(chip(m, "snap.png"));
    assert.equal(m.query("[data-appsnap]"), null);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "keep this draft",
    );
    m.unmount();
  });
});
