/**
 * Round 48 Retry turn: App-level wiring through real useCoder.startRun.
 *
 * Mounts the real App (not a Host that injects onSend). Clicking Retry turn
 * must hit runs.start with the LAST user message text — the same channel
 * Composer send uses. A local Host re-implementing onStartRun would pass
 * while App/useCoder stayed broken (ISSUES #50 / M7).
 *
 * Fixture discipline: interesting thread is not list index 0; last user
 * message is not the only message in the transcript.
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
import type { ChatMessage, ThreadDetail, ThreadInfo } from "../src/shared/ipc";

const NOW = Date.now();

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text" | "id">,
): ChatMessage {
  return {
    id: over.id,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? NOW,
    runId: over.runId ?? "run-1",
    tool: over.tool,
    fromNotice: over.fromNotice,
    attachments: over.attachments,
  };
}

/** Decoy first so boot selects something else; we re-select the target. */
function decoy(): ThreadInfo {
  return thread({
    id: "t-decoy",
    title: "decoy first thread",
    status: "idle",
    updatedAt: NOW + 5000,
  });
}

function failedTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-failed-retry",
    title: "failed retry target",
    status: "failed",
    sessionId: "sess-keep",
    updatedAt: NOW + 1000,
  });
  // TWO user messages; assert last, not first. Also assistant + error event.
  const d = detail({
    thread: row,
    messages: [
      msg({
        id: "m-u1",
        role: "user",
        text: "first prompt must NOT be re-sent",
        createdAt: NOW - 3000,
      }),
      msg({
        id: "m-a1",
        role: "assistant",
        text: "partial reply",
        createdAt: NOW - 2000,
      }),
      msg({
        id: "m-u2",
        role: "user",
        text: "fix the sidebar chip for PR freshness",
        createdAt: NOW - 1000,
      }),
      msg({
        id: "m-err",
        role: "event",
        text: "Run error: exit 1\nstderr tail",
        createdAt: NOW,
      }),
    ],
  });
  return { row, d };
}

function upgradeTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-cli-upgrade",
    title: "cli upgrade target",
    status: "failed",
    lastError: "This model needs a newer Codex. Run `codex update`, then send again.",
    lastErrorKind: "cli-upgrade",
    updatedAt: NOW + 2600,
  });
  return {
    row,
    d: detail({
      thread: row,
      messages: [
        msg({ id: "m-uu", role: "user", text: "use sol" }),
        msg({
          id: "m-ue",
          role: "event",
          text: "This model needs a newer Codex. Run `codex update`, then send again.",
        }),
      ],
    }),
  };
}

function writerLockTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-writer-lock",
    title: "writer lock target",
    status: "failed",
    lastError:
      "Codex session is locked by another process. Quit Codex Desktop and any other codex using this thread, then send again. Retry will keep failing until that writer is gone. Do not delete sessions.",
    lastErrorKind: "writer-lock",
    sessionId: "codex-sess-001",
    updatedAt: NOW + 2700,
  });
  return {
    row,
    d: detail({
      thread: row,
      messages: [
        msg({ id: "m-wu", role: "user", text: "keep going on the locked thread" }),
        msg({
          id: "m-we",
          role: "event",
          text:
            "Codex session is locked by another process. Quit Codex Desktop and any other codex using this thread, then send again. Retry will keep failing until that writer is gone. Do not delete sessions.\n" +
            "Provider error: thread-store conflict: thread already has an active writer",
        }),
      ],
    }),
  };
}

function overflowTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-context-overflow",
    title: "context overflow target",
    status: "failed",
    lastError: "Context window is full.",
    lastErrorKind: "context-overflow",
    updatedAt: NOW + 2500,
  });
  return {
    row,
    d: detail({
      thread: row,
      messages: [
        msg({ id: "m-ou", role: "user", text: "large prompt" }),
        msg({
          id: "m-oe",
          role: "event",
          text: "Context window is full. Fork to fresh context or rewind the last turn.",
        }),
      ],
    }),
  };
}

function interruptTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-interrupt-retry",
    title: "interrupt retry target",
    status: "idle",
    sessionId: "sess-int",
    updatedAt: NOW + 2000,
  });
  const d = detail({
    thread: row,
    messages: [
      msg({
        id: "m-iu1",
        role: "user",
        text: "older interrupt turn",
        createdAt: NOW - 2000,
      }),
      msg({
        id: "m-ia1",
        role: "assistant",
        text: "working on it",
        createdAt: NOW - 1500,
      }),
      msg({
        id: "m-iu2",
        role: "user",
        text: "continue after quit please",
        createdAt: NOW - 500,
      }),
      msg({
        id: "m-ievt",
        role: "event",
        text: "Run interrupted by app quit",
        createdAt: NOW,
      }),
    ],
  });
  return { row, d };
}

function workingTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-working-no-retry",
    title: "working no retry",
    status: "working",
    updatedAt: NOW + 3000,
  });
  // B-2: last message is a LIVE interrupt marker. Without the working
  // guard this would still show Retry turn (other branches pass).
  const d = detail({
    thread: row,
    messages: [
      msg({ id: "mw1", role: "user", text: "busy prompt after interrupt" }),
      msg({
        id: "mw2",
        role: "event",
        text: "Run interrupted by app quit",
        createdAt: NOW,
      }),
    ],
  });
  return { row, d };
}

const NOTICE_FOOTER =
  "Continue orchestrating; thread_status has full details.";

function orchNotice(workerId = "w-1"): string {
  return (
    `[orchestration] Worker thread ${workerId} ("backend") finished with status done. Last reply: API is in contract.md\n` +
    NOTICE_FOOTER
  );
}

function undeliverableNoticeTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-undeliverable-notice",
    title: "undeliverable notice retry",
    status: "failed",
    lastError: "Not delivered: Daily budget reached",
    updatedAt: NOW + 1700,
  });
  const notice = orchNotice("w-budget");
  const d = detail({
    thread: row,
    messages: [
      msg({
        id: "m-orig",
        role: "user",
        text: "look at the app",
        createdAt: NOW - 3000,
      }),
      msg({
        id: "m-asst",
        role: "assistant",
        text: "forked a worker",
        createdAt: NOW - 2000,
      }),
      msg({
        id: "m-err",
        role: "event",
        text: `${notice}\n\nNot delivered: Daily budget reached ($1.00 of $1.00). Raise or clear the cap in Settings.`,
        createdAt: NOW,
      }),
    ],
  });
  return { row, d };
}

function failedFromNoticeTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-failed-fromnotice",
    title: "failed fromNotice retry",
    status: "failed",
    sessionId: "sess-locked",
    lastError: "Run error: exit 1",
    updatedAt: NOW + 1750,
  });
  const notice = orchNotice("w-lock");
  const d = detail({
    thread: row,
    messages: [
      msg({
        id: "m-orig",
        role: "user",
        text: "look at the app",
        createdAt: NOW - 4000,
      }),
      msg({
        id: "m-asst",
        role: "assistant",
        text: "forked a worker",
        createdAt: NOW - 3000,
      }),
      msg({
        id: "m-notice",
        role: "user",
        text: notice,
        createdAt: NOW - 1000,
      }),
      msg({
        id: "m-err",
        role: "event",
        text: "Run error: exit 1\nthread-store already has an active writer",
        createdAt: NOW,
      }),
    ],
  });
  return { row, d };
}

function laterHumanAfterNoticeTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-later-human",
    title: "later human after notice",
    status: "failed",
    updatedAt: NOW + 1780,
  });
  const d = detail({
    thread: row,
    messages: [
      msg({ id: "m-orig", role: "user", text: "look at the app" }),
      msg({ id: "m-notice", role: "user", text: orchNotice() }),
      msg({ id: "m-asst", role: "assistant", text: "continued" }),
      msg({
        id: "m-human",
        role: "user",
        text: "now fix the sidebar chip",
      }),
      msg({
        id: "m-err",
        role: "event",
        text: "Run error: exit 1",
      }),
    ],
  });
  return { row, d };
}

function noUserTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-no-user",
    title: "failed without user",
    status: "failed",
    updatedAt: NOW + 1500,
  });
  const d = detail({
    thread: row,
    messages: [
      msg({ id: "ne1", role: "event", text: "Run error: no user ever" }),
      msg({ id: "na1", role: "assistant", text: "orphan assistant" }),
    ],
  });
  return { row, d };
}

async function selectThread(
  m: Awaited<ReturnType<typeof mount>>,
  title: string,
) {
  // aria-label may carry ", unread" / ", failed" suffixes (#566).
  const card = m.query(`button[aria-label^="Select thread: ${title}"]`);
  assert.ok(card, `thread card for "${title}" must exist`);
  await m.click(card as HTMLElement);
  await m.flush();
}

function retryButtons(m: Awaited<ReturnType<typeof mount>>): HTMLElement[] {
  return m
    .queryAll("button")
    .filter((b) => (b.textContent || "").trim() === "Retry turn");
}

describe("App Retry turn wiring (round 48)", () => {
  it("context overflow offers Fork to fresh context instead of retry", async () => {
    const decoyRow = decoy();
    const { row, d } = overflowTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-context-overflow": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "context overflow target");

    assert.equal(retryButtons(m).length, 0);
    const fork = m
      .queryAll("button")
      .find((button) => button.textContent?.trim() === "Fork to fresh context");
    assert.ok(fork);

    const runsBefore = fake.of("runs.start").length;
    await m.click(fork);
    await m.flush();
    assert.equal(fake.of("runs.start").length, runsBefore);
    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1);
    assert.deepEqual(forks[0].args[0], { threadId: "t-context-overflow" });
    m.unmount();
  });

  it("cli-upgrade offers Upgrade Codex instead of retry and copies the command", async () => {
    const writes: string[] = [];
    const clipboard = {
      writeText: async (text: string) => {
        writes.push(text);
      },
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });

    const decoyRow = decoy();
    const { row, d } = upgradeTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-cli-upgrade": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "cli upgrade target");

    assert.equal(retryButtons(m).length, 0);
    const upgrade = m
      .queryAll("button")
      .find((button) => button.textContent?.trim() === "Upgrade Codex");
    assert.ok(upgrade);

    const runsBefore = fake.of("runs.start").length;
    await m.click(upgrade);
    await m.flush();
    assert.equal(fake.of("runs.start").length, runsBefore);
    assert.deepEqual(writes, ["codex update"]);
    m.unmount();
  });

  it("writer-lock offers no Retry, Fork, or Upgrade Codex", async () => {
    const decoyRow = decoy();
    const { row, d } = writerLockTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-writer-lock": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "writer lock target");

    assert.equal(retryButtons(m).length, 0);
    const fork = m
      .queryAll("button")
      .find((button) => button.textContent?.trim() === "Fork to fresh context");
    assert.equal(fork, undefined);
    const upgrade = m
      .queryAll("button")
      .find((button) => button.textContent?.trim() === "Upgrade Codex");
    assert.equal(upgrade, undefined);
    assert.equal(fake.of("runs.start").length, 0);
    m.unmount();
  });

  it("failed thread with transcript renders Retry turn; click sends LAST user text once", async () => {
    const decoyRow = decoy();
    const { row, d } = failedTarget();
    const fake = createFakeCoder({
      projects: [project()],
      // Interesting thread NOT first.
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-failed-retry": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "failed retry target");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1, "exactly one Retry turn button on failed");
    const title = btns[0]!.getAttribute("title") || "";
    assert.ok(
      title.startsWith("Retry: "),
      `title must carry preview, got: ${title}`,
    );
    assert.ok(
      title.includes("fix the sidebar chip"),
      `title must preview LAST user message, got: ${title}`,
    );
    assert.ok(
      !title.includes("first prompt"),
      "title must not preview the first user message",
    );

    const before = fake.of("runs.start").length;
    await m.click(btns[0]!);
    await m.flush();

    const starts = fake.of("runs.start");
    assert.equal(
      starts.length,
      before + 1,
      "click must record exactly ONE runs.start",
    );
    const arg = starts[starts.length - 1]!.args[0] as {
      threadId: string;
      prompt: string;
    };
    assert.equal(arg.threadId, "t-failed-retry");
    assert.equal(
      arg.prompt,
      "fix the sidebar chip for PR freshness",
      "must re-send LAST user message, not the first",
    );
    m.unmount();
  });

  it("interruption-event thread (idle + Run interrupted by app quit) renders and works", async () => {
    const decoyRow = decoy();
    const { row, d } = interruptTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-interrupt-retry": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "interrupt retry target");

    const btns = retryButtons(m);
    assert.equal(
      btns.length,
      1,
      "Retry turn must show for interruption event while idle",
    );
    assert.ok(
      (btns[0]!.getAttribute("title") || "").includes(
        "continue after quit please",
      ),
    );

    const before = fake.of("runs.start").length;
    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, before + 1);
    const arg = starts[starts.length - 1]!.args[0] as {
      threadId: string;
      prompt: string;
    };
    assert.equal(arg.threadId, "t-interrupt-retry");
    assert.equal(arg.prompt, "continue after quit please");
    m.unmount();
  });

  it("working thread with live interrupt last does not render Retry turn", async () => {
    const decoyRow = decoy();
    const { row, d } = workingTarget();
    // Prefer working on boot — but still not index 0 only: put decoy first,
    // then select the working one so we assert absence on THAT surface.
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-working-no-retry": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "working no retry");
    assert.equal(
      retryButtons(m).length,
      0,
      "Retry turn must be absent while a run is active (even with live interrupt)",
    );
    m.unmount();
  });

  it("failed thread with no user message does not render Retry turn", async () => {
    const decoyRow = decoy();
    const { row, d } = noUserTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-no-user": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "failed without user");
    assert.equal(
      retryButtons(m).length,
      0,
      "Retry turn must be absent without a user message to re-send",
    );
    m.unmount();
  });

  it("round-trip: interrupt → retry → run completes → button gone", async () => {
    const decoyRow = decoy();
    const { row, d } = interruptTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-interrupt-retry": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "interrupt retry target");
    assert.equal(retryButtons(m).length, 1, "button present on interrupt");

    await m.click(retryButtons(m)[0]!);
    await m.flush();
    assert.equal(
      fake.of("runs.start").length >= 1,
      true,
      "retry must hit runs.start",
    );

    // Successful retry: status done; interrupt is mid-transcript; no new event.
    // Stale last-event anchor would keep the button; last-message must clear it.
    const completed: ThreadDetail = detail({
      thread: thread({
        ...row,
        status: "done",
        updatedAt: NOW + 9000,
      }),
      messages: [
        ...d.messages,
        msg({
          id: "m-retry-user",
          role: "user",
          text: "continue after quit please",
          createdAt: NOW + 100,
        }),
        msg({
          id: "m-retry-asst",
          role: "assistant",
          text: "picked up where we left off",
          createdAt: NOW + 200,
        }),
      ],
    });
    await inAct(() => fake.emitThread(completed));
    await m.flush();

    assert.equal(
      retryButtons(m).length,
      0,
      "after successful completion, stale interrupt must not keep Retry turn",
    );
    m.unmount();
  });

  it("failed Build last-run Retry turn calls retryWorkflowAgent, not start or startWorkflow", async () => {
    const decoyRow = decoy();
    const wfId = "wf-run-failed";
    const row = thread({
      id: "t-wf-failed",
      title: "failed workflow retry target",
      status: "failed",
      updatedAt: NOW + 1800,
    });
    const d = detail({
      thread: row,
      workflow: {
        id: wfId,
        name: "WF-test",
        phases: [
          {
            name: "plan",
            pipelined: false,
            agents: [
              {
                id: "plan-1",
                model: "grok",
                status: "failed",
                tokensUsed: 0,
              },
            ],
          },
        ],
        settled: 0,
        total: 1,
        tokensTotal: 0,
        complete: false,
      },
      messages: [
        msg({
          id: "m-wf-u",
          role: "user",
          text: "build the login form",
          runId: wfId,
        }),
        msg({
          id: "m-wf-kick",
          role: "event",
          text: "Kicked off 1 subagents\nplan 1",
          runId: wfId,
        }),
        msg({
          id: "m-wf-err",
          role: "event",
          text: "Run error (plan-1):\nbad spawn",
          runId: wfId,
        }),
      ],
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-wf-failed": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "failed workflow retry target");

    const btns = retryButtons(m);
    assert.equal(
      btns.length,
      1,
      "Retry turn must stay on a failed workflow last-run so it can route to the slot",
    );
    await m.click(btns[0]!);
    await m.flush();

    assert.equal(fake.of("runs.start").length, 0, "must not start a chat turn");
    assert.equal(
      fake.of("runs.startWorkflow").length,
      0,
      "must not restart the whole pipeline",
    );
    const retries = fake.of("runs.retryWorkflowAgent");
    assert.equal(retries.length, 1, "click must hit runs.retryWorkflowAgent once");
    assert.deepEqual(retries[0]!.args[0], {
      threadId: "t-wf-failed",
      agentId: "plan-1",
    });
    m.unmount();
  });

  it("several failed slots Retry turn picks the first in Agents-panel order", async () => {
    const decoyRow = decoy();
    const wfId = "wf-run-multi";
    const row = thread({
      id: "t-wf-multi",
      title: "multi fail workflow retry",
      status: "failed",
      updatedAt: NOW + 1850,
    });
    const d = detail({
      thread: row,
      workflow: {
        id: wfId,
        name: "WF-multi",
        phases: [
          {
            name: "plan",
            pipelined: false,
            agents: [
              { id: "plan-1", model: "grok", status: "settled", tokensUsed: 4 },
              { id: "plan-2", model: "grok", status: "failed", tokensUsed: 0 },
            ],
          },
          {
            name: "build",
            pipelined: false,
            agents: [
              { id: "build-1", model: "grok", status: "failed", tokensUsed: 0 },
            ],
          },
        ],
        settled: 1,
        total: 3,
        tokensTotal: 4,
        complete: false,
      },
      messages: [
        msg({
          id: "m-mu",
          role: "user",
          text: "build with two failed slots",
          runId: wfId,
        }),
        msg({
          id: "m-me",
          role: "event",
          text: "Run error (plan-2):\nbad spawn",
          runId: wfId,
        }),
      ],
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-wf-multi": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "multi fail workflow retry");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1);
    await m.click(btns[0]!);
    await m.flush();

    const retries = fake.of("runs.retryWorkflowAgent");
    assert.equal(retries.length, 1);
    const arg = retries[0]!.args[0] as { agentId: string };
    assert.equal(arg.agentId, "plan-2", "first failed slot in panel order");
    assert.equal(fake.of("runs.start").length, 0);
    assert.equal(fake.of("runs.startWorkflow").length, 0);
    m.unmount();
  });

  it("undeliverable notice Retry re-sends the notice with fromNotice, not the original task", async () => {
    const decoyRow = decoy();
    const { row, d } = undeliverableNoticeTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-undeliverable-notice": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "undeliverable notice retry");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1);
    const title = btns[0]!.getAttribute("title") || "";
    assert.equal(title, "Retry: continue orchestrating");
    assert.ok(!title.includes("look at the app"));

    const before = fake.of("runs.start").length;
    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, before + 1);
    const arg = starts[starts.length - 1]!.args[0] as {
      threadId: string;
      prompt: string;
      fromNotice?: boolean;
    };
    assert.equal(arg.threadId, "t-undeliverable-notice");
    assert.equal(arg.prompt, orchNotice("w-budget"));
    assert.equal(arg.fromNotice, true);
    m.unmount();
  });

  it("failed fromNotice spawn Retry re-delivers the notice once as fromNotice", async () => {
    const decoyRow = decoy();
    const { row, d } = failedFromNoticeTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-failed-fromnotice": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "failed fromNotice retry");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1);
    assert.equal(
      btns[0]!.getAttribute("title"),
      "Retry: continue orchestrating",
    );

    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, 1);
    const arg = starts[0]!.args[0] as {
      threadId: string;
      prompt: string;
      fromNotice?: boolean;
    };
    assert.equal(arg.threadId, "t-failed-fromnotice");
    assert.equal(arg.prompt, orchNotice("w-lock"));
    assert.equal(arg.fromNotice, true);
    m.unmount();
  });

  it("a later human prompt after a notice still retries that human prompt", async () => {
    const decoyRow = decoy();
    const { row, d } = laterHumanAfterNoticeTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-later-human": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "later human after notice");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1);
    const title = btns[0]!.getAttribute("title") || "";
    assert.ok(title.includes("now fix the sidebar chip"));
    assert.ok(!title.includes("continue orchestrating"));

    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, 1);
    const arg = starts[0]!.args[0] as {
      prompt: string;
      fromNotice?: boolean;
    };
    assert.equal(arg.prompt, "now fix the sidebar chip");
    assert.equal(arg.fromNotice, undefined);
    m.unmount();
  });

  it("leftover workflow plus a later failed chat turn still calls runs.start", async () => {
    const decoyRow = decoy();
    const row = thread({
      id: "t-wf-then-chat",
      title: "leftover workflow then chat fail",
      status: "failed",
      updatedAt: NOW + 1900,
    });
    const d = detail({
      thread: row,
      workflow: {
        id: "wf-old",
        name: "WF-old",
        phases: [
          {
            name: "plan",
            pipelined: false,
            agents: [
              { id: "plan-1", model: "grok", status: "settled", tokensUsed: 10 },
            ],
          },
        ],
        settled: 1,
        total: 1,
        tokensTotal: 10,
        complete: true,
      },
      messages: [
        msg({
          id: "m-old-u",
          role: "user",
          text: "older build prompt",
          runId: "wf-old",
        }),
        msg({
          id: "m-old-kick",
          role: "event",
          text: "Kicked off 1 subagents\nplan 1",
          runId: "wf-old",
        }),
        msg({
          id: "m-chat-u",
          role: "user",
          text: "later chat after the build",
          runId: "chat-2",
        }),
        msg({
          id: "m-chat-err",
          role: "event",
          text: "Run error: exit 1",
          runId: "chat-2",
        }),
      ],
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-wf-then-chat": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "leftover workflow then chat fail");

    const btns = retryButtons(m);
    assert.equal(
      btns.length,
      1,
      "leftover workflow must not hide Retry turn for a later chat failure",
    );
    const before = fake.of("runs.start").length;
    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, before + 1);
    const arg = starts[starts.length - 1]!.args[0] as {
      threadId: string;
      prompt: string;
    };
    assert.equal(arg.threadId, "t-wf-then-chat");
    assert.equal(arg.prompt, "later chat after the build");
    assert.equal(fake.of("runs.retryWorkflowAgent").length, 0);
    m.unmount();
  });
});

/**
 * Deliberately not the live noticePrompt footer. Wiring must follow the
 * persisted fromNotice flag (#955), not that string.
 */
const RENAMED_FOOTER = "Continue the crew; see thread_status for details.";

function renamedNotice(workerId = "w-1"): string {
  return (
    `[orchestration] Worker thread ${workerId} ("backend") finished with status done. Last reply: API is in contract.md\n` +
    RENAMED_FOOTER
  );
}

function undeliverableNoticeTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-undeliverable-notice",
    title: "undeliverable notice retry",
    status: "failed",
    lastError: "Not delivered: Daily budget reached",
    updatedAt: NOW + 1700,
  });
  const notice = renamedNotice("w-budget");
  const d = detail({
    thread: row,
    messages: [
      msg({
        id: "m-orig",
        role: "user",
        text: "look at the app",
        createdAt: NOW - 3000,
      }),
      msg({
        id: "m-asst",
        role: "assistant",
        text: "forked a worker",
        createdAt: NOW - 2000,
      }),
      msg({
        id: "m-err",
        role: "event",
        text: `${notice}\n\nNot delivered: Daily budget reached ($1.00 of $1.00). Raise or clear the cap in Settings.`,
        createdAt: NOW,
        fromNotice: true,
      }),
    ],
  });
  return { row, d };
}

function failedFromNoticeTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-failed-fromnotice",
    title: "failed fromNotice retry",
    status: "failed",
    sessionId: "sess-locked",
    lastError: "Run error: exit 1",
    updatedAt: NOW + 1750,
  });
  const notice = renamedNotice("w-lock");
  const d = detail({
    thread: row,
    messages: [
      msg({
        id: "m-orig",
        role: "user",
        text: "look at the app",
        createdAt: NOW - 4000,
      }),
      msg({
        id: "m-asst",
        role: "assistant",
        text: "forked a worker",
        createdAt: NOW - 3000,
      }),
      msg({
        id: "m-notice",
        role: "user",
        text: notice,
        createdAt: NOW - 1000,
        fromNotice: true,
      }),
      msg({
        id: "m-err",
        role: "event",
        text: "Run error: exit 1\nthread-store already has an active writer",
        createdAt: NOW,
      }),
    ],
  });
  return { row, d };
}

function laterHumanAfterNoticeTarget(): { row: ThreadInfo; d: ThreadDetail } {
  const row = thread({
    id: "t-later-human",
    title: "later human after notice",
    status: "failed",
    updatedAt: NOW + 1780,
  });
  const d = detail({
    thread: row,
    messages: [
      msg({ id: "m-orig", role: "user", text: "look at the app" }),
      msg({
        id: "m-notice",
        role: "user",
        text: renamedNotice(),
        fromNotice: true,
      }),
      msg({ id: "m-asst", role: "assistant", text: "continued" }),
      msg({
        id: "m-human",
        role: "user",
        text: "now fix the sidebar chip",
      }),
      msg({
        id: "m-err",
        role: "event",
        text: "Run error: exit 1",
      }),
    ],
  });
  return { row, d };
}

