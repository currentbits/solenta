/**
 * Issue #156 live-turn steering, wired through the real App + useCoder.
 *
 * Composer.runAction clears the draft after onSend resolves. useCoder.startRun
 * must throw when a steer (or its queue fallback) is not delivered, and must
 * NOT throw — and must NOT queue — after a delivered steer whose threads.get
 * refresh fails.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/steerFollowup.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import { setComposerBusyAction } from "../src/uiPrefs";
import App from "../src/App";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const NOW = Date.now();

const CLAUDE: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  available: true,
  supportsResume: true,
  supportsSteer: true,
  models: [],
  modelInfo: [],
  efforts: [],
};

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

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
    provider: "claude",
    runStartedAt: NOW,
    updatedAt: NOW + 1000,
  });
}

async function bootOnBusyThread(fail: Record<string, Error> = {}) {
  const busy = working();
  const fake = createFakeCoder({
    projects: [project()],
    threads: [decoy(), busy],
    details: {
      "t-decoy": detail({ thread: decoy() }),
      "t-busy": detail({ thread: busy }),
    },
    providers: [CLAUDE],
    fail,
  });
  const m = await boot(fake);
  const card = m.query(
    'button[aria-label^="Select thread: busy target thread"]',
  );
  assert.ok(card, "busy thread card must exist");
  await m.click(card);
  await m.flush();
  return { fake, m, busy, fail };
}

async function steerDraft(
  m: Awaited<ReturnType<typeof mount>>,
  text: string,
) {
  const steer = m.query('[data-steer-action="steer"]') as HTMLButtonElement;
  assert.ok(steer, "Steer must be offered on a live Claude turn");
  await m.click(steer);
  const ta = m.query("textarea") as HTMLTextAreaElement;
  await m.type(ta, text);
  await m.click(m.query('button[aria-label="Send"]') as HTMLButtonElement);
  await m.flush();
  return ta;
}

afterEach(() => {
  unmountAll();
  setComposerBusyAction("queue");
});

describe("steer follow-up draft retention (issue #156)", () => {
  it("clears the draft after a successful steer", async () => {
    const { fake, m } = await bootOnBusyThread();
    const ta = await steerDraft(m, "stop that, do X instead");

    const steers = fake.of("runs.steer");
    assert.equal(steers.length, 1, "Send in Steer mode must hit runs.steer");
    assert.equal(
      (steers[0]!.args[0] as { prompt: string }).prompt,
      "stop that, do X instead",
    );
    assert.equal(fake.of("threads.setQueued").length, 0);
    assert.equal(ta.value, "", "delivered steer must clear the composer");
  });

  it("keeps the draft when runs.steer rejects", async () => {
    const { fake, m } = await bootOnBusyThread({
      "runs.steer": new Error("Claude Code cannot steer a live turn"),
    });
    const ta = await steerDraft(m, "keep this guidance");

    assert.equal(fake.of("runs.steer").length, 1);
    assert.equal(
      fake.of("threads.setQueued").length,
      0,
      "a hard steer reject must not become a queued follow-up",
    );
    assert.equal(
      ta.value,
      "keep this guidance",
      "undelivered steer must leave the draft in the composer",
    );
  });

  it("keeps the draft when steer falls back to queue and setQueued rejects", async () => {
    const { fake, m } = await bootOnBusyThread({
      "runs.steer": new Error("No live run to steer"),
      "threads.setQueued": new Error("queue write failed"),
    });
    const ta = await steerDraft(m, "queue this if the turn landed");

    assert.equal(fake.of("runs.steer").length, 1);
    assert.equal(fake.of("threads.setQueued").length, 1);
    assert.equal(
      ta.value,
      "queue this if the turn landed",
      "failed queue fallback must leave the draft in the composer",
    );
  });

  it("does not re-queue after a delivered steer whose threads.get refresh fails", async () => {
    const fail: Record<string, Error> = {};
    const { fake, m } = await bootOnBusyThread(fail);
    fail["threads.get"] = new Error("refresh boom");
    const ta = await steerDraft(m, "already injected");

    assert.equal(fake.of("runs.steer").length, 1);
    assert.equal(
      fake.of("threads.setQueued").length,
      0,
      "a delivered steer must not retry as a queued follow-up",
    );
    assert.equal(
      ta.value,
      "",
      "delivered steer still clears the draft even if refresh fails",
    );
  });
});
