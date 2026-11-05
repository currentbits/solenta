/**
 * New-thread machine picker (#1835): a draft can run on this computer or on
 * a connected computer with the same repo; picking one recreates the draft
 * there with its text. A started thread on another computer names it.
 *
 * Run: node --import=./test/support/render.mjs --test test/machinePicker.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, detail, project, thread, type FakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";

const NOW = Date.now();
const BOX = { key: "me@box:4620", label: "Box", status: "online" as const };
const FAR = { key: "me@far:4620", label: "Far", status: "offline" as const };

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
});
