/**
 * Issue #194: per-thread scratch notes in the header.
 * (The sidebar notes preview died with #566 one-line rows.)
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

async function blurNotes(m: Awaited<ReturnType<typeof mount>>) {
  const ta = m.query("[data-thread-notes-input]") as HTMLTextAreaElement | null;
  assert.ok(ta, "notes textarea");
  await inAct(() => {
    ta.blur();
  });
  await settle(m);
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

/** Reject threads.setNotes until `reject` is flipped false. */
function interceptSetNotes(
  fake: ReturnType<typeof createFakeCoder>,
  reject: { current: boolean },
  message = "Notes save rejected",
) {
  const orig = fake.api.threads.setNotes;
  fake.api.threads.setNotes = ((input: unknown) => {
    if (reject.current) {
      fake.calls.push({ channel: "threads.setNotes", args: [input] });
      return Promise.reject(new Error(message));
    }
    return orig(input);
  }) as typeof orig;
}

/** Hold threads.setNotes until the test settles it. */
function deferSetNotes(fake: ReturnType<typeof createFakeCoder>) {
  const orig = fake.api.threads.setNotes;
  const pending: Array<{
    input: unknown;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }> = [];
  fake.api.threads.setNotes = ((input: unknown) => {
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
      assert.ok(p, "expected a pending setNotes");
      const result = await orig(p.input);
      await inAct(() => p.resolve(result));
    },
    async fail(message = "Notes save rejected") {
      const p = pending.shift();
      assert.ok(p, "expected a pending setNotes");
      fake.calls.push({ channel: "threads.setNotes", args: [p.input] });
      await inAct(() => p.reject(new Error(message)));
    },
  };
}

