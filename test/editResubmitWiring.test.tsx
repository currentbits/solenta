/**
 * Issue #254 edit-and-resubmit: App-level wiring through real
 * useCoder.rewindAndResubmit → threads.rewind then startRun.
 *
 * Mounts the real App (not a Host that injects onSend). Confirming an
 * edited past message must hit threads.rewind first, then runs.start
 * with the edited text — the same channel Composer send uses. Cancel
 * must call neither.
 *
 * Fixture discipline: interesting thread is not list index 0; the
 * edited message is not the last user message.
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
  };
}

function decoy(): ThreadInfo {
  return thread({
    id: "t-decoy",
    title: "decoy first thread",
    status: "idle",
    updatedAt: NOW + 5000,
  });
}

function target(over: Partial<ThreadInfo> = {}): {
  row: ThreadInfo;
  d: ThreadDetail;
} {
  const row = thread({
    id: "t-edit-resubmit",
    title: "edit resubmit target",
    status: "idle",
    sessionId: "sess-keep",
    updatedAt: NOW + 1000,
    ...over,
  });
  const d = detail({
    thread: row,
    messages: [
      msg({
        id: "m-u1",
        role: "user",
        text: "first prompt ORIGINAL",
        createdAt: NOW - 4000,
      }),
      msg({
        id: "m-a1",
        role: "assistant",
        text: "partial reply",
        createdAt: NOW - 3000,
      }),
      msg({
        id: "m-u2",
        role: "user",
        text: "second prompt must NOT be the edit target",
        createdAt: NOW - 2000,
      }),
      msg({
        id: "m-a2",
        role: "assistant",
        text: "later reply",
        createdAt: NOW - 1000,
      }),
    ],
  });
  return { row, d };
}

async function selectThread(
  m: Awaited<ReturnType<typeof mount>>,
  title: string,
) {
  // aria-label may carry ", unread" / ", working" suffixes (#566).
  const card = m.query(`button[aria-label^="Select thread: ${title}"]`);
  assert.ok(card, `thread card for "${title}" must exist`);
  await m.click(card as HTMLElement);
  await m.flush();
}

function makeFake(row: ThreadInfo, d: ThreadDetail, fail?: Record<string, Error>) {
  const decoyRow = decoy();
  return createFakeCoder({
    projects: [project()],
    threads: [decoyRow, row],
    details: {
      "t-decoy": detail({ thread: decoyRow }),
      [row.id]: d,
    },
    fail,
  });
}

describe("App edit-and-resubmit wiring (issue #254)", () => {
  it("edit → confirm → threads.rewind then runs.start with the edited prompt", async () => {
    const { row, d } = target();
    const fake = makeFake(row, d);
    const m = await boot(fake);
    await selectThread(m, "edit resubmit target");

    const editBtn = m.query('[data-edit-message="m-u1"]');
    assert.ok(editBtn, "edit affordance on the first user message");
    assert.equal(editBtn!.getAttribute("aria-label"), "Edit and resubmit");
    await m.click(editBtn as HTMLElement);
    await m.flush();

    const ta = m.query('[data-edit-textarea="m-u1"]') as HTMLTextAreaElement | null;
    assert.ok(ta, "inline editor opens");
    assert.equal(ta!.value, "first prompt ORIGINAL", "editor prefills original");
    assert.equal(document.activeElement, ta, "textarea focused on open");

    await m.type(ta, "first prompt EDITED");
    await m.click(m.query('[data-edit-resubmit="m-u1"]') as HTMLElement);
    await m.flush();

    const dialog = m.query('[data-rewind-confirm="m-u1"]');
    assert.ok(dialog, "confirm dialog open");
    const copy = dialog!.textContent || "";
    assert.ok(
      copy.includes("4 messages"),
      `confirm names dropped count, got: ${copy}`,
    );
    assert.equal(
      m.queryAll("[data-rewind-restore-files]").length,
      0,
      "no restore-files checkbox without a worktree",
    );

    await m.click(m.query("[data-rewind-confirm-submit]") as HTMLElement);
    await m.flush();

    const rewinds = fake.of("threads.rewind");
    const starts = fake.of("runs.start");
    assert.equal(rewinds.length, 1, "rewind once");
    assert.equal(starts.length, 1, "start once");
    const rewindAt = fake.calls.findIndex((c) => c.channel === "threads.rewind");
    const startAt = fake.calls.findIndex((c) => c.channel === "runs.start");
    assert.ok(
      rewindAt >= 0 && startAt > rewindAt,
      `rewind must precede start, order: ${fake.channels().join(",")}`,
    );
    const rewindArg = rewinds[0]!.args[0] as {
      threadId: string;
      messageId: string;
      prompt: string;
      restoreFiles?: boolean;
    };
    assert.equal(rewindArg.threadId, "t-edit-resubmit");
    assert.equal(rewindArg.messageId, "m-u1");
    assert.equal(rewindArg.prompt, "first prompt EDITED");
    assert.ok(
      !rewindArg.restoreFiles,
      "transcript-only rewind is the default",
    );
    const startArg = starts[0]!.args[0] as {
      threadId: string;
      prompt: string;
    };
    assert.equal(startArg.threadId, "t-edit-resubmit");
    assert.equal(startArg.prompt, "first prompt EDITED");
    m.unmount();
  });

  it("resubmit carries the original message's attachments", async () => {
    const { row, d } = target();
    d.messages[0]!.attachments = [
      { kind: "image", path: "/tmp/shot.png", name: "shot.png" },
    ];
    const fake = makeFake(row, d);
    const m = await boot(fake);
    await selectThread(m, "edit resubmit target");

    await m.click(m.query('[data-edit-message="m-u1"]') as HTMLElement);
    await m.flush();
    await m.type(
      m.query('[data-edit-textarea="m-u1"]') as HTMLTextAreaElement,
      "same image, better words",
    );
    await m.click(m.query('[data-edit-resubmit="m-u1"]') as HTMLElement);
    await m.flush();
    await m.click(m.query("[data-rewind-confirm-submit]") as HTMLElement);
    await m.flush();

    const startArg = fake.of("runs.start")[0]!.args[0] as {
      prompt: string;
      attachments?: { path: string }[];
    };
    assert.equal(startArg.prompt, "same image, better words");
    assert.deepEqual(
      (startArg.attachments ?? []).map((a) => a.path),
      ["/tmp/shot.png"],
      "editing the words must not drop the image",
    );
    m.unmount();
  });

  it("cancelled confirmation calls neither rewind nor start", async () => {
    const { row, d } = target();
    const fake = makeFake(row, d);
    const m = await boot(fake);
    await selectThread(m, "edit resubmit target");

    await m.click(m.query('[data-edit-message="m-u1"]') as HTMLElement);
    await m.flush();
    await m.type(
      m.query('[data-edit-textarea="m-u1"]') as HTMLElement,
      "would have been sent",
    );
    await m.click(m.query('[data-edit-resubmit="m-u1"]') as HTMLElement);
    await m.flush();
    assert.ok(m.query('[data-rewind-confirm="m-u1"]'), "confirm open");

    await m.click(m.query("[data-rewind-confirm-cancel]") as HTMLElement);
    await m.flush();

    assert.equal(fake.of("threads.rewind").length, 0, "cancel must not rewind");
    assert.equal(fake.of("runs.start").length, 0, "cancel must not start");
    assert.equal(
      m.queryAll("[data-rewind-confirm]").length,
      0,
      "confirm closed",
    );
    const ta = m.query('[data-edit-textarea="m-u1"]') as HTMLTextAreaElement | null;
    assert.ok(ta, "editor stays open after cancel");
    assert.equal(ta!.value, "would have been sent", "draft kept");
    m.unmount();
  });

  it("worktree thread offers restore-files and passes restoreFiles: true", async () => {
    const { row, d } = target({ worktreePath: "/tmp/wt/edit-resubmit" });
    const fake = makeFake(row, d);
    const m = await boot(fake);
    await selectThread(m, "edit resubmit target");

    await m.click(m.query('[data-edit-message="m-u1"]') as HTMLElement);
    await m.flush();
    await m.type(
      m.query('[data-edit-textarea="m-u1"]') as HTMLElement,
      "edited with files",
    );
    await m.click(m.query('[data-edit-resubmit="m-u1"]') as HTMLElement);
    await m.flush();

    const box = m.query("[data-rewind-restore-files]") as HTMLInputElement | null;
    assert.ok(box, "restore-files checkbox when the thread has a worktree");
    assert.equal(box!.checked, false, "checkbox off by default");
    await m.click(box!);
    await m.flush();
    assert.equal(box!.checked, true);

    await m.click(m.query("[data-rewind-confirm-submit]") as HTMLElement);
    await m.flush();

    const rewindArg = fake.of("threads.rewind")[0]!.args[0] as {
      restoreFiles?: boolean;
      prompt: string;
    };
    assert.equal(rewindArg.restoreFiles, true);
    assert.equal(rewindArg.prompt, "edited with files");
    assert.equal(fake.of("runs.start").length, 1);
    m.unmount();
  });

  it("failed rewind surfaces the banner and does not start a run", async () => {
    const { row, d } = target();
    const fake = makeFake(row, d, {
      "threads.rewind": new Error("Cannot rewind while a run is active"),
    });
    const m = await boot(fake);
    await selectThread(m, "edit resubmit target");

    await m.click(m.query('[data-edit-message="m-u1"]') as HTMLElement);
    await m.flush();
    await m.click(m.query('[data-edit-resubmit="m-u1"]') as HTMLElement);
    await m.flush();
    await m.click(m.query("[data-rewind-confirm-submit]") as HTMLElement);
    await m.flush();

    assert.equal(fake.of("threads.rewind").length, 1);
    assert.equal(fake.of("runs.start").length, 0, "start must not follow a failed rewind");
    const alert = m.query('[role="alert"]');
    assert.ok(alert, "error banner after failed rewind");
    assert.ok(
      (alert!.textContent || "").includes("Cannot rewind while a run is active"),
      `banner must show backend string, got: ${alert!.textContent}`,
    );
    m.unmount();
  });

  it("working thread does not render the edit affordance", async () => {
    const { row, d } = target({ status: "working", runStartedAt: NOW });
    const fake = makeFake(row, d);
    const m = await boot(fake);
    await selectThread(m, "edit resubmit target");
    assert.equal(
      m.queryAll("[data-edit-message]").length,
      0,
      "edit hidden while a run is active",
    );
    m.unmount();
  });
});
