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
  const card = m.query('button[aria-label^="Select thread: busy target thread"]');
  assert.ok(card, "busy thread card must exist");
  await m.click(card);
  await m.flush();
  return { fake, m, busy };
}

/** Terminal push for the busy thread: the run landed. */
function landed(busy: ThreadInfo, queued: ThreadInfo["queued"] = null) {
  return detail({
    thread: { ...busy, status: "done", queued, updatedAt: NOW + 9000 },
  });
}

describe("queued follow-up (issue #92 / #314)", () => {
  it("holds a mid-run send and does not auto-deliver when the run lands", async () => {
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

    // Main's terminal push still carries the undelivered queue; it clears the
    // field only once its own drain has taken the prompt.
    await inAct(() =>
      fake.emitThread(landed(busy, { prompt: "then update the changelog" })),
    );
    await m.flush();

    assert.equal(
      fake.of("runs.start").length,
      0,
      "settling must not auto-send the queue — main drains it",
    );
    assert.ok(
      m.query("[data-queued-prompt]"),
      "the queued strip stays until main drains it or the user cancels",
    );
    m.unmount();
  });

  it("clears the strip when main reports the queue drained", async () => {
    const { fake, m, busy } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "then update the changelog");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    assert.ok(m.query("[data-queued-prompt]"), "the queue must be visible");

    // The seam: main drains at the terminal and pushes queued: null. A
    // renderer that kept its own copy would strand this chip forever.
    await inAct(() =>
      fake.emitThread(
        detail({
          thread: {
            ...busy,
            status: "working",
            queued: null,
            updatedAt: NOW + 9000,
          },
        }),
      ),
    );
    await m.flush();

    assert.equal(
      m.query("[data-queued-prompt]"),
      null,
      "a drained queue must clear the strip",
    );
    m.unmount();
  });

  it("appends a second thought instead of dropping the first", async () => {
    const { fake, m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "first thought");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    await m.type(m.query("textarea"), "second thought");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    assert.equal(fake.of("runs.start").length, 0);
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip, "queued strip must stay after the second send");
    assert.match(
      strip!.textContent || "",
      /first thought/,
      "queueing twice must keep the first thought",
    );
    assert.match(
      strip!.textContent || "",
      /second thought/,
      "queueing twice must keep the second thought",
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

  it("round-trips the queue through the thread record so a remount still shows it", async () => {
    const { fake, m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "then update the changelog");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    const queuedCalls = fake.of("threads.setQueued");
    assert.ok(
      queuedCalls.length >= 1,
      "queueing must persist via threads.setQueued, not renderer-only state",
    );
    assert.deepEqual(queuedCalls[0]!.args[0], {
      threadId: "t-busy",
      prompt: "then update the changelog",
      attachments: undefined,
    });

    m.unmount();
    const remounted = await mount(<App />);
    await remounted.flush();

    assert.equal(
      fake.of("runs.start").length,
      0,
      "a still-working thread must not flush its queue on remount",
    );
    const card = remounted.query(
      'button[aria-label^="Select thread: busy target thread"]',
    );
    assert.ok(card, "busy thread card must exist after remount");
    await remounted.click(card);
    await remounted.flush();
    assert.ok(
      remounted.text().includes("then update the changelog"),
      "the queued follow-up must survive a remount from the thread record",
    );
    const queuedHint =
      remounted.query('[data-queued-dot="t-busy"]') ||
      remounted.query('[data-thread-card="t-busy"] [data-status-label]');
    assert.ok(queuedHint, "sidebar must hint a queue pending on this thread");
    assert.match(
      queuedHint.getAttribute("title") || "",
      /Queued: then update the changelog/,
      "the status-label tooltip must surface the queued text",
    );
    remounted.unmount();
  });

  it("does not auto-send a leftover queue; retry delivers it", async () => {
    const idle = thread({
      id: "t-idle-q",
      title: "idle with leftover queue",
      status: "idle",
      queued: {
        prompt: "finish the changelog",
        error: "CLI exited before ack",
      },
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoy(), idle],
      details: {
        "t-decoy": detail({ thread: decoy() }),
        "t-idle-q": detail({ thread: idle }),
      },
    });
    const m = await boot(fake);
    const card = m.query(
      'button[aria-label^="Select thread: idle with leftover queue"]',
    );
    assert.ok(card, "leftover-queue thread card must exist");
    await m.click(card);
    await m.flush();

    assert.equal(
      fake.of("runs.start").length,
      0,
      "a leftover queue must not flush on load — main drains, the user retries",
    );
    assert.ok(
      m.query("[data-queued-error]"),
      "delivery failure must be visible on the queued strip",
    );
    const retry = m.query("button[data-retry-queued]") as HTMLButtonElement | null;
    assert.ok(retry, "a failed delivery must offer Retry");
    assert.equal(retry!.disabled, false);

    await m.click(retry!);
    await m.flush();

    const clears = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { prompt: string | null }).prompt === null);
    assert.ok(
      clears.length >= 1,
      "retry must clear the persisted queue before starting the run",
    );
    const started = fake.of("runs.start");
    assert.equal(started.length, 1, "retry must start the queued prompt");
    assert.deepEqual(
      started[0]!.args[0],
      {
        threadId: "t-idle-q",
        prompt: "finish the changelog",
        attachments: undefined,
      },
      "retry must send the queued prompt to the thread it was typed on",
    );
    const channels = fake.channels();
    const clearAt = channels.lastIndexOf("threads.setQueued");
    const startAt = channels.indexOf("runs.start");
    assert.ok(clearAt >= 0 && startAt >= 0 && clearAt < startAt);
    m.unmount();
  });

  it("disables retry while the thread is still working", async () => {
    const busy = working();
    busy.queued = { prompt: "held", error: "delivery failed" };
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoy(), busy],
      details: {
        "t-decoy": detail({ thread: decoy() }),
        "t-busy": detail({ thread: busy }),
      },
    });
    const m = await boot(fake);
    const card = m.query('button[aria-label^="Select thread: busy target thread"]');
    assert.ok(card);
    await m.click(card);
    await m.flush();

    const retry = m.query("button[data-retry-queued]") as HTMLButtonElement | null;
    assert.ok(retry, "failed delivery on a working thread still shows Retry");
    assert.equal(retry!.disabled, true);
    await m.click(retry!);
    await m.flush();
    assert.equal(
      fake.of("runs.start").length,
      0,
      "a disabled retry must not start a run",
    );
    m.unmount();
  });
});
