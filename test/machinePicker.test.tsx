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


describe("machine setup from the composer", () => {
  function unconfigured() {
    const fx = fixture();
    return { ...fx, projects: [fx.projects[0]!], threads: [fx.threads[0]!] };
  }
  function connect(fake: FakeCoder) {
    fake.api.app.setSidebarHosts = async () => [{ ...BOX, host: "box", remotePort: 4620, error: null }];
    fake.api.git.repoInfo = async () => ({ ok: true, owner: "acme", repo: "rocket", webUrl: "https://github.com/acme/rocket" });
  }
  const destination = project({ id: "new-remote-project", slug: "acme/rocket", path: "/srv/rocket", host: BOX });

  it("always offers Run on and a connection setup entry with only this computer", async () => {
    const m = await boot(createFakeCoder(unconfigured()));
    try {
      await select(m, "Draft");
      assert.match(m.query("[data-workspace-machine]")?.textContent ?? "", /Run on/);
      await m.click(m.query("[data-workspace-machine]"));
      assert.equal(m.queryAll("[data-workspace-machine-option]").length, 1);
      await m.click(m.query("[data-connect-computer]"));
      assert.ok(m.query('[role="dialog"]'));
      assert.match(m.text(), /Connections/);
    } finally { m.unmount(); }
  });

  it("offers a connected computer without a project and clones there before moving", async () => {
    const fake = createFakeCoder(unconfigured());
    connect(fake);
    let cloneInput: unknown;
    fake.api.projects.clone = async (input) => { cloneInput = input; return destination; };
    const settingsGet = fake.api.settings.get;
    const settingsOwners: unknown[] = [];
    fake.api.settings.get = async (...args: unknown[]) => { settingsOwners.push(args[0]); return settingsGet(); };
    setDraftText("t-draft", "keep my request");
    const m = await boot(fake);
    try {
      await pickBox(m);
      assert.match(m.text(), /Run on Box/);
      assert.equal(m.query("[data-add-project-mode-create]"), null);
      assert.equal(m.query("[data-add-project-computer]"), null);
      assert.equal((m.query("[data-add-project-clone-url]") as HTMLInputElement).value, "https://github.com/acme/rocket");
      await m.type(m.query("[data-add-project-clone-location]"), "/srv");
      await m.click(m.query("[data-add-project-path-submit]"));
      assert.equal((cloneInput as { onHost: string }).onHost, BOX.key);
      assert.equal((fake.only("threads.create").args[0] as { projectId: string }).projectId, destination.id);
      assert.ok(settingsOwners.some((c) => (c as { onHost?: string })?.onHost === BOX.key), "fresh checkout uses destination settings");
      assert.equal(captureComposerDraft("t-new").text, "keep my request");
      assert.equal(m.query("[data-add-project-path-dialog]"), null);
    } finally { m.unmount(); }
  });

  it("adds an existing checkout on the chosen host without initializing an empty repo", async () => {
    const fake = createFakeCoder(unconfigured());
    connect(fake);
    let addInput: unknown[] = [];
    fake.api.projects.add = async (...input) => { addInput = input; return destination; };
    const m = await boot(fake);
    try {
      await pickBox(m);
      await m.click(m.query("[data-add-project-mode-existing]"));
      await m.type(m.query("[data-add-project-path-input]"), "/srv/rocket");
      await m.click(m.query("[data-add-project-path-submit]"));
      assert.deepEqual(addInput, ["/srv/rocket", { onHost: BOX.key, requireExistingRepo: true }]);
      assert.equal(fake.of("threads.create").length, 1);
    } finally { m.unmount(); }
  });

  it("retains the original draft when the selected checkout is a different repository", async () => {
    const fake = createFakeCoder(unconfigured());
    connect(fake);
    fake.api.projects.add = async () => ({ ...destination, slug: "acme/other" });
    const saved = richDraft();
    const m = await boot(fake);
    try {
      await pickBox(m);
      await m.click(m.query("[data-add-project-mode-existing]"));
      await m.type(m.query("[data-add-project-path-input]"), "/srv/other");
      await m.click(m.query("[data-add-project-path-submit]"));
      assert.match(m.text(), /Choose a checkout of acme\/rocket/);
      assert.equal(fake.of("threads.create").length, 0);
      assert.deepEqual(captureComposerDraft("t-draft"), saved);
    } finally { m.unmount(); }
  });

  it("keeps the draft if the destination disconnects while setup is open", async () => {
    const fake = createFakeCoder(unconfigured());
    connect(fake);
    const host = { ...BOX, status: "online" as "online" | "offline", host: "box", remotePort: 4620, error: null };
    fake.api.app.setSidebarHosts = async () => [host];
    const saved = richDraft();
    const m = await boot(fake);
    try {
      await pickBox(m);
      host.status = "offline";
      await m.click(m.query("[data-add-project-path-submit]"));
      assert.match(m.text(), /computer is offline/);
      assert.equal(fake.of("projects.clone").length, 0);
      assert.equal(fake.of("threads.create").length, 0);
      assert.deepEqual(captureComposerDraft("t-draft"), saved);
    } finally { m.unmount(); }
  });

  it("reuses a completed clone when moving fails and the user retries", async () => {
    const fake = createFakeCoder(unconfigured());
    connect(fake);
    let clones = 0;
    fake.api.projects.clone = async () => { clones++; return destination; };
    const create = fake.api.threads.create;
    let attempts = 0;
    fake.api.threads.create = async (input) => {
      if (++attempts === 1) throw new Error("connection lost");
      return create(input);
    };
    const saved = richDraft();
    const m = await boot(fake);
    try {
      await pickBox(m);
      await m.click(m.query("[data-add-project-path-submit]"));
      assert.equal(clones, 1);
      assert.deepEqual(captureComposerDraft("t-draft"), saved);
      assert.match(m.text(), /Could not start the thread/);
      await m.click(m.query("[data-add-project-path-submit]"));
      assert.equal(clones, 1);
      assert.equal(attempts, 2);
      assert.deepEqual(captureComposerDraft("t-new"), saved);
    } finally { m.unmount(); }
  });
});
