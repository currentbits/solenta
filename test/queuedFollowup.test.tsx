/**
 * Issue #92 queue-next-message, wired through the real App + useCoder.
 *
 * The composer used to be dead while a run was active. Now a follow-up typed
 * mid-run is held in useCoder and delivered on the run's terminal push — the
 * part a Composer-only test cannot see, since the queue lives above it.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { ThreadInfo } from "../src/shared/ipc";

const NOW = Date.now();

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

/** Decoy first so boot cannot select the target by accident. */
function decoy(): ThreadInfo {
  return thread({
    id: "t-decoy",
    title: "decoy first thread",
    status: "idle",
    updatedAt: NOW + 5000,
  });
}

function working(): ThreadInfo {
  return thread({
    id: "t-busy",
    title: "busy target thread",
    status: "working",
    runStartedAt: NOW,
    updatedAt: NOW + 1000,
  });
}

async function bootOnBusyThread() {
  const busy = working();
  const fake = createFakeCoder({
    projects: [project()],
    threads: [decoy(), busy],
    details: {
      "t-decoy": detail({ thread: decoy() }),
      "t-busy": detail({ thread: busy }),
    },
  });
  const m = await boot(fake);
  const card = m.query('button[aria-label="Select thread: busy target thread"]');
  assert.ok(card, "busy thread card must exist");
  await m.click(card);
  await m.flush();
  return { fake, m, busy };
}

/** Terminal push for the busy thread: the run landed. */
function landed(busy: ThreadInfo) {
  return detail({
    thread: { ...busy, status: "done", updatedAt: NOW + 9000 },
  });
}

describe("queued follow-up (issue #92)", () => {
  it("holds a mid-run send and delivers it when the run lands", async () => {
    const { fake, m, busy } = await bootOnBusyThread();

    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.equal(ta.disabled, false, "the prompt must accept type-ahead");
    await m.type(ta, "then update the changelog");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    assert.equal(
      fake.of("runs.start").length,
      0,
      "a second run must not start while the first is working",
    );
    assert.ok(
      m.text().includes("then update the changelog"),
      "the queued follow-up must be visible, not swallowed",
    );

    await inAct(() => fake.emitThread(landed(busy)));
    await m.flush();

    const started = fake.of("runs.start");
    assert.equal(started.length, 1, "the run terminal must deliver the queue");
    assert.deepEqual(
      started[0]!.args[0],
      {
        threadId: "t-busy",
        prompt: "then update the changelog",
        attachments: undefined,
      },
      "the queued prompt must go to the thread it was typed on",
    );

    // Delivered exactly once: a later push must not re-send it.
    await inAct(() => fake.emitThread(landed(busy)));
    await m.flush();
    assert.equal(
      fake.of("runs.start").length,
      1,
      "the queue must not re-fire on a later push",
    );
    m.unmount();
  });

  it("appends a second thought instead of dropping the first", async () => {
    const { fake, m, busy } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "first thought");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    await m.type(m.query("textarea"), "second thought");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    await inAct(() => fake.emitThread(landed(busy)));
    await m.flush();

    const started = fake.of("runs.start");
    assert.equal(started.length, 1, "both thoughts land as one run");
    assert.equal(
      (started[0]!.args[0] as { prompt: string }).prompt,
      "first thought\n\nsecond thought",
      "queueing twice must keep both, in order",
    );
    m.unmount();
  });

  it("cancels a queued follow-up so it never runs", async () => {
    const { fake, m, busy } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "never mind this one");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    const cancel = m.query("button[data-cancel-queued]");
    assert.ok(cancel, "a queued follow-up must be cancellable");
    await m.click(cancel);
    await m.flush();
    assert.equal(
      m.query("[data-queued-prompt]"),
      null,
      "cancelling must clear the queued strip",
    );

    await inAct(() => fake.emitThread(landed(busy)));
    await m.flush();
    assert.equal(
      fake.of("runs.start").length,
      0,
      "a cancelled follow-up must not run when the thread settles",
    );
    m.unmount();
  });
});