describe("App Retry turn fromNotice flag (#955)", () => {
  it("undeliverable notice Retry re-sends the parked prompt with fromNotice even if the footer was renamed", async () => {
    const decoyRow = decoy();
    const { row, d } = undeliverableNoticeTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-undeliverable-notice": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "undeliverable notice retry");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1);
    const title = btns[0]!.getAttribute("title") || "";
    assert.equal(title, "Retry: continue orchestrating");
    assert.ok(!title.includes("look at the app"));

    const before = fake.of("runs.start").length;
    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, before + 1);
    const arg = starts[starts.length - 1]!.args[0] as {
      threadId: string;
      prompt: string;
      fromNotice?: boolean;
    };
    assert.equal(arg.threadId, "t-undeliverable-notice");
    assert.equal(arg.prompt, renamedNotice("w-budget"));
    assert.equal(arg.fromNotice, true);
    m.unmount();
  });

  it("failed fromNotice spawn Retry re-delivers the notice once as fromNotice", async () => {
    const decoyRow = decoy();
    const { row, d } = failedFromNoticeTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-failed-fromnotice": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "failed fromNotice retry");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1);
    assert.equal(
      btns[0]!.getAttribute("title"),
      "Retry: continue orchestrating",
    );

    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, 1);
    const arg = starts[0]!.args[0] as {
      threadId: string;
      prompt: string;
      fromNotice?: boolean;
    };
    assert.equal(arg.threadId, "t-failed-fromnotice");
    assert.equal(arg.prompt, renamedNotice("w-lock"));
    assert.equal(arg.fromNotice, true);
    m.unmount();
  });

  it("a later human prompt after a notice still retries that human prompt", async () => {
    const decoyRow = decoy();
    const { row, d } = laterHumanAfterNoticeTarget();
    const fake = createFakeCoder({
      projects: [project()],
      threads: [decoyRow, row],
      details: {
        "t-decoy": detail({ thread: decoyRow }),
        "t-later-human": d,
      },
    });
    const m = await boot(fake);
    await selectThread(m, "later human after notice");

    const btns = retryButtons(m);
    assert.equal(btns.length, 1);
    const title = btns[0]!.getAttribute("title") || "";
    assert.ok(title.includes("now fix the sidebar chip"));
    assert.ok(!title.includes("continue orchestrating"));

    await m.click(btns[0]!);
    await m.flush();
    const starts = fake.of("runs.start");
    assert.equal(starts.length, 1);
    const arg = starts[0]!.args[0] as {
      prompt: string;
      fromNotice?: boolean;
    };
    assert.equal(arg.prompt, "now fix the sidebar chip");
    assert.equal(arg.fromNotice, undefined);
    m.unmount();
  });
});
