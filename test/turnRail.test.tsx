/**
 * Issue #487: jump-to-turn rail. One tick per user prompt, hidden on short
 * threads; a tick click mounts the prompt and scrolls it to the top; `/jump`
 * opens the outline filtered by its tail instead of sending.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom";
import { detail, thread } from "./support/fakeCoder";
import { ThreadView } from "../src/components/ThreadView";
import { RAIL_MIN_TURNS, turnLabel } from "../src/components/thread/TurnRail";
import { parseJumpCommand } from "../src/slashCommands";
import { TRANSCRIPT_WINDOW } from "../src/transcriptWindow";
import type {
  ChatMessage,
  ProviderInfo,
  ThreadDetail,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

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

/** n user/assistant pairs; prompt 0 is the auth one. */
function pairs(n: number): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      {
        id: `u${i}`,
        role: "user",
        text: i === 0 ? "Rewrite auth middleware\nmore detail" : `Step ${i}`,
        createdAt: 2 * i + 1,
      },
      { id: `a${i}`, role: "assistant", text: `done ${i}`, createdAt: 2 * i + 2 },
    );
  }
  return rows;
}

function view(d: ThreadDetail, onStartRun: (prompt: string) => void = () => {}) {
  return (
    <ThreadView
      detail={d}
      project={{ id: "p1", slug: "owner/repo", name: "repo", path: "/tmp/repo" }}
      providers={providers}
      workflows={[] as WorkflowTemplateInfo[]}
      hasProjects
      onAddProject={() => {}}
      onStartRun={onStartRun}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () =>
        ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo
      }
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
      onRevertFile={async (filePath) => ({ path: filePath })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />
  );
}

describe("jump-to-turn rail (issue #487)", () => {
  it("labels a prompt by its first line, past a quoted reply", () => {
    assert.equal(turnLabel("Rewrite auth\nwhy"), "Rewrite auth");
    assert.equal(
      turnLabel('<reply-context message="m">\nquoted\n</reply-context>\n\nFix it'),
      "Fix it",
    );
    assert.equal(turnLabel("   "), "Untitled prompt");
    assert.equal(parseJumpCommand("/jump  auth "), "auth");
    assert.equal(parseJumpCommand("/jump"), "");
    assert.equal(parseJumpCommand("/jumpy"), null);
  });

  it("stays hidden on a short thread", async () => {
    const t = thread({ id: "t-short", projectId: "p1" });
    const m = await mount(
      view(detail({ thread: t, messages: pairs(RAIL_MIN_TURNS - 1) })),
    );
    try {
      assert.equal(m.query("[data-turn-rail]"), null);
    } finally {
      m.unmount();
    }
  });

  it("click on a windowed-out tick mounts the prompt and scrolls it to the top", async () => {
    const n = TRANSCRIPT_WINDOW;
    const t = thread({ id: "t-long", projectId: "p1" });
    const m = await mount(view(detail({ thread: t, messages: pairs(n) })));
    try {
      assert.equal(m.queryAll("[data-turn-tick]").length, n, "one tick per prompt");
      assert.equal(m.query('[data-message-id="u0"]'), null, "u0 starts windowed out");
      const tick = m.query('[data-turn-tick="u0"]');
      assert.equal(tick?.getAttribute("aria-label"), "Prompt 1");
      assert.ok(!m.html().includes("Rewrite auth"), "collapsed: no labels");
      await m.hover(m.query("[data-turn-rail]"));
      assert.equal(tick?.textContent, "Rewrite auth middleware");

      const body = m.query("[data-thread-body]") as HTMLElement;
      let scrollTop = 5000;
      Object.defineProperty(body, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = v;
        },
      });
      await m.click(tick);
      // Not data-revealed-message: the flash clears after 1.6s, and a loaded
      // runner can spend longer than that inside one click flush.
      assert.ok(m.query('[data-message-id="u0"]'), "prompt mounted");
      // jsdom rects are all 0, so the target sits at the current scrollTop;
      // top alignment leaves the 8px breathing room above it.
      assert.equal(scrollTop, 4992);
    } finally {
      m.unmount();
    }
  });

  it("/jump with a prefix opens a filtered outline and never sends", async () => {
    const sent: string[] = [];
    const t = thread({ id: "t-jump", projectId: "p1" });
    const m = await mount(
      view(detail({ thread: t, messages: pairs(3) }), (p) => sent.push(p)),
    );
    try {
      assert.equal(m.query("[data-turn-rail]"), null, "short thread: no rail");
      const ta = m.query("textarea") as HTMLTextAreaElement;
      await m.type(ta, "/jump auth");
      await m.press(ta, "Enter", { metaKey: true });
      assert.deepEqual(sent, []);
      assert.equal(ta.value, "");
      const filter = m.query("[data-turn-filter]") as HTMLInputElement;
      assert.equal(filter.value, "auth");
      assert.deepEqual(
        m.queryAll("[data-turn-tick]").map((el) => el.getAttribute("data-turn-tick")),
        ["u0"],
      );
      await m.press(filter, "Enter");
      assert.equal(m.query("[data-turn-filter]"), null, "jump closes the outline");
    } finally {
      m.unmount();
    }
  });
});
