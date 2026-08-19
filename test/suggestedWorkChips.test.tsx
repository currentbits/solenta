/**
 * Suggested-work chip actions through real App + useCoder (#550).
 *
 * ThreadView already covers render + click wiring. This file pins the
 * App handlers: start = fork(worktree)+resolve(started)+startRun, file =
 * issues.create+resolve(filed), dismiss = resolve(dismissed). A startRun
 * failure must not leave the chip open (retry would fork again).
 *
 * Run: node --import=./test/support/render.mjs --test test/suggestedWorkChips.test.tsx
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
import type { ProviderInfo, ThreadInfo, WorkSuggestion } from "../src/shared/ipc";

const NOW = Date.now();

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

const CHIP: WorkSuggestion = {
  id: "s-1",
  title: "Fix flaky reconnect",
  prompt: "Pin the handshake before asserting ready.",
  status: "open",
  at: NOW,
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
    projectId: "p1",
    title: "decoy first thread",
    provider: "claude",
    updatedAt: NOW + 5000,
  });
}

function source(): ThreadInfo {
  return thread({
    id: "t-source-chip",
    projectId: "p1",
    title: "source chip thread",
    provider: "claude",
    suggestions: [CHIP],
    updatedAt: NOW + 1000,
  });
}

async function selectThread(
  m: Awaited<ReturnType<typeof mount>>,
  title: string,
) {
  const card = m.query(`button[aria-label="Select thread: ${title}"]`);
  assert.ok(card, `thread card for "${title}" must exist`);
  await m.click(card as HTMLElement);
  await m.flush();
}

function makeFake(
  over: {
    fail?: Record<string, Error>;
    issueCreate?: {
      ok: false;
      reason: string;
    };
  } = {},
) {
  const d = decoy();
  const s = source();
  return createFakeCoder({
    projects: [
      project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
    ],
    providers,
    threads: [d, s],
    details: {
      "t-decoy": detail({ thread: d }),
      "t-source-chip": detail({ thread: s }),
    },
    fail: over.fail,
    issueCreate: over.issueCreate,
  });
}

describe("App suggested-work chip wiring (issue #550)", () => {
  it("Start a thread forks with a worktree, resolves started, then starts the run", async () => {
    const fake = makeFake();
    const m = await boot(fake);
    await selectThread(m, "source chip thread");

    const start = m.query('[data-suggestion-action="start"]');
    assert.ok(start, "Start a thread button must exist");
    await m.click(start as HTMLElement);
    await m.flush();

    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1, "exactly one threads.fork");
    const forkArg = forks[0]!.args[0] as {
      threadId: string;
      worktree?: boolean;
    };
    assert.equal(forkArg.threadId, "t-source-chip");
    assert.equal(forkArg.worktree, true, "chip start must request a worktree");

    const resolved = fake.of("threads.resolveSuggestion");
    assert.equal(resolved.length, 1, "exactly one resolveSuggestion");
    const resolveArg = resolved[0]!.args[0] as {
      threadId: string;
      suggestionId: string;
      status: string;
      startedThreadId?: string;
    };
    assert.equal(resolveArg.threadId, "t-source-chip");
    assert.equal(resolveArg.suggestionId, "s-1");
    assert.equal(resolveArg.status, "started");
    assert.ok(
      resolveArg.startedThreadId,
      "startedThreadId is the new fork",
    );

    const starts = fake.of("runs.start");
    assert.equal(starts.length, 1, "exactly one runs.start");
    const startArg = starts[0]!.args[0] as {
      threadId: string;
      prompt: string;
    };
    assert.equal(startArg.threadId, resolveArg.startedThreadId);
    assert.equal(startArg.prompt, CHIP.prompt);

    const channels = fake.channels();
    const forkAt = channels.indexOf("threads.fork");
    const resolveAt = channels.indexOf("threads.resolveSuggestion");
    const startAt = channels.indexOf("runs.start");
    assert.ok(forkAt >= 0 && resolveAt > forkAt && startAt > resolveAt);

    m.unmount();
  });

  it("Start still resolves the chip when startRun fails", async () => {
    const fake = makeFake({
      fail: { "runs.start": new Error("cli missing") },
    });
    const m = await boot(fake);
    await selectThread(m, "source chip thread");

    await m.click(m.query('[data-suggestion-action="start"]') as HTMLElement);
    await m.flush();

    assert.equal(fake.of("threads.fork").length, 1);
    const resolved = fake.of("threads.resolveSuggestion");
    assert.equal(resolved.length, 1, "chip must not stay open after a fork");
    assert.equal(
      (resolved[0]!.args[0] as { status: string }).status,
      "started",
    );
    assert.equal(fake.of("runs.start").length, 1);

    m.unmount();
  });

  it("File on planboard creates an issue then resolves filed", async () => {
    const fake = makeFake();
    const m = await boot(fake);
    await selectThread(m, "source chip thread");

    const file = m.query('[data-suggestion-action="file"]');
    assert.ok(file, "File on planboard button must exist");
    await m.click(file as HTMLElement);
    await m.flush();

    const created = fake.of("issues.create");
    assert.equal(created.length, 1);
    const createArg = created[0]!.args[0] as {
      projectPath: string;
      title: string;
      body: string;
    };
    assert.equal(createArg.projectPath, "/tmp/one");
    assert.equal(createArg.title, CHIP.title);
    assert.ok(
      createArg.body.includes(CHIP.prompt),
      "issue body carries the self-contained prompt",
    );

    const resolved = fake.of("threads.resolveSuggestion");
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0]!.args[0], {
      threadId: "t-source-chip",
      suggestionId: "s-1",
      status: "filed",
      issueNumber: 1234,
    });

    m.unmount();
  });

  it("File leaves the chip open and toasts when create fails", async () => {
    const fake = makeFake({
      issueCreate: { ok: false, reason: "auth" },
    });
    const m = await boot(fake);
    await selectThread(m, "source chip thread");

    await m.click(m.query('[data-suggestion-action="file"]') as HTMLElement);
    await m.flush();

    assert.equal(fake.of("issues.create").length, 1);
    assert.equal(
      fake.of("threads.resolveSuggestion").length,
      0,
      "failed create must not resolve the chip",
    );
    assert.ok(
      m.text().includes("auth"),
      "in-band create failure surfaces as a toast",
    );

    m.unmount();
  });

  it("Dismiss resolves the chip and starts nothing", async () => {
    const fake = makeFake();
    const m = await boot(fake);
    await selectThread(m, "source chip thread");

    const dismiss = m.query('[data-suggestion-action="dismiss"]');
    assert.ok(dismiss, "Dismiss button must exist");
    await m.click(dismiss as HTMLElement);
    await m.flush();

    assert.equal(fake.of("threads.fork").length, 0);
    assert.equal(fake.of("issues.create").length, 0);
    assert.equal(fake.of("runs.start").length, 0);
    const resolved = fake.of("threads.resolveSuggestion");
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0]!.args[0], {
      threadId: "t-source-chip",
      suggestionId: "s-1",
      status: "dismissed",
    });

    m.unmount();
  });
});
