/**
 * Issue #1781: Duplicate a thread from the sidebar "…" menu. Same
 * project/provider/model/mode/worktree-or-not as the source, titled
 * "<title> (copy)", no transcript carried, started on the source's first
 * user message and its attachments. Selects the new thread.
 *
 * Mounts the real App (not a Host injecting handlers), same discipline as
 * forkHandoff.test.tsx: source thread not index 0, a decoy thread present.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { AttachmentInfo, ChatMessage, ProviderInfo, ThreadInfo } from "../src/shared/ipc";
import { expandAgents } from "./support/expandAgents.ts";

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
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<App />);
  await expandAgents(m);
  return m;
}

function decoy(): ThreadInfo {
  return thread({ id: "t-decoy", projectId: "p1", title: "decoy thread", provider: "claude" });
}

const ATTACHMENT: AttachmentInfo = {
  kind: "image",
  path: "/tmp/attachments/t-source/shot.png",
  name: "shot.png",
};

function sourceMessages(): ChatMessage[] {
  return [
    {
      id: "u1",
      role: "user",
      text: "please fix the flaky test",
      attachments: [ATTACHMENT],
      createdAt: 1,
    },
    { id: "a1", role: "assistant", text: "done, it was a race", createdAt: 2 },
  ];
}

function source(): ThreadInfo {
  return thread({
    id: "t-source",
    projectId: "p1",
    title: "Fix the thing",
    provider: "grok",
    model: "grok-m",
    permissionMode: "acceptEdits",
    worktreePath: "/tmp/wt/t-source",
  });
}

/** #566: card actions live in the single "…" menu. */
async function openCardMenu(m: Awaited<ReturnType<typeof mount>>, threadId: string) {
  const more = m.query(`[data-more-btn="${threadId}"]`);
  assert.ok(more, `"…" menu button must exist on ${threadId}`);
  await m.click(more as HTMLElement);
  await m.flush();
  const menu = document.querySelector("[data-context-menu]");
  assert.ok(menu, "card menu must be open");
  return menu as HTMLElement;
}

describe("Duplicate thread (#1781)", () => {
  it("duplicate carries settings and worktree choice, no transcript, and starts on the first prompt", async () => {
    const d = decoy();
    const s = source();
    const fake = createFakeCoder({
      projects: [project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" })],
      providers,
      threads: [d, s],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source": detail({ thread: s, messages: sourceMessages() }),
      },
    });
    const m = await boot(fake);

    const menu = await openCardMenu(m, "t-source");
    const dupBtn = menu.querySelector('[data-duplicate-btn="t-source"]');
    assert.ok(dupBtn, "Duplicate item must exist on the source card");
    await m.click(dupBtn as HTMLElement);
    await m.flush();

    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1, "exactly one threads.fork");
    const forkArg = forks[0]!.args[0] as {
      threadId: string;
      title?: string;
      worktree?: boolean;
      messageId?: string;
    };
    assert.equal(forkArg.threadId, "t-source");
    assert.equal(forkArg.title, "Fix the thing (copy)");
    assert.equal(forkArg.worktree, true, "source had a worktree, so must the duplicate");
    assert.equal(
      Object.prototype.hasOwnProperty.call(forkArg, "messageId"),
      false,
      "no messageId cut: the duplicate must start with an empty transcript",
    );

    const starts = fake.of("runs.start");
    assert.equal(starts.length, 1, "exactly one runs.start, for the new thread");
    const startArg = starts[0]!.args[0] as {
      threadId?: string;
      prompt?: string;
      attachments?: AttachmentInfo[];
    };
    assert.notEqual(startArg.threadId, "t-source", "must start the duplicate, not the source");
    assert.equal(startArg.prompt, "please fix the flaky test");
    assert.deepEqual(startArg.attachments, [ATTACHMENT]);

    // Selection moved to the duplicate; its title is visible; the source's
    // prior assistant reply is nowhere (no transcript carried).
    assert.ok(m.text().includes("Fix the thing (copy)"), "duplicate title must be visible");
    assert.ok(
      !m.text().includes("done, it was a race"),
      "the source's transcript must not appear on the duplicate",
    );
    const active = m.query('[data-active="true"]');
    assert.ok(active, "some card is active after duplicating");
    assert.notEqual(
      active!.getAttribute("data-thread-card"),
      "t-source",
      "selection must leave the source",
    );
    m.unmount();
  });

  it("does not request a worktree when the source has none", async () => {
    const d = decoy();
    const s = thread({ id: "t-plain", projectId: "p1", title: "Plain thread", provider: "claude" });
    const fake = createFakeCoder({
      projects: [project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" })],
      providers,
      threads: [d, s],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-plain": detail({ thread: s, messages: sourceMessages() }),
      },
    });
    const m = await boot(fake);

    const menu = await openCardMenu(m, "t-plain");
    const dupBtn = menu.querySelector('[data-duplicate-btn="t-plain"]');
    await m.click(dupBtn as HTMLElement);
    await m.flush();

    const forkArg = fake.of("threads.fork")[0]!.args[0] as { worktree?: boolean };
    assert.equal(forkArg.worktree, false, "a plain source must not get a worktree opt-in");
    m.unmount();
  });
});
