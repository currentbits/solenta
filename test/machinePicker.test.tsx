/**
 * New-thread machine picker (#1835): a draft can run on this computer or on
 * a connected computer with the same repo; picking one recreates the draft
 * there with its complete composer draft. A started thread on another computer names it.
 *
 * Run: node --import=./test/support/render.mjs --test test/machinePicker.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, detail, project, thread, type FakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";
import {
  captureComposerDraft, flushDraftSave, keptAttachments, keptPasteCards,
  resetComposerSession, serializeDrafts, setContextChips, setDraftText,
  setReviewComments,
} from "../src/composerSession";
import { makePasteCard } from "../src/pasteCards";

const NOW = Date.now();
const BOX = { key: "me@box:4620", label: "Box", status: "online" as const };
const FAR = { key: "me@far:4620", label: "Far", status: "offline" as const };

afterEach(resetComposerSession);

function richDraft() {
  setDraftText("t-draft", "fix this [pasted context]");
  keptAttachments["t-draft"] = [{ kind: "file", path: "/repo/a.ts", name: "a.ts" }];
  keptPasteCards["t-draft"] = [makePasteCard("important context\n".repeat(20))];
  setContextChips("t-draft", () => [{
    id: "ctx", kind: "thread", threadId: "r-run", title: "Running there",
  }]);
  setReviewComments("t-draft", () => [{
    id: "review", path: "a.ts", startLine: 1, endLine: 1,
    removed: false, code: "+x", text: "fix this",
  }]);
  return captureComposerDraft("t-draft");
}

async function pickBox(m: Awaited<ReturnType<typeof mount>>) {
  await select(m, "Draft");
  await m.click(m.query("[data-workspace-machine]") as HTMLElement);
  await m.click(m.query('[data-workspace-machine-option="Box"]') as HTMLElement);
  await m.flush();
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

async function select(m: Awaited<ReturnType<typeof mount>>, title: string) {
  const card = m.query(`button[aria-label^="Select thread: ${title}"]`);
  assert.ok(card, `thread card for "${title}" must exist`);
  await m.click(card as HTMLElement);
  await m.flush();
}

function fixture() {
  const draft = thread({ id: "t-draft", title: "Draft", projectId: "p1", pendingWorktree: true, updatedAt: NOW });
  const remoteRun = thread({ id: "r-run", title: "Running there", projectId: "rp", host: BOX, branch: "coder/x", worktreePath: "/srv/wt", updatedAt: NOW + 1 });
  return {
    projects: [
      project({ id: "p1", slug: "acme/rocket" }),
      project({ id: "rp", slug: "Acme/Rocket", name: "rocket", path: "/srv/rocket", host: BOX }),
      project({ id: "fp", slug: "acme/rocket", name: "rocket", path: "/x/rocket", host: FAR }),
      project({ id: "other", slug: "acme/other", name: "other", path: "/srv/other", host: BOX }),
    ],
    threads: [draft, remoteRun],
    details: {
      "t-draft": detail({ thread: draft, messages: [] }),
      "r-run": detail({ thread: remoteRun, messages: [{ id: "m1", role: "user", text: "go", createdAt: NOW } as never] }),
    },
  };
}

describe("new thread: pick the computer it runs on (#1835)", () => {
  it("offers this computer and connected ones with the same repo, and moves the draft", async () => {
    const fake = createFakeCoder(fixture());
    const m = await boot(fake);
    try {
      await select(m, "Draft");
      const trigger = m.query("[data-workspace-machine]") as HTMLButtonElement;
      assert.ok(trigger, "machine picker next to the workspace picker");
      await m.click(trigger);
      const options = m.queryAll("[data-workspace-machine-option]").map((b) => b.getAttribute("data-workspace-machine-option"));
      assert.equal(options.length, 3, "this computer, Box, Far; not other repos");
      assert.ok(options.includes("Box") && options.includes("Far"));
      assert.equal((m.query('[data-workspace-machine-option="Far"]') as HTMLButtonElement).disabled, true, "offline");

      await m.type(m.query("textarea") as HTMLTextAreaElement, "fix the flaky test");
      await m.click(m.query('[data-workspace-machine-option="Box"]') as HTMLElement);
      await m.flush();
      const created = fake.calls.find((c) => c.channel === "threads.create");
      assert.ok(created, "draft recreated");
      assert.deepEqual(
        { projectId: (created!.args[0] as { projectId: string }).projectId, worktree: (created!.args[0] as { worktree?: boolean }).worktree },
        { projectId: "rp", worktree: true },
        "in Box's copy of the repo, keeping New worktree",
      );
      assert.ok(fake.calls.some((c) => c.channel === "threads.delete" && (c.args[0] as { threadId: string }).threadId === "t-draft"), "old draft dropped");
      assert.equal((m.query("textarea") as HTMLTextAreaElement).value, "fix the flaky test", "typed text came along");
    } finally {
      m.unmount();
    }
  });

  it("names the computer a started thread runs on", async () => {
    const m = await boot(createFakeCoder(fixture()));
    try {
      await select(m, "Running there");
      assert.match(m.query("[data-workspace-machine-label]")?.textContent || "", /Box ·/);
      assert.equal(m.query("[data-workspace-machine]"), null, "no picker once it has run");
    } finally {
      m.unmount();
    }
  });

  it("preserves the complete rich draft before purging the source", async () => {
    const fake = createFakeCoder(fixture());
    const saved = richDraft();
    const purge = fake.api.threads.purge;
    fake.api.threads.purge = async (input) => {
      if (input.threadId === "t-draft") {
        assert.deepEqual(captureComposerDraft("t-new"), saved, "copy exists before source purge");
      }
      return purge(input);
    };
    const m = await boot(fake);
    try {
      await pickBox(m);
      assert.deepEqual(captureComposerDraft("t-new"), saved);
      assert.ok(m.query('[data-attachment-kind="file"]'), "attachment shown in destination");
      assert.match(m.query("[data-context-chip]")?.textContent ?? "", /Running there/);
      assert.ok(m.query("[data-review-comment-chip]"), "review comment shown");
      flushDraftSave();
      const persisted = JSON.parse(serializeDrafts());
      assert.equal(persisted["t-draft"], undefined);
      assert.equal(persisted["t-new"].pasteCards.length, 1);
    } finally { m.unmount(); }
  });

  for (const channel of ["threads.create", "threads.delete", "threads.purge"]) {
    it(`keeps the complete source draft when ${channel} fails`, async () => {
      const fake = createFakeCoder({ ...fixture(), fail: { [channel]: new Error("move failed") } });
      const saved = richDraft();
      const m = await boot(fake);
      try {
        await pickBox(m);
        assert.deepEqual(captureComposerDraft("t-draft"), saved);
        assert.ok((await fake.api.threads.list()).some((t) => t.id === "t-draft"), "source restored");
        assert.equal((m.query("textarea") as HTMLTextAreaElement).value, saved.text);
      } finally { m.unmount(); }
    });
  }

  for (const status of ["done", "idle"] as const) {
    it(`refuses a sidebar move of a ${status} conversation with no worktree or snapshot`, async () => {
    const fx = fixture();
    fx.threads[0] = { ...fx.threads[0]!, status, pendingWorktree: false };
    fx.details["t-draft"] = detail({
      thread: fx.threads[0],
      messages: [{ id: "old", role: "user", text: "keep this conversation", createdAt: NOW } as never],
    });
    const fake = createFakeCoder(fx);
    const m = await boot(fake);
    try {
      await select(m, "Draft");
      await m.click(m.query('[data-more-btn="t-draft"]') as HTMLElement);
      await m.click(document.querySelector('[data-move-project="t-draft"]') as HTMLElement);
      await m.click(document.querySelector('[data-move-project-id="rp"]') as HTMLElement);
      await m.flush();
      assert.equal(fake.calls.some((c) => ["threads.create", "threads.delete", "threads.purge"].includes(c.channel)), false);
      assert.match(m.container.textContent ?? "", /Only an unstarted draft/);
      assert.equal((await fake.api.threads.peek("t-draft")).messages[0]?.text, "keep this conversation");
    } finally { m.unmount(); }
    });
  }
});