describe("thread notes (issue #194)", () => {
  it("header Notes button opens a textarea seeded with the thread's notes", async () => {
    const tOpen = thread({
      id: "t-notes",
      projectId: "p1",
      title: "noted thread",
      notes: "merge after #42 lands",
      updatedAt: FRESH,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen],
      details: {
        "t-notes": detail({ thread: tOpen }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();

      const btn = m.query("[data-thread-notes-btn]");
      assert.ok(btn, "Notes header button");
      assert.equal(btn!.getAttribute("data-has-notes"), "true");
      assert.equal(btn!.getAttribute("aria-expanded"), "false");
      await m.click(btn);

      const ta = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(ta, "notes textarea after open");
      assert.equal(ta!.value, "merge after #42 lands");
      assert.equal(ta!.getAttribute("aria-label"), "Thread notes");
      assert.equal(
        m.query("[data-thread-notes-btn]")!.getAttribute("aria-expanded"),
        "true",
      );
    } finally {
      m.unmount();
    }
  });

  it("editing then blurring calls threads.setNotes once with the typed text", async () => {
    const tOpen = thread({
      id: "t-notes",
      projectId: "p1",
      notes: "old note",
      updatedAt: FRESH,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen],
      details: {
        "t-notes": detail({ thread: tOpen }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();

      await m.click(m.query("[data-thread-notes-btn]"));
      const ta = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(ta, "notes textarea");
      await m.type(ta, "merge after #42 lands");
      await blurNotes(m);

      const calls = fake.of("threads.setNotes");
      assert.equal(calls.length, 1, "setNotes must fire once");
      assert.deepEqual(calls[0]!.args[0], {
        threadId: "t-notes",
        notes: "merge after #42 lands",
      });
      assert.equal(m.query("[data-thread-notes-input]"), null, "panel closed");
    } finally {
      m.unmount();
    }
  });

  it("Escape closes without saving, and opening then closing unchanged fires no call", async () => {
    const tOpen = thread({
      id: "t-notes",
      projectId: "p1",
      notes: "keep this",
      updatedAt: FRESH,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen],
      details: {
        "t-notes": detail({ thread: tOpen }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();

      await m.click(m.query("[data-thread-notes-btn]"));
      const ta = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(ta, "notes textarea");
      await m.type(ta, "should not persist");
      await m.press(ta, "Escape");
      await settle(m);

      assert.equal(m.query("[data-thread-notes-input]"), null, "Escape closes");
      assert.equal(
        fake.of("threads.setNotes").length,
        0,
        "Escape must not save",
      );

      await m.click(m.query("[data-thread-notes-btn]"));
      const again = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(again, "reopens");
      assert.equal(again!.value, "keep this", "draft reverted after Escape");
      await blurNotes(m);

      assert.equal(
        fake.of("threads.setNotes").length,
        0,
        "unchanged close must not save",
      );
    } finally {
      m.unmount();
    }
  });

  it("switching threads flushes the outgoing draft onto the old thread id", async () => {
    const tA = thread({
      id: "t-a",
      projectId: "p1",
      title: "thread A",
      notes: "A saved",
      updatedAt: FRESH + 100,
    });
    const tB = thread({
      id: "t-b",
      projectId: "p1",
      title: "thread B",
      notes: "B saved",
      updatedAt: FRESH,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tA, tB],
      details: {
        "t-a": detail({ thread: tA }),
        "t-b": detail({ thread: tB }),
      },
    });
    const m = await boot(fake);
    try {
      await m.flush();

      const active = m.query("[data-thread-card][data-active=true]");
      if (active?.getAttribute("data-thread-card") !== "t-a") {
        const selectA = m
          .query('[data-thread-card="t-a"]')
          ?.querySelector("button");
        assert.ok(selectA, "thread A card select");
        await m.click(selectA);
        await settle(m);
      }

      await m.click(m.query("[data-thread-notes-btn]"));
      const ta = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(ta, "notes textarea on A");
      assert.equal(ta!.value, "A saved");
      await m.type(ta, "typed on A, never blurred");

      // jsdom click does not blur the textarea, so this is the same path
      // as a programmatic select (⌘J/K) that never fires onBlur.
      const selectB = m
        .query('[data-thread-card="t-b"]')
        ?.querySelector("button");
      assert.ok(selectB, "thread B card select");
      await m.click(selectB);
      await settle(m);

      const calls = fake.of("threads.setNotes");
      assert.equal(calls.length, 1, "setNotes must fire once for the flush");
      assert.deepEqual(calls[0]!.args[0], {
        threadId: "t-a",
        notes: "typed on A, never blurred",
      });

      assert.equal(
        m.query("[data-thread-card][data-active=true]")?.getAttribute(
          "data-thread-card",
        ),
        "t-b",
        "B is now selected",
      );
      assert.equal(
        m.query("[data-thread-notes-input]"),
        null,
        "panel closed on switch",
      );

      await m.click(m.query("[data-thread-notes-btn]"));
      const onB = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(onB, "notes textarea on B");
      assert.equal(onB!.value, "B saved", "B shows B's notes, not A's draft");
    } finally {
      m.unmount();
    }
  });

  it("keeps a rejected notes draft open for retry (issue #935)", async () => {
    const tOpen = thread({
      id: "t-notes",
      projectId: "p1",
      notes: "Original saved note",
      updatedAt: FRESH,
    });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tOpen],
      details: {
        "t-notes": detail({ thread: tOpen }),
      },
    });
    const reject = { current: true };
    interceptSetNotes(fake, reject);

    const m = await boot(fake);
    try {
      await m.flush();

      await m.click(m.query("[data-thread-notes-btn]"));
      const ta = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(ta, "notes textarea");
      await m.type(ta, "Important unsaved investigation notes");
      await m.click(m.query("[data-thread-notes-btn]"));
      await settle(m);

      const stillOpen = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(stillOpen, "a rejected write must leave the editor open");
      assert.equal(
        stillOpen!.value,
        "Important unsaved investigation notes",
        "the edited draft must still be in the textarea",
      );
      const notesError = m.query("[data-thread-notes-error]");
      assert.ok(notesError, "the rejection must be visible on the editor");
      assert.match(notesError!.textContent || "", /Notes save rejected/);

      reject.current = false;
      const retry = m.query("[data-thread-notes-retry]");
      assert.ok(retry, "retry control");
      await m.click(retry);
      await settle(m);

      assert.equal(
        m.query("[data-thread-notes-input]"),
        null,
        "a successful retry must close the editor",
      );
      const calls = fake.of("threads.setNotes");
      assert.equal(calls.length, 2, "reject then retry is two writes");
      assert.deepEqual(calls[1]!.args[0], {
        threadId: "t-notes",
        notes: "Important unsaved investigation notes",
      });

      await m.click(m.query("[data-thread-notes-btn]"));
      const reopened = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(reopened, "reopens after successful save");
      assert.equal(
        reopened!.value,
        "Important unsaved investigation notes",
        "reopen shows the persisted notes, not the original",
      );
    } finally {
      m.unmount();
    }
  });

  it("keeps a failed notes draft on its source thread across navigation (issue #935)", async () => {
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
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tA, tB],
      details: {
        "t-a": detail({ thread: tA }),
        "t-b": detail({ thread: tB }),
      },
    });
    const reject = { current: true };
    interceptSetNotes(fake, reject);

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

      await m.click(m.query("[data-thread-notes-btn]"));
      const ta = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(ta, "notes textarea on A");
      await m.type(ta, "Important unsaved investigation notes");

      await selectThread(m, "t-b");

      assert.equal(
        m.query("[data-thread-notes-input]"),
        null,
        "panel closed on switch",
      );
      await m.click(m.query("[data-thread-notes-btn]"));
      const onB = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(onB, "notes textarea on B");
      assert.equal(onB!.value, "B saved", "B shows B's notes, not A's failed draft");
      await m.press(onB, "Escape");
      await settle(m);

      await selectThread(m, "t-a");
      await m.click(m.query("[data-thread-notes-btn]"));
      const onA = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(onA, "notes textarea on A after return");
      assert.equal(
        onA!.value,
        "Important unsaved investigation notes",
        "reopen restores the failed draft for A",
      );
      const notesError = m.query("[data-thread-notes-error]");
      assert.ok(notesError, "the rejection must still be visible on A");
      assert.match(notesError!.textContent || "", /Notes save rejected/);

      reject.current = false;
      const retry = m.query("[data-thread-notes-retry]");
      assert.ok(retry, "retry control on A");
      await m.click(retry);
      await settle(m);

      assert.equal(
        m.query("[data-thread-notes-input]"),
        null,
        "successful retry closes the editor",
      );
      const calls = fake.of("threads.setNotes");
      assert.ok(calls.length >= 2, "flush reject then retry");
      assert.deepEqual(calls[calls.length - 1]!.args[0], {
        threadId: "t-a",
        notes: "Important unsaved investigation notes",
      });
    } finally {
      m.unmount();
    }
  });

  it("locks a reopened notes editor until a pending write settles (issue #935)", async () => {
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
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tA, tB],
      details: {
        "t-a": detail({ thread: tA }),
        "t-b": detail({ thread: tB }),
      },
    });
    const gate = deferSetNotes(fake);

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

      await m.click(m.query("[data-thread-notes-btn]"));
      await m.type(
        m.query("[data-thread-notes-input]"),
        "Important unsaved investigation notes",
      );
      await selectThread(m, "t-b");
      assert.equal(gate.length, 1, "switch flushes A without waiting");

      await m.click(m.query("[data-thread-notes-btn]"));
      const onB = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(onB, "notes textarea on B while A is still saving");
      assert.equal(onB!.value, "B saved");
      assert.equal(onB!.disabled, false, "B stays editable during A's write");
      await m.press(onB, "Escape");
      await settle(m);

      await selectThread(m, "t-a");
      await m.click(m.query("[data-thread-notes-btn]"));
      const onA = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(onA, "reopened A while its write is pending");
      assert.equal(onA!.value, "Important unsaved investigation notes");
      assert.equal(
        onA!.disabled,
        true,
        "reopen must restore the saving lock until the pending write settles",
      );
      assert.equal(gate.length, 1, "reopen must not start a second write");

      await gate.succeed();
      await settle(m);

      const after = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(after, "successful outgoing flush must not close a reopened editor");
      assert.equal(after!.value, "Important unsaved investigation notes");
      assert.equal(after!.disabled, false, "lock clears after the write settles");
      await blurNotes(m);

      assert.equal(
        fake.of("threads.setNotes").length,
        1,
        "unchanged close after a successful flush must not write again",
      );
      assert.equal(
        gate.length,
        0,
        "unchanged close must not start another pending write",
      );
    } finally {
      m.unmount();
    }
  });

  it("does not let a late A notes write overwrite B or drop A's failed draft (issue #935)", async () => {
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
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [tA, tB],
      details: {
        "t-a": detail({ thread: tA }),
        "t-b": detail({ thread: tB }),
      },
    });
    const gate = deferSetNotes(fake);

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

      await m.click(m.query("[data-thread-notes-btn]"));
      await m.type(
        m.query("[data-thread-notes-input]"),
        "Important unsaved investigation notes",
      );
      // A → transient null detail → B (visibleDetail gates on selected id).
      await selectThread(m, "t-b");
      assert.equal(gate.length, 1);

      await m.click(m.query("[data-thread-notes-btn]"));
      const onB = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(onB);
      await m.type(onB, "B typed while A save is pending");

      await gate.fail();
      await settle(m);

      const stillB = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(stillB, "late A reject must leave B's editor open");
      assert.equal(
        stillB!.value,
        "B typed while A save is pending",
        "late A reject must not replace B's draft",
      );
      assert.equal(
        m.query("[data-thread-notes-error]"),
        null,
        "A's rejection must not paint on B",
      );

      await m.press(stillB, "Escape");
      await settle(m);
      await selectThread(m, "t-a");
      await m.click(m.query("[data-thread-notes-btn]"));
      const onA = m.query(
        "[data-thread-notes-input]",
      ) as HTMLTextAreaElement | null;
      assert.ok(onA, "A notes after null-detail hop");
      assert.equal(
        onA!.value,
        "Important unsaved investigation notes",
        "failed A draft survives A → null → B → A",
      );
      const notesError = m.query("[data-thread-notes-error]");
      assert.ok(notesError, "A still has a retryable error");
      assert.match(notesError!.textContent || "", /Notes save rejected/);
    } finally {
      m.unmount();
    }
  });

});
