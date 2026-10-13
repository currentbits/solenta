/**
 * Multi-repo tasks (#263): roll-up helpers, the banner, and the title-menu
 * "Continue task in another repo" wiring through the real App.
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
import type { ThreadDetail } from "../src/shared/ipc";
import { taskGroupRollup, taskRepoTargets } from "../src/taskGroup";
import { expandAgents } from "./support/expandAgents.ts";

const STARTED = [
  { id: "u-start", role: "user", text: "start", createdAt: 1 },
] as ThreadDetail["messages"];

const projects = [
  project({ id: "p1", slug: "acme/api", name: "api", path: "/tmp/api" }),
  project({ id: "p2", slug: "acme/web", name: "web", path: "/tmp/web" }),
  project({ id: "p3", slug: "scratch", name: "Scratch", path: "/tmp/s", scratch: true }),
];

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<App />);
  await expandAgents(m);
  return m;
}

describe("taskGroupRollup / taskRepoTargets (#263)", () => {
  const api = thread({ id: "a", projectId: "p1", taskGroupId: "a", createdAt: 1 });
  const web = thread({
    id: "w",
    projectId: "p2",
    taskGroupId: "a",
    createdAt: 2,
    prNumber: 4,
    prUrl: "https://github.com/acme/web/pull/4",
    prState: "MERGED",
  });

  it("rolls members up in creation order with PR counts", () => {
    const r = taskGroupRollup(web, [web, api, thread({ id: "x", projectId: "p1" })], projects);
    assert.ok(r);
    assert.deepEqual(r.members.map((m) => [m.id, m.projectName, m.current]), [
      ["a", "api", false],
      ["w", "web", true],
    ]);
    assert.equal(r.prsMerged, 1);
    assert.equal(r.prsTotal, 1);
  });

  it("is null for a group of one or no group", () => {
    assert.equal(taskGroupRollup(api, [api], projects), null);
    assert.equal(taskGroupRollup(thread({ id: "x" }), [api, web], projects), null);
  });

  it("targets skip scratch, the own project and repos already in the task", () => {
    assert.deepEqual(taskRepoTargets(api, [api, web], projects), []);
    const solo = thread({ id: "s", projectId: "p1" });
    assert.deepEqual(taskRepoTargets(solo, [solo], projects), [{ id: "p2", name: "web" }]);
  });
});

describe("App multi-repo task wiring (#263)", () => {
  it("banner lists every repo thread and selects a sibling", async () => {
    const api = thread({ id: "t-api", projectId: "p1", title: "Dark mode api", taskGroupId: "t-api", createdAt: 1 });
    const web = thread({
      id: "t-web",
      projectId: "p2",
      title: "Dark mode web",
      taskGroupId: "t-api",
      createdAt: 2,
      prNumber: 7,
      prUrl: "https://github.com/acme/web/pull/7",
      prState: "OPEN",
    });
    const fake = createFakeCoder({
      projects,
      threads: [api, web],
      details: {
        "t-api": detail({ thread: api, messages: STARTED }),
        "t-web": detail({ thread: web, messages: STARTED }),
      },
    });
    const m = await boot(fake);
    const card = m.query('button[aria-label^="Select thread: Dark mode api"]');
    assert.ok(card);
    await m.click(card as HTMLElement);
    await m.flush();
    const banner = m.query("[data-task-group]");
    assert.ok(banner, "task banner must render");
    assert.match(banner!.textContent ?? "", /Multi-repo task · 2 repos · 0 of 1 PRs merged/);
    assert.match(banner!.textContent ?? "", /#7 open/);
    const sibling = m.query('[data-task-member="t-web"] button');
    assert.ok(sibling);
    await m.click(sibling as HTMLElement);
    await m.flush();
    assert.ok(m.query('[data-task-member="t-api"] button'), "selection moved to the web thread");
    m.unmount();
  });

  it("title menu starts a sibling in another repo with taskGroupFrom", async () => {
    const solo = thread({ id: "t-solo", projectId: "p1", title: "Rate limits" });
    const fake = createFakeCoder({
      projects,
      threads: [solo],
      details: { "t-solo": detail({ thread: solo, messages: STARTED }) },
    });
    const m = await boot(fake);
    const card = m.query('button[aria-label^="Select thread: Rate limits"]');
    await m.click(card as HTMLElement);
    await m.flush();
    await m.click(m.query("[data-thread-title-menu]") as HTMLElement);
    await m.flush();
    assert.equal(m.query('[data-task-add-repo="p3"]'), null, "scratch is not a repo");
    const add = m.query('[data-task-add-repo="p2"]');
    assert.ok(add, "web must be offered");
    await m.click(add as HTMLElement);
    await m.flush();
    const creates = fake.of("threads.create");
    assert.equal(creates.length, 1);
    assert.deepEqual(
      { ...(creates[0]!.args[0] as object) },
      { projectId: "p2", title: "Rate limits", taskGroupFrom: "t-solo" },
    );
    m.unmount();
  });
});
