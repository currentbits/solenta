/**
 * Work on other computers is visible from where it started (#1831): a lead
 * lists its remote workers with live status and opens them; the worker links
 * back to its lead; a teleported thread opens its live copy.
 *
 * Run: node --import=./test/support/render.mjs --test test/farLinks.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, detail, project, thread, type FakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";

const NOW = Date.now();
const BOX = { key: "me@box:4620", label: "Box", status: "online" as const };

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
  const lead = thread({
    id: "t-lead",
    title: "Lead task",
    updatedAt: NOW,
    remoteWorkers: [
      { threadId: "r-w1", hostKey: BOX.key, hostLabel: "Box", title: "Fix tests", out: true },
      { threadId: "r-gone", hostKey: "me@far:4620", hostLabel: "Far", title: "Lint", out: false },
    ],
  });
  const worker = thread({
    id: "r-w1",
    projectId: "rp",
    title: "Fix tests",
    status: "working",
    updatedAt: NOW + 1,
    host: BOX,
    crewRelay: { leadId: "t-lead", leadTitle: "Lead task" },
  });
  const moved = thread({
    id: "t-moved",
    title: "Moved thread",
    updatedAt: NOW + 2,
    worktreePath: "/tmp/wt",
    teleportedTo: { host: "me@box", remotePort: 4620, label: "Box", threadId: "r-copy", at: NOW },
  });
  const copy = thread({
    id: "r-copy",
    projectId: "rp",
    title: "Moved thread",
    status: "working",
    updatedAt: NOW + 3,
    host: BOX,
    teleportedFrom: { threadId: "t-moved", at: NOW },
  });
  return {
    projects: [project({ id: "p1" }), project({ id: "rp", slug: "acme/rocket", name: "rocket", path: "/srv/rocket", host: BOX })],
    threads: [lead, worker, moved, copy],
    details: {
      "t-lead": detail({ thread: lead }),
      "r-w1": detail({ thread: worker }),
      "t-moved": detail({ thread: moved }),
      "r-copy": detail({ thread: copy }),
    },
  };
}

describe("links to work on other computers (#1831)", () => {
  it("a lead lists its remote workers live and opens them; the worker links back", async () => {
    const m = await boot(createFakeCoder(fixture()));
    try {
      await select(m, "Lead task");
      const banner = m.query("[data-far-workers]");
      assert.ok(banner, "lead shows its workers on other computers");
      assert.match(banner!.textContent || "", /Workers on other computers: Fix tests on Box · working, Lint on Far/);
      const gone = m.query('[data-far-worker="r-gone"]') as HTMLButtonElement;
      assert.equal(gone.disabled, true, "a computer that is not connected cannot open it");
      assert.match(gone.title, /Runs on Far\. Turn on Show in sidebar for Far/);

      await m.click(m.query('[data-far-worker="r-w1"]') as HTMLElement);
      await m.flush();
      const back = m.query('[data-far-lead-open="t-lead"]') as HTMLButtonElement;
      assert.ok(back, "the worker opened here and links back to its lead");
      assert.match(m.query("[data-far-lead]")!.textContent || "", /From Lead task/);

      await m.click(back);
      await m.flush();
      assert.ok(m.query("[data-far-workers]"), "back on the lead");
    } finally {
      m.unmount();
    }
  });

  it("a teleported thread opens its live copy, and the copy links home", async () => {
    const m = await boot(createFakeCoder(fixture()));
    try {
      await select(m, "Moved thread");
      const open = m.query('[data-teleport-open="r-copy"]') as HTMLButtonElement;
      assert.ok(open, "the teleported strip offers the live copy");
      assert.equal(open.textContent, "Open on Box");
      await m.click(open);
      await m.flush();
      assert.ok(m.query('[data-far-from-open="t-moved"]'), "the copy links back to the original");
    } finally {
      m.unmount();
    }
  });
});
