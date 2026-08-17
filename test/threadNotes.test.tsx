/**
 * Issue #194: per-thread scratch notes in the header + sidebar preview.
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
import { ThreadCard } from "../src/components/Sidebar";
import App from "../src/App";
import type { ProviderInfo } from "../src/shared/ipc";

const FRESH = Date.now();

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

  it("sidebar card shows a notes preview only when the thread has notes", async () => {
    const withNotes = thread({
      id: "t-notes",
      projectId: "p1",
      notes: "merge after #42 lands\nsecond line stays in the title tooltip",
    });
    const without = thread({
      id: "t-plain",
      projectId: "p1",
      notes: "",
    });

    const has = await mount(
      <ThreadCard
        thread={withNotes}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={FRESH}
        onSelect={() => {}}
      />,
    );
    try {
      const preview = has.query('[data-notes-preview="t-notes"]');
      assert.ok(preview, "preview on a card with notes");
      assert.equal(
        (preview!.textContent || "").trim(),
        "merge after #42 lands",
      );
      assert.equal(
        preview!.getAttribute("title"),
        "merge after #42 lands\nsecond line stays in the title tooltip",
      );
    } finally {
      has.unmount();
    }

    const empty = await mount(
      <ThreadCard
        thread={without}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={FRESH}
        onSelect={() => {}}
      />,
    );
    try {
      assert.equal(
        empty.query('[data-notes-preview="t-plain"]'),
        null,
        "no preview when notes are empty",
      );
      assert.equal(empty.query("[data-notes-preview]"), null);
    } finally {
      empty.unmount();
    }
  });
});
