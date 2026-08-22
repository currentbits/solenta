/**
 * thread:updated carries TAILS (ThreadPatch), so the real App must merge them
 * into the open transcript. A unit test of mergeThreadPatch cannot catch
 * useCoder dropping the prefix (transcript would silently truncate mid-run) or
 * ignoring a hole after a missed push.
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
import { useCoder } from "../src/useCoder";
import type { ChatMessage, ThreadInfo } from "../src/shared/ipc";

const NOW = Date.now();

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function msg(id: string, text: string): ChatMessage {
  return { id, role: "assistant", text, createdAt: NOW, runId: "run-1" };
}

function target(): ThreadInfo {
  return thread({ id: "t-patch", title: "patch target", status: "working" });
}

function fixture() {
  const row = target();
  const fake = createFakeCoder({
    projects: [project()],
    threads: [row],
    details: {
      "t-patch": detail({
        thread: row,
        messages: [msg("m1", "first message kept"), msg("m2", "growi")],
      }),
    },
  });
  return { row, fake };
}

describe("thread:updated tail merge", () => {
  it("merges a tail without dropping the earlier transcript", async () => {
    const { row, fake } = fixture();
    const m = await boot(fake);
    assert.ok(m.text().includes("first message kept"));

    // Tail from index 1: m2 grew, m3 is new. m1 is not in the payload.
    await inAct(() =>
      fake.emitThread({
        ...detail({
          thread: row,
          messages: [msg("m2", "growing text done"), msg("m3", "brand new")],
        }),
        messagesFrom: 1,
        workLogFrom: 0,
      }),
    );
    await m.flush();

    const text = m.text();
    assert.ok(text.includes("first message kept"), "prefix must survive");
    assert.ok(text.includes("growing text done"), "patched message must update");
    assert.ok(text.includes("brand new"), "appended message must render");
    m.unmount();
  });

  it("refetches when the push seq skips (dropped pushes on reconnect)", async () => {
    const { row, fake } = fixture();
    const m = await boot(fake);
    const patch = (seq: number) => ({
      ...detail({
        thread: row,
        messages: [msg("m2", `text ${seq}`)],
      }),
      messagesFrom: 1,
      workLogFrom: 0,
      seq,
    });

    await inAct(() => fake.emitThread(patch(1)));
    await m.flush();
    const before = fake.of("threads.get").length;

    // seq 2 never arrived: the message it patched could be stale in our copy.
    await inAct(() => fake.emitThread(patch(3)));
    await m.flush();
    assert.equal(fake.of("threads.get").length, before + 1);
    m.unmount();
  });

  it("refetches the full detail when a tail starts past what we hold", async () => {
    const { row, fake } = fixture();
    const m = await boot(fake);
    const before = fake.of("threads.get").length;

    await inAct(() =>
      fake.emitThread({
        ...detail({ thread: row, messages: [msg("m9", "way ahead")] }),
        messagesFrom: 7,
        workLogFrom: 0,
      }),
    );
    await m.flush();

    assert.equal(
      fake.of("threads.get").length,
      before + 1,
      "a hole must trigger exactly one full refetch",
    );
    assert.ok(
      m.text().includes("first message kept"),
      "the un-mergeable tail must not blank the transcript",
    );
    m.unmount();
  });
});

/**
 * threads:changed used to replace the whole list with cloned rows, so every
 * memo keyed on `threads` and every memo'd card reran (issue #617). applyThreads
 * now reconciles by value; these probes read the live list identity.
 */
function ThreadsProbe({ onThreads }: { onThreads: (rows: ThreadInfo[]) => void }) {
  const { threads } = useCoder();
  onThreads(threads);
  return <div data-thread-count={threads.length} />;
}

async function bootProbe(fake: FakeCoder, onThreads: (rows: ThreadInfo[]) => void) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<ThreadsProbe onThreads={onThreads} />);
  await m.flush();
  return m;
}

describe("applyThreads identity (#617)", () => {
  it("keeps row (and array) identity when threads:changed is a clone", async () => {
    const fake = createFakeCoder({
      threads: [
        thread({ id: "t1", title: "one" }),
        thread({ id: "t2", title: "two" }),
        thread({ id: "t3", title: "three" }),
      ],
    });
    let latest: ThreadInfo[] = [];
    const m = await bootProbe(fake, (rows) => {
      latest = rows;
    });
    const first = latest;
    assert.equal(first.length, 3);

    await inAct(() =>
      fake.emitThreads(JSON.parse(JSON.stringify(first)) as ThreadInfo[]),
    );
    await m.flush();

    assert.equal(latest, first, "no-op push must not allocate a new list");
    assert.equal(latest[0], first[0]);
    assert.equal(latest[1], first[1]);
    assert.equal(latest[2], first[2]);
    m.unmount();
  });

  it("replaces only the moved row on threads:changed", async () => {
    const fake = createFakeCoder({
      threads: [
        thread({ id: "t1", title: "one" }),
        thread({ id: "t2", title: "two" }),
        thread({ id: "t3", title: "three" }),
      ],
    });
    let latest: ThreadInfo[] = [];
    const m = await bootProbe(fake, (rows) => {
      latest = rows;
    });
    const first = latest;

    const cloned = JSON.parse(JSON.stringify(first)) as ThreadInfo[];
    cloned[1] = { ...cloned[1], title: "two-moved" };
    await inAct(() => fake.emitThreads(cloned));
    await m.flush();

    assert.notEqual(latest, first);
    assert.equal(latest[0], first[0], "unchanged rows keep identity");
    assert.notEqual(latest[1], first[1]);
    assert.equal(latest[1].title, "two-moved");
    assert.equal(latest[2], first[2]);
    m.unmount();
  });
});
