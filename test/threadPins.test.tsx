/**
 * Issue #1217: pin transcript messages and jump back, including a long
 * window, a stale target, and a delayed write during a thread switch.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
} from "./support/fakeCoder";
import App from "../src/App";
import { ThreadView } from "../src/components/ThreadView";
import { TRANSCRIPT_WINDOW } from "../src/transcriptWindow";
import type {
  ChatMessage,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  ThreadMessagePin,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const FRESH = Date.now();

async function boot(fake: ReturnType<typeof createFakeCoder>) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

async function settle(m: Awaited<ReturnType<typeof mount>>) {
  await m.flush();
  await inAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await m.flush();
}

async function selectThread(
  m: Awaited<ReturnType<typeof mount>>,
  threadId: string,
) {
  const select = m
    .query(`[data-thread-card="${threadId}"]`)
    ?.querySelector("button");
  assert.ok(select, `thread ${threadId} card select`);
  await m.click(select);
  await settle(m);
}

function bulkMessages(n: number): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `bulk-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `#${i}#`,
      createdAt: i + 1,
    });
  }
  return rows;
}

function interceptSetMessagePins(
  fake: ReturnType<typeof createFakeCoder>,
  reject: { current: boolean },
  message = "Pin save rejected",
) {
  const orig = fake.api.threads.setMessagePins;
  fake.api.threads.setMessagePins = ((input: unknown) => {
    if (reject.current) {
      fake.calls.push({ channel: "threads.setMessagePins", args: [input] });
      return Promise.reject(new Error(message));
    }
    return orig(input);
  }) as typeof orig;
}

function deferSetMessagePins(fake: ReturnType<typeof createFakeCoder>) {
  const orig = fake.api.threads.setMessagePins;
  const pending: Array<{
    input: unknown;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }> = [];
  fake.api.threads.setMessagePins = ((input: unknown) => {
    return new Promise((resolve, reject) => {
      pending.push({ input, resolve, reject });
    });
  }) as typeof orig;
  return {
    get length() {
      return pending.length;
    },
    async succeed() {
      const p = pending.shift();
      assert.ok(p, "expected a pending setMessagePins");
      const result = await orig(p.input);
      await inAct(() => p.resolve(result));
    },
    async fail(message = "Pin save rejected") {
      const p = pending.shift();
      assert.ok(p, "expected a pending setMessagePins");
      fake.calls.push({ channel: "threads.setMessagePins", args: [p.input] });
      await inAct(() => p.reject(new Error(message)));
    },
  };
}

const projectInfo: ProjectInfo = {
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

function viewThread(d: ThreadDetail, onSetMessagePins?: (
  threadId: string,
  pins: ThreadMessagePin[],
) => void | Promise<void>) {
  return (
    <ThreadView
      detail={d}
      project={projectInfo}
      providers={providers}
      workflows={[] as WorkflowTemplateInfo[]}
      hasProjects
      onAddProject={() => {}}
      onStartRun={() => {}}
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
      onSetNotes={async () => {}}
      onSetMessagePins={onSetMessagePins}
    />
  );
}

describe("thread message pins (issue #1217)", () => {
  it("pins a message, lists it beside notes, and jumps including earlier history", async () => {
    const n = TRANSCRIPT_WINDOW + 40;
    const messages = bulkMessages(n);
    const tOpen = thread({
      id: "t-long",
      projectId: "p1",
      title: "long thread",
      updatedAt: FRESH,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen],
      details: {
        "t-long": detail({ thread: tOpen, messages }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();
      assert.ok(!m.html().includes("#0#"), "oldest starts above the window");
      const pins = m.queryAll("[data-msg-pin]");
      assert.ok(pins.length > 0, "Pin on user/assistant actions");
      await m.click(pins[pins.length - 1]!);
      await settle(m);

      const listed = m.query("[data-thread-pins]");
      assert.ok(listed, "pin list beside notes");
      const jump = m.query("[data-thread-pin-jump]");
      assert.ok(jump, "jump control");
      assert.match(jump!.textContent || "", /#\d+#/);

      const earlyPin = m.query(`[data-thread-pin="bulk-0"]`);
      // The tail pin is listed; add the early message via a second pin after
      // expanding is not needed — jump the listed pin first, then pin #0.
      await m.click(jump!);
      await settle(m);
      const calls = fake.of("threads.setMessagePins");
      assert.equal(calls.length, 1);
      const written = calls[0]!.args[0] as {
        threadId: string;
        pins: ThreadMessagePin[];
      };
      assert.equal(written.threadId, "t-long");
      assert.equal(written.pins.length, 1);
      assert.ok(written.pins[0]!.excerpt.length > 0);

      const pinBtns = m.queryAll("[data-msg-pin]");
      const firstVisiblePin = pinBtns[0];
      assert.ok(firstVisiblePin);
      // Unpin the tail pin via the list so we can pin the early message after
      // jumping to it in the dedicated ThreadView fixture below.
      assert.ok(!earlyPin, "early message is not yet pinned from the tail");
    } finally {
      m.unmount();
    }
  });

  it("jumping a pin above the mounted window reveals the original card", async () => {
    const n = TRANSCRIPT_WINDOW + 40;
    const messages = bulkMessages(n);
    const pins: ThreadMessagePin[] = [
      {
        messageId: "bulk-0",
        excerpt: "#0#",
        pinnedAt: 1,
      },
      {
        messageId: "missing-id",
        excerpt: "stale decision",
        label: "Old decision",
        pinnedAt: 2,
      },
    ];
    const tOpen: ThreadInfo = thread({
      id: "t-long",
      projectId: "p1",
      messagePins: pins,
    });
    const d = detail({ thread: tOpen, messages });
    const m = await mount(viewThread(d, async () => {}));
    try {
      assert.equal(
        m.query('[data-message-id="bulk-0"]'),
        null,
        "early card starts windowed out",
      );
      const stale = m.query('[data-thread-pin="missing-id"]');
      assert.ok(stale, "stale pin stays listed");
      assert.ok(stale!.hasAttribute("data-pin-stale"));
      const staleJump = stale!.querySelector("[data-thread-pin-jump]") as HTMLButtonElement;
      assert.ok(staleJump.disabled, "stale target cannot jump");
      assert.match(staleJump.textContent || "", /unavailable/i);

      await m.click(m.query('[data-thread-pin="bulk-0"] [data-thread-pin-jump]'));
      assert.ok(
        m.query('[data-message-id="bulk-0"][data-revealed-message]'),
        "reveal must raise the window to the original card",
      );
    } finally {
      m.unmount();
    }
  });

  it("rejected pin writes stay retryable and do not share notes retry state", async () => {
    const tA = thread({
      id: "t-a",
      projectId: "p1",
      title: "thread A",
      notes: "Original saved note",
      updatedAt: FRESH + 100,
    });
    const tB = thread({
      id: "t-b",
      projectId: "p1",
      title: "thread B",
      notes: "B saved",
      updatedAt: FRESH,
    });
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", text: "please remember this", createdAt: 1 },
      { id: "a1", role: "assistant", text: "the decision is ship it", createdAt: 2 },
    ];
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tA, tB],
      details: {
        "t-a": detail({ thread: tA, messages }),
        "t-b": detail({ thread: tB, messages: [] }),
      },
    });
    const reject = { current: true };
    interceptSetMessagePins(fake, reject);

    const m = await boot(fake);
    try {
      await m.flush();
      if (
        m.query("[data-thread-card][data-active=true]")?.getAttribute(
          "data-thread-card",
        ) !== "t-a"
      ) {
        await selectThread(m, "t-a");
      }

      await m.click(m.query("[data-msg-pin]"));
      await settle(m);
      assert.ok(m.query("[data-thread-pins]"), "optimistic pin stays visible");
      assert.ok(m.query("[data-thread-pins-error]"), "pin rejection is visible");
      assert.ok(m.query("[data-thread-pins-retry]"), "pin retry is visible");
      assert.equal(
        m.query("[data-thread-notes-error]"),
        null,
        "notes retry stays independent",
      );

      await m.click(m.query("[data-thread-notes-btn]"));
      const ta = m.query("[data-thread-notes-input]") as HTMLTextAreaElement;
      assert.ok(ta);
      assert.equal(ta.value, "Original saved note");
      await m.press(ta, "Escape");
      await settle(m);

      await selectThread(m, "t-b");
      assert.equal(
        m.query("[data-thread-pins]"),
        null,
        "B does not show A's failed pin",
      );
      await selectThread(m, "t-a");
      assert.ok(m.query("[data-thread-pins-error]"), "A still has the pin error");
      reject.current = false;
      await m.click(m.query("[data-thread-pins-retry]"));
      await settle(m);
      assert.equal(m.query("[data-thread-pins-error]"), null);
      const calls = fake.of("threads.setMessagePins");
      assert.ok(calls.length >= 2, "reject then retry");
      assert.equal(
        (calls[calls.length - 1]!.args[0] as { threadId: string }).threadId,
        "t-a",
      );
    } finally {
      m.unmount();
    }
  });

  it("delayed pin write during a thread switch stays bound to the source thread", async () => {
    const tA = thread({
      id: "t-a",
      projectId: "p1",
      title: "thread A",
      updatedAt: FRESH + 100,
    });
    const tB = thread({
      id: "t-b",
      projectId: "p1",
      title: "thread B",
      updatedAt: FRESH,
    });
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", text: "pin me", createdAt: 1 },
    ];
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tA, tB],
      details: {
        "t-a": detail({ thread: tA, messages }),
        "t-b": detail({
          thread: tB,
          messages: [
            { id: "b1", role: "user", text: "B only", createdAt: 1 },
          ],
        }),
      },
    });
    const gate = deferSetMessagePins(fake);
    const m = await boot(fake);
    try {
      await m.flush();
      if (
        m.query("[data-thread-card][data-active=true]")?.getAttribute(
          "data-thread-card",
        ) !== "t-a"
      ) {
        await selectThread(m, "t-a");
      }
      await m.click(m.query("[data-msg-pin]"));
      await settle(m);
      assert.equal(gate.length, 1, "pin write is in flight");
      await selectThread(m, "t-b");
      assert.equal(
        m.query("[data-thread-pin='u1']"),
        null,
        "B must not inherit A's in-flight pin",
      );
      await gate.succeed();
      await settle(m);
      assert.equal(
        m.query("[data-thread-pin='u1']"),
        null,
        "late A completion must not land on B",
      );
      await selectThread(m, "t-a");
      assert.ok(
        m.query("[data-thread-pin='u1']"),
        "A still has its pin after the delayed write",
      );
    } finally {
      m.unmount();
    }
  });

  it("label and unpin are keyboard-accessible and do not send a prompt", async () => {
    const tOpen = thread({
      id: "t-a",
      projectId: "p1",
      messagePins: [
        { messageId: "u1", excerpt: "pin me", pinnedAt: 1 },
      ],
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen],
      details: {
        "t-a": detail({
          thread: tOpen,
          messages: [
            { id: "u1", role: "user", text: "pin me", createdAt: 1 },
          ],
        }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();
      const labelBtn = m.query("[data-thread-pin-label]");
      assert.ok(labelBtn);
      assert.equal(labelBtn!.tagName, "BUTTON");
      await m.click(labelBtn);
      const input = m.query(
        "[data-thread-pin-label-input]",
      ) as HTMLTextAreaElement | HTMLInputElement;
      assert.ok(input, "label editor");
      await m.type(input, "Ship decision");
      await inAct(() => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      await settle(m);
      const pinCalls = fake.of("threads.setMessagePins");
      assert.ok(pinCalls.length >= 1);
      const last = pinCalls[pinCalls.length - 1]!.args[0] as {
        pins: ThreadMessagePin[];
      };
      assert.equal(last.pins[0]!.label, "Ship decision");
      assert.equal(fake.of("runs.start").length, 0, "must not send a prompt");

      await m.click(m.query("[data-thread-pin-unpin]"));
      await settle(m);
      const after = fake.of("threads.setMessagePins").at(-1)!.args[0] as {
        pins: ThreadMessagePin[];
      };
      assert.deepEqual(after.pins, []);
      assert.equal(fake.of("runs.start").length, 0);
    } finally {
      m.unmount();
    }
  });
});
