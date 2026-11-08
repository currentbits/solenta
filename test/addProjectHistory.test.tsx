/**
 * Add project: "From CLI history…" mode (#1858). The modal lists the folders
 * projects.discoverHistory found, filters them by the search box, adds the
 * picked one through projects.add, then offers to import its recent sessions.
 *
 * Run: node --import=./test/support/render.mjs --test test/addProjectHistory.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import type { HistoryProject } from "../src/shared/ipc";
import { HistoryProjectPicker, usedAgo } from "../src/components/HistoryProjectPicker";
import App from "../src/App";

const DAY = 86_400_000;
const rows = (): HistoryProject[] => [
  {
    path: "/Users/demo/code/storefront",
    name: "storefront",
    lastActiveAt: Date.now() - 3 * DAY - 1000,
    providers: ["claude", "codex"],
    sessions: 12,
    recentSessions: [
      { provider: "codex", sessionId: "s-new" },
      { provider: "claude", sessionId: "s-old" },
    ],
  },
  {
    path: "/Users/demo/notes",
    name: "notes",
    lastActiveAt: Date.now() - 40 * DAY,
    providers: ["grok"],
    sessions: 1,
    recentSessions: [],
  },
];

async function openHistory(historyProjects: HistoryProject[]) {
  const fake = createFakeCoder({ projects: [], threads: [], historyProjects });
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<App />);
  await m.click(m.byText("Add project"));
  const mode = m.query("[data-add-project-mode-history]");
  assert.ok(mode, "modal must offer From CLI history…");
  await m.click(mode);
  await m.flush();
  return { fake, m };
}

describe("Add project: from CLI history", () => {
  it("lists folders with CLI badges and usage, and filters by search", async () => {
    const { fake, m } = await openHistory(rows());
    assert.equal(fake.of("projects.discoverHistory").length, 1);
    const listed = m.queryAll("[data-history-project]");
    assert.deepEqual(
      listed.map((el) => el.getAttribute("data-history-project")),
      ["/Users/demo/code/storefront", "/Users/demo/notes"],
    );
    const first = listed[0].textContent ?? "";
    assert.match(first, /storefront/);
    assert.match(first, /Claude/);
    assert.match(first, /Codex/);
    assert.match(first, /used 3 days ago · 12 sessions/);
    assert.match(listed[1].textContent ?? "", /1 session$/);
    assert.equal(m.query("[data-add-project-path-submit]"), null, "rows add; no Add button");

    await m.type(m.query("[data-history-search]"), "NOTES");
    assert.deepEqual(
      m.queryAll("[data-history-project]").map((el) => el.getAttribute("data-history-project")),
      ["/Users/demo/notes"],
    );
    await m.type(m.query("[data-history-search]"), "zzz");
    assert.ok(m.query("[data-history-no-match]"));
    m.unmount();
  });

  it("adds the picked folder via projects.add, then imports its recent sessions", async () => {
    const { fake, m } = await openHistory(rows());
    await m.click(m.query('[data-history-project="/Users/demo/code/storefront"]'));
    assert.deepEqual(fake.of("projects.add").map((c) => c.args[0]), ["/Users/demo/code/storefront"]);
    assert.ok(m.query("[data-history-import-offer]"), "offers the import");
    assert.match(m.text(), /Import its 2 most recent sessions/);

    await m.click(m.query("[data-history-import]"));
    const imports = fake.of("threads.importCliSession").map((c) => c.args[0] as Record<string, unknown>);
    assert.deepEqual(
      imports.map((i) => [i.sessionId, i.provider]),
      [
        ["s-old", "claude"],
        ["s-new", "codex"],
      ],
      "oldest first so the newest ends selected",
    );
    assert.ok(imports.every((i) => typeof i.projectId === "string" && i.projectId));
    assert.equal(m.query("[data-add-project-path]"), null, "modal closes after import");
    m.unmount();
  });

  it("closes straight away when the folder has no sessions to offer, or on Not now", async () => {
    const { fake, m } = await openHistory(rows());
    await m.click(m.query('[data-history-project="/Users/demo/notes"]'));
    assert.equal(fake.of("projects.add").length, 1);
    assert.equal(m.query("[data-add-project-path]"), null);
    m.unmount();

    const second = await openHistory(rows());
    await second.m.click(second.m.query('[data-history-project="/Users/demo/code/storefront"]'));
    await second.m.click(second.m.query("[data-history-import-skip]"));
    assert.equal(second.fake.of("threads.importCliSession").length, 0);
    assert.equal(second.m.query("[data-add-project-path]"), null);
    second.m.unmount();
  });

  it("says so when the history has no new folders", async () => {
    const { m } = await openHistory([]);
    assert.ok(m.query("[data-history-empty]"));
    m.unmount();
  });

  it("shows a loading line while discovery is still running", async () => {
    const m = await mount(
      <HistoryProjectPicker discover={() => new Promise(() => {})} onPick={() => {}} />,
    );
    assert.ok(m.query("[data-history-loading]"));
    assert.equal(m.query("[data-history-project]"), null);
    m.unmount();
  });

  it("phrases the last-used time", () => {
    const now = 10 * DAY;
    assert.equal(usedAgo(now - 1000, now), "used today");
    assert.equal(usedAgo(now - DAY - 1, now), "used yesterday");
    assert.equal(usedAgo(now - 3 * DAY, now), "used 3 days ago");
  });
});
