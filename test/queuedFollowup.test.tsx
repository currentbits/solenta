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
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

  it("edits the queued follow-up in place via replace (issue #364)", async () => {
    const { fake, m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "original words");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    const edit = m.query("button[data-edit-queued]");
    assert.ok(edit, "a queued follow-up must be editable");
    await m.click(edit);
    const input = m.query(
      "textarea[data-edit-queued-input]",
    ) as HTMLTextAreaElement | null;
    assert.ok(input, "editing swaps the strip text for a textarea");
    assert.equal(
      input!.value,
      "original words",
      "the textarea seeds from the queued prompt",
    );
    await m.type(input!, "edited words");
    await m.click(m.query("button[data-save-queued-edit]"));
    await m.flush();

    const replaceCalls = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { replace?: boolean }).replace === true);
    assert.equal(
      replaceCalls.length,
      1,
      "saving an edit must replace, not append",
    );
    assert.deepEqual(replaceCalls[0]!.args[0], {
      threadId: "t-busy",
      prompt: "edited words",
      attachments: undefined,
      replace: true,
    });
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip, "the strip stays after an edit");
    assert.match(strip!.textContent || "", /edited words/);
    assert.ok(
      !/original words/.test(strip!.textContent || ""),
      "replace must not keep the old text",
    );
    m.unmount();
  });

  it("an empty edit save cancels the edit and keeps the queue", async () => {
    const { fake, m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "still queued");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    await m.click(m.query("button[data-edit-queued]"));
    const input = m.query(
      "textarea[data-edit-queued-input]",
    ) as HTMLTextAreaElement;
    await m.type(input, "   ");
    await m.click(m.query("button[data-save-queued-edit]"));
    await m.flush();

    assert.equal(
      fake.of("threads.setQueued").filter(
        (c) => (c.args[0] as { replace?: boolean }).replace === true,
      ).length,
      0,
      "an empty save must not blank the queue",
    );
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip, "the queue survives an empty save");
    assert.match(strip!.textContent || "", /still queued/);
    assert.equal(
      m.query("textarea[data-edit-queued-input]"),
      null,
      "the edit box closes",
    );
    m.unmount();
  });

  it("offers Send now on a settled thread with a leftover queue, and it sends", async () => {
    const idle = thread({
      id: "t-idle-send",
      title: "idle with plain queue",
      status: "idle",
      queued: { prompt: "ship it" },
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoy(), idle],
      details: {
        "t-decoy": detail({ thread: decoy() }),
        "t-idle-send": detail({ thread: idle }),
      },
    });
    const m = await boot(fake);
    const card = m.query(
      'button[aria-label^="Select thread: idle with plain queue"]',
    );
    assert.ok(card);
    await m.click(card);
    await m.flush();

    const sendNow = m.query(
      "button[data-retry-queued]",
    ) as HTMLButtonElement | null;
    assert.ok(sendNow, "a settled thread with a queue must offer Send now");
    assert.equal(sendNow!.disabled, false);
    assert.match(sendNow!.textContent || "", /Send now/);
    assert.equal(
      m.query("[data-queued-error]"),
      null,
      "no error, no Retry label",
    );

    await m.click(sendNow!);
    await m.flush();
    const started = fake.of("runs.start");
    assert.equal(started.length, 1, "Send now must start the queued prompt");
    assert.deepEqual(started[0]!.args[0], {
      threadId: "t-idle-send",
      prompt: "ship it",
      attachments: undefined,
    });
    m.unmount();
  });

  it("cancel pushes the discarded prompt back into an empty composer draft", async () => {
    const { m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "keep these words");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.equal(ta.value, "", "queueing clears the composer");

    await m.click(m.query("button[data-cancel-queued]"));
    await m.flush();
    assert.equal(
      m.query("[data-queued-prompt]"),
      null,
      "cancel still clears the strip",
    );
    assert.equal(
      ta.value,
      "keep these words",
      "the discarded text returns to the empty draft",
    );
    m.unmount();
  });

  it("restores the queued strip when cancel's host clear rejects", async () => {
    const { fake, m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "never mind this one");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    const orig = fake.api.threads.setQueued.bind(fake.api.threads);
    fake.api.threads.setQueued = (input) => {
      if ((input as { prompt: string | null }).prompt === null) {
        fake.calls.push({ channel: "threads.setQueued", args: [input] });
        return Promise.reject(new Error("queue clear failed"));
      }
      return orig(input);
    };

    await m.click(m.query("button[data-cancel-queued]"));
    await m.flush();

    const listed = await fake.api.threads.list();
    const row = listed.find((t) => t.id === "t-busy");
    assert.equal(
      row?.queued?.prompt,
      "never mind this one",
      "a rejected clear must leave the host queue unchanged",
    );
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip, "a failed clear must keep the queued strip");
    assert.match(strip!.textContent || "", /never mind this one/);
    const alert = m.query('[role="alert"]');
    assert.ok(alert, "the clear rejection must stay visible");
    assert.match(alert!.textContent || "", /queue clear failed/);
    m.unmount();
  });

  it("cancel does not clobber an in-progress composer draft", async () => {
    const { m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "queued words");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    const ta = m.query("textarea") as HTMLTextAreaElement;
    await m.type(ta, "half-typed draft");
    await m.flush();

    await m.click(m.query("button[data-cancel-queued]"));
    await m.flush();
    assert.equal(m.query("[data-queued-prompt]"), null);
    assert.equal(
      ta.value,
      "half-typed draft",
      "an in-progress draft always wins",
    );
    m.unmount();
  });

  it("a rejected cancel keeps the queued strip and does not fill the composer", async () => {
    const { fake, m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "never mind this one");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.equal(ta.value, "", "queueing clears the composer");

    const orig = fake.api.threads.setQueued.bind(fake.api.threads);
    fake.api.threads.setQueued = (input) => {
      if ((input as { prompt: string | null }).prompt === null) {
        fake.calls.push({ channel: "threads.setQueued", args: [input] });
        return Promise.reject(new Error("queue write failed"));
      }
      return orig(input);
    };

    await m.click(m.query("button[data-cancel-queued]"));
    await m.flush();

    const listed = await fake.api.threads.list();
    const row = listed.find((t) => t.id === "t-busy");
    assert.equal(
      row?.queued?.prompt,
      "never mind this one",
      "a rejected clear must leave the host queue in place",
    );
    assert.ok(
      m.query("[data-queued-prompt]"),
      "a rejected clear must keep the queued strip",
    );
    assert.equal(
      ta.value,
      "",
      "a rejected clear must not put the discarded prompt into the composer",
    );
    m.unmount();
  });

  async function queueTwoThoughts(m: Awaited<ReturnType<typeof bootOnBusyThread>>["m"]) {
    await m.type(m.query("textarea"), "first thought");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    await m.type(m.query("textarea"), "second thought");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
  }

  it("edits one of two queued thoughts without changing the other (issue #780)", async () => {
    const { fake, m } = await bootOnBusyThread();
    await queueTwoThoughts(m);

    const first = m.query('[data-queued-item="0"]');
    const second = m.query('[data-queued-item="1"]');
    assert.ok(first && second, "two appended thoughts must render as items");
    const edit = first.querySelector("button[data-edit-queued]");
    assert.ok(edit, "each queued item must be editable");
    await m.click(edit);
    const input = first.querySelector(
      "textarea[data-edit-queued-input]",
    ) as HTMLTextAreaElement | null;
    assert.ok(input, "editing an item swaps its text for a textarea");
    assert.equal(input!.value, "first thought");
    await m.type(input!, "edited first");
    await m.click(first.querySelector("button[data-save-queued-edit]"));
    await m.flush();

    const replaceCalls = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { replace?: boolean }).replace === true);
    assert.equal(replaceCalls.length, 1, "saving an item edit must replace");
    assert.deepEqual(replaceCalls[0]!.args[0], {
      threadId: "t-busy",
      prompt: "edited first\n\nsecond thought",
      attachments: undefined,
      replace: true,
      items: ["edited first", "second thought"],
    });
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip);
    assert.match(strip!.textContent || "", /edited first/);
    assert.match(strip!.textContent || "", /second thought/);
    assert.ok(
      !/first thought/.test(strip!.textContent || ""),
      "the other item must stay; the edited one must not keep the old text",
    );
    m.unmount();
  });

  it("removes one of two queued thoughts and keeps the other (issue #780)", async () => {
    const { fake, m } = await bootOnBusyThread();
    await queueTwoThoughts(m);

    const first = m.query('[data-queued-item="0"]');
    assert.ok(first, "two appended thoughts must render as items");
    const remove = first.querySelector("button[data-remove-queued]");
    assert.ok(remove, "each queued item must be removable");
    await m.click(remove);
    await m.flush();

    const replaceCalls = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { replace?: boolean }).replace === true);
    assert.equal(replaceCalls.length, 1, "removing an item must replace the blob");
    assert.deepEqual(replaceCalls[0]!.args[0], {
      threadId: "t-busy",
      prompt: "second thought",
      attachments: undefined,
      replace: true,
      items: ["second thought"],
    });
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip, "the remaining thought stays queued");
    assert.match(strip!.textContent || "", /second thought/);
    assert.ok(
      !/first thought/.test(strip!.textContent || ""),
      "the removed thought must leave the strip",
    );
    assert.equal(
      fake.of("threads.setQueued").filter(
        (c) => (c.args[0] as { prompt: string | null }).prompt === null,
      ).length,
      0,
      "removing one of two must not clear the whole queue",
    );
    m.unmount();
  });

  it("reorders two queued thoughts (issue #780)", async () => {
    const { fake, m } = await bootOnBusyThread();
    await queueTwoThoughts(m);

    const first = m.query('[data-queued-item="0"]');
    assert.ok(first, "two appended thoughts must render as items");
    const down = first.querySelector("button[data-move-queued-down]");
    assert.ok(down, "a multi-item queue must offer reorder");
    await m.click(down);
    await m.flush();

    const replaceCalls = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { replace?: boolean }).replace === true);
    assert.equal(replaceCalls.length, 1, "reorder must replace the blob");
    assert.deepEqual(replaceCalls[0]!.args[0], {
      threadId: "t-busy",
      prompt: "second thought\n\nfirst thought",
      attachments: undefined,
      replace: true,
      items: ["second thought", "first thought"],
    });
    const items = m.queryAll("[data-queued-item]");
    assert.equal(items.length, 2);
    assert.match(items[0]!.textContent || "", /second thought/);
    assert.match(items[1]!.textContent || "", /first thought/);
    m.unmount();
  });

  it("keeps a thought that contains a blank line as one item (issue #809)", async () => {
    const { m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "para one\n\npara two");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();
    await m.type(m.query("textarea"), "second thought");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    const items = m.queryAll("[data-queued-item]");
    assert.equal(
      items.length,
      2,
      "a blank line inside a thought must not split it into two items",
    );
    assert.match(items[0]!.textContent || "", /para one/);
    assert.match(items[0]!.textContent || "", /para two/);
    assert.match(items[1]!.textContent || "", /second thought/);

    m.unmount();
    const remounted = await mount(<App />);
    await remounted.flush();
    const card = remounted.query(
      'button[aria-label^="Select thread: busy target thread"]',
    );
    assert.ok(card);
    await remounted.click(card);
    await remounted.flush();
    const remountedItems = remounted.queryAll("[data-queued-item]");
    assert.equal(
      remountedItems.length,
      2,
      "persisted items[] must survive remount; splitting prompt would make three",
    );
    assert.match(remountedItems[0]!.textContent || "", /para one/);
    assert.match(remountedItems[0]!.textContent || "", /para two/);
    assert.match(remountedItems[1]!.textContent || "", /second thought/);
    remounted.unmount();
  });

  it("migrates a prompt-only queue by splitting once (issue #809)", async () => {
    const busy = working();
    busy.queued = { prompt: "legacy one\n\nlegacy two" };
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

    const items = m.queryAll("[data-queued-item]");
    assert.equal(
      items.length,
      2,
      "a prompt-only row must split once into items",
    );
    assert.match(items[0]!.textContent || "", /legacy one/);
    assert.match(items[1]!.textContent || "", /legacy two/);
    m.unmount();
  });

  it("yields leftover row width to ellipsis so item actions stay in the card", () => {
    // jsdom does not lay out flex, so the overflow bug is a CSS contract:
    // long nowrap thoughts must shrink (flex:1; min-width:0) and the
    // Up/Down/Edit/Remove cluster must not (flex-shrink:0). Using
    // .statusLeft for the buttons fails this — it sets min-width:0.
    const cssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/components/ThreadView.module.css",
    );
    const clean = fs
      .readFileSync(cssPath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const lastRuleBody = (className: string): string => {
      const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{([^}]*)\\}`, "g");
      let last = "";
      let match: RegExpExecArray | null;
      while ((match = re.exec(clean))) last = match[1];
      return last;
    };

    const text = lastRuleBody("queuedText");
    assert.ok(text, ".queuedText rule must exist");
    assert.match(
      text,
      /flex\s*:\s*1/,
      ".queuedText must take leftover space instead of a nowrap max-content basis",
    );
    assert.match(
      text,
      /min-width\s*:\s*0/,
      ".queuedText must be allowed to shrink below the thought's intrinsic width",
    );

    const actions = lastRuleBody("queuedActions");
    assert.ok(actions, ".queuedActions rule must exist");
    assert.match(
      actions,
      /flex-shrink\s*:\s*0/,
      "queued item actions must not shrink when the thought is a long URL",
    );
  });

  it("puts each queued item's actions in the non-shrinking cluster", async () => {
    const { m } = await bootOnBusyThread();
    await queueTwoThoughts(m);

    const first = m.query('[data-queued-item="0"]');
    assert.ok(first, "two appended thoughts must render as items");
    const actions = first.querySelector("[data-queued-actions]");
    assert.ok(actions, "item actions must live in [data-queued-actions]");
    assert.ok(
      actions.querySelector("button[data-remove-queued]"),
      "Remove must sit inside the action cluster, not as a free flex sibling of the thought",
    );
    assert.ok(
      actions.querySelector("button[data-edit-queued]"),
      "Edit must sit inside the action cluster",
    );
    assert.ok(
      actions.querySelector("button[data-move-queued-down]"),
      "Down must sit inside the action cluster",
    );
    m.unmount();
  });

  const QUEUED_SHOT = {
    kind: "image" as const,
    path: "/tmp/shot.png",
    name: "shot.png",
  };

  async function bootQueuedPair() {
    const busy = working();
    busy.queued = {
      prompt: "first thought\n\nsecond thought",
      items: ["first thought", "second thought"],
      attachments: [QUEUED_SHOT],
    };
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoy(), busy],
      details: {
        "t-decoy": detail({ thread: decoy() }),
        "t-busy": detail({ thread: busy }),
      },
    });
    const m = await boot(fake);
    const card = m.query(
      'button[aria-label^="Select thread: busy target thread"]',
    );
    assert.ok(card, "busy thread card must exist");
    await m.click(card);
    await m.flush();
    return { fake, m, busy };
  }

  it("keeps a rejected queued-edit draft open for retry and preserves items plus attachments (issue #926)", async () => {
    const attach = {
      kind: "image" as const,
      path: "/tmp/shot.png",
      name: "shot.png",
    };
    const busy = working();
    busy.queued = {
      prompt: "Original queued text\n\nkeep this second",
      items: ["Original queued text", "keep this second"],
      attachments: [attach],
    };
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoy(), busy],
      details: {
        "t-decoy": detail({ thread: decoy() }),
        "t-busy": detail({ thread: busy }),
      },
    });
    const origSetQueued = fake.api.threads.setQueued;
    let rejectReplace = true;
    fake.api.threads.setQueued = ((input: unknown) => {
      const i = input as { replace?: boolean };
      if (i.replace === true && rejectReplace) {
        fake.calls.push({ channel: "threads.setQueued", args: [input] });
        return Promise.reject(new Error("queue write failed"));
      }
      return origSetQueued(input);
    }) as typeof fake.api.threads.setQueued;

    const m = await boot(fake);
    const card = m.query(
      'button[aria-label^="Select thread: busy target thread"]',
    );
    assert.ok(card);
    await m.click(card);
    await m.flush();

    const first = m.query('[data-queued-item="0"]');
    assert.ok(first, "seeded multi-item queue must render");
    await m.click(first.querySelector("button[data-edit-queued]"));
    const input = first.querySelector(
      "textarea[data-edit-queued-input]",
    ) as HTMLTextAreaElement | null;
    assert.ok(input);
    await m.type(input!, "Revised instructions");
    await m.click(first.querySelector("button[data-save-queued-edit]"));
    await m.flush();

    const stillOpen = m.query(
      "textarea[data-edit-queued-input]",
    ) as HTMLTextAreaElement | null;
    assert.ok(stillOpen, "a rejected write must leave the editor open");
    assert.equal(
      stillOpen!.value,
      "Revised instructions",
      "the revised draft must still be editable",
    );
    const editError = m.query("[data-queued-edit-error]");
    assert.ok(editError, "the rejection must be visible on the editor");
    assert.match(editError!.textContent || "", /queue write failed/);

    rejectReplace = false;
    await m.click(m.query("button[data-save-queued-edit]"));
    await m.flush();

    assert.equal(
      m.query("textarea[data-edit-queued-input]"),
      null,
      "a successful retry must close the editor",
    );
    const replaceCalls = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { replace?: boolean }).replace === true);
    assert.equal(replaceCalls.length, 2, "reject then retry is two replace writes");
    assert.deepEqual(replaceCalls[1]!.args[0], {
      threadId: "t-busy",
      prompt: "Revised instructions\n\nkeep this second",
      attachments: [attach],
      replace: true,
      items: ["Revised instructions", "keep this second"],
    });
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip);
    assert.match(strip!.textContent || "", /Revised instructions/);
    assert.match(strip!.textContent || "", /keep this second/);
    m.unmount();
  });

  it("ignores a second Save while a queued-edit write is pending (issue #926)", async () => {
    const busy = working();
    busy.queued = { prompt: "Original queued text" };
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoy(), busy],
      details: {
        "t-decoy": detail({ thread: decoy() }),
        "t-busy": detail({ thread: busy }),
      },
    });
    const origSetQueued = fake.api.threads.setQueued;
    let release!: (value: unknown) => void;
    fake.api.threads.setQueued = ((input: unknown) => {
      const i = input as { replace?: boolean };
      if (i.replace === true) {
        fake.calls.push({ channel: "threads.setQueued", args: [input] });
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return origSetQueued(input);
    }) as typeof fake.api.threads.setQueued;

    const m = await boot(fake);
    const card = m.query(
      'button[aria-label^="Select thread: busy target thread"]',
    );
    assert.ok(card);
    await m.click(card);
    await m.flush();

    await m.click(m.query("button[data-edit-queued]"));
    await m.type(m.query("textarea[data-edit-queued-input]"), "Revised once");
    const save = m.query("button[data-save-queued-edit]") as HTMLButtonElement;
    assert.ok(save);
    await m.click(save);
    assert.equal(save.disabled, true, "Save must lock while the write is in flight");
    await m.click(save);
    await m.flush();
    assert.equal(
      fake
        .of("threads.setQueued")
        .filter((c) => (c.args[0] as { replace?: boolean }).replace === true)
        .length,
      1,
      "a second click must not start another write",
    );

    await inAct(() =>
      release(
        thread({
          ...busy,
          queued: { prompt: "Revised once" },
        }),
      ),
    );
    await m.flush();
    assert.equal(m.query("textarea[data-edit-queued-input]"), null);
    m.unmount();
  });

  it("keeps order and attachments after a rejected reorder, then retries (issue #1144)", async () => {
    const { fake, m } = await bootQueuedPair();
    const orig = fake.api.threads.setQueued.bind(fake.api.threads);
    let rejectNext = true;
    fake.api.threads.setQueued = (input) => {
      if (rejectNext && (input as { replace?: boolean }).replace) {
        rejectNext = false;
        fake.calls.push({ channel: "threads.setQueued", args: [input] });
        return Promise.reject(new Error("queue write failed"));
      }
      return orig(input);
    };

    const first = m.query('[data-queued-item="0"]');
    assert.ok(first, "two queued thoughts must render as items");
    const down = first.querySelector("button[data-move-queued-down]");
    assert.ok(down, "a multi-item queue must offer reorder");
    await m.click(down);

    const items = m.queryAll("[data-queued-item]");
    assert.equal(items.length, 2);
    assert.match(
      items[0]!.textContent || "",
      /first thought/,
      "a rejected reorder must not apply",
    );
    assert.match(items[1]!.textContent || "", /second thought/);
    const err = m.query("[data-queued-write-error]");
    assert.ok(err, "a rejected persist must show a retryable error on the strip");
    assert.match(err.textContent || "", /queue write failed/);

    const stillFirst = m.query('[data-queued-item="0"]');
    await m.click(stillFirst!.querySelector("button[data-move-queued-down]"));

    const replaceCalls = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { replace?: boolean }).replace === true);
    assert.equal(replaceCalls.length, 2, "retry must write again");
    assert.deepEqual(replaceCalls[1]!.args[0], {
      threadId: "t-busy",
      prompt: "second thought\n\nfirst thought",
      attachments: [QUEUED_SHOT],
      replace: true,
      items: ["second thought", "first thought"],
    });
    const retried = m.queryAll("[data-queued-item]");
    assert.match(retried[0]!.textContent || "", /second thought/);
    assert.match(retried[1]!.textContent || "", /first thought/);
    assert.equal(
      m.query("[data-queued-write-error]"),
      null,
      "a successful retry clears the persist error",
    );
    m.unmount();
  });

  it("does not start a second reorder while a replace is pending (issue #1144)", async () => {
    const { fake, m } = await bootQueuedPair();
    const orig = fake.api.threads.setQueued.bind(fake.api.threads);
    let release!: (run: () => ReturnType<typeof orig>) => void;
    const gate = new Promise<() => ReturnType<typeof orig>>((resolve) => {
      release = resolve;
    });
    fake.api.threads.setQueued = (input) => {
      fake.calls.push({ channel: "threads.setQueued", args: [input] });
      return gate.then((run) => run());
    };

    const down = m.query('[data-queued-item="0"] button[data-move-queued-down]');
    assert.ok(down);
    await m.click(down);
    await m.click(down);

    assert.equal(
      fake
        .of("threads.setQueued")
        .filter((c) => (c.args[0] as { replace?: boolean }).replace === true)
        .length,
      1,
      "a second Down while the first replace is in flight must not write again",
    );
    const downBtn = m.query(
      '[data-queued-item="0"] button[data-move-queued-down]',
    ) as HTMLButtonElement | null;
    assert.ok(downBtn);
    assert.equal(downBtn.disabled, true, "Down must lock while a write is pending");

    await inAct(() => {
      release(() => orig({
        threadId: "t-busy",
        prompt: "second thought\n\nfirst thought",
        attachments: [QUEUED_SHOT],
        replace: true,
        items: ["second thought", "first thought"],
      }));
    });
    await m.flush();
    m.unmount();
  });

  it("keeps both items after a rejected remove, then retries (issue #1144)", async () => {
    const { fake, m } = await bootQueuedPair();
    const orig = fake.api.threads.setQueued.bind(fake.api.threads);
    let rejectNext = true;
    fake.api.threads.setQueued = (input) => {
      if (rejectNext && (input as { replace?: boolean }).replace) {
        rejectNext = false;
        fake.calls.push({ channel: "threads.setQueued", args: [input] });
        return Promise.reject(new Error("queue write failed"));
      }
      return orig(input);
    };

    const first = m.query('[data-queued-item="0"]');
    assert.ok(first, "two queued thoughts must render as items");
    const remove = first.querySelector("button[data-remove-queued]");
    assert.ok(remove, "a multi-item queue must offer remove");
    await m.click(remove);

    const items = m.queryAll("[data-queued-item]");
    assert.equal(items.length, 2, "a rejected remove must not drop the item");
    assert.match(items[0]!.textContent || "", /first thought/);
    assert.match(items[1]!.textContent || "", /second thought/);
    const err = m.query("[data-queued-write-error]");
    assert.ok(err, "a rejected persist must show a retryable error on the strip");
    assert.match(err.textContent || "", /queue write failed/);

    const stillFirst = m.query('[data-queued-item="0"]');
    await m.click(stillFirst!.querySelector("button[data-remove-queued]"));

    const replaceCalls = fake
      .of("threads.setQueued")
      .filter((c) => (c.args[0] as { replace?: boolean }).replace === true);
    assert.equal(replaceCalls.length, 2, "retry must write again");
    assert.deepEqual(replaceCalls[1]!.args[0], {
      threadId: "t-busy",
      prompt: "second thought",
      attachments: [QUEUED_SHOT],
      replace: true,
      items: ["second thought"],
    });
    const strip = m.query("[data-queued-prompt]");
    assert.ok(strip, "the remaining thought stays queued");
    assert.match(strip!.textContent || "", /second thought/);
    assert.ok(
      !/first thought/.test(strip!.textContent || ""),
      "the removed thought must leave the strip",
    );
    assert.equal(
      m.query("[data-queued-write-error]"),
      null,
      "a successful retry clears the persist error",
    );
    m.unmount();
  });

  it("does not start a second remove while a replace is pending (issue #1144)", async () => {
    const { fake, m } = await bootQueuedPair();
    const orig = fake.api.threads.setQueued.bind(fake.api.threads);
    let release!: (run: () => ReturnType<typeof orig>) => void;
    const gate = new Promise<() => ReturnType<typeof orig>>((resolve) => {
      release = resolve;
    });
    fake.api.threads.setQueued = (input) => {
      fake.calls.push({ channel: "threads.setQueued", args: [input] });
      return gate.then((run) => run());
    };

    const remove = m.query('[data-queued-item="0"] button[data-remove-queued]');
    assert.ok(remove);
    await m.click(remove);
    await m.click(remove);

    assert.equal(
      fake
        .of("threads.setQueued")
        .filter((c) => (c.args[0] as { replace?: boolean }).replace === true)
        .length,
      1,
      "a second Remove while the first replace is in flight must not write again",
    );
    const removeBtn = m.query(
      '[data-queued-item="0"] button[data-remove-queued]',
    ) as HTMLButtonElement | null;
    assert.ok(removeBtn);
    assert.equal(removeBtn.disabled, true, "Remove must lock while a write is pending");

    await inAct(() => {
      release(() => orig({
        threadId: "t-busy",
        prompt: "second thought",
        attachments: [QUEUED_SHOT],
        replace: true,
        items: ["second thought"],
      }));
    });
    await m.flush();
    m.unmount();
  });
});

describe("side question /btw during a run (issue #471)", () => {
  it("opens a card instead of queueing a follow-up", async () => {
    const { fake, m } = await bootOnBusyThread();

    await m.type(m.query("textarea"), "/btw where is createThread");
    await m.click(m.query('button[aria-label="Send"]'));
    await m.flush();

    assert.equal(
      fake.of("runs.start").length,
      0,
      "a side question must not start a second run",
    );
    assert.equal(
      fake.of("threads.setQueued").length,
      0,
      "a side question must not become the next follow-up",
    );
    const btwCalls = fake.of("threads.btw");
    assert.equal(btwCalls.length, 1);
    assert.deepEqual(btwCalls[0]!.args[0], {
      threadId: "t-busy",
      question: "where is createThread",
    });
    assert.ok(m.query("[data-btw-card]"), "the side card must appear on the thread");
    assert.match(m.text(), /where is createThread/);
    m.unmount();
  });
});
