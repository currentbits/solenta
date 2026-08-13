/**
 * Settled tail "Clear" (Synara-style bulk archive).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom";
import { Sidebar } from "../src/components/Sidebar";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";
import { thread } from "./support/fakeCoder";

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const p1: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};
const providers: ProviderInfo[] = [];

function quiet(id: string): ThreadInfo {
  return thread({
    id,
    projectId: "p1",
    title: id,
    status: "idle",
    updatedAt: NOW - 5 * DAY_MS,
    createdAt: NOW - 10 * DAY_MS,
    lastVisitedAt: NOW - 5 * DAY_MS,
  });
}

describe("settled tail Clear", () => {
  it("hands every settled id to onClearSettled, not attention threads", async () => {
    const threads = [
      thread({ id: "fresh", projectId: "p1", title: "fresh", updatedAt: NOW }),
      quiet("old-a"),
      quiet("old-b"),
    ];
    let cleared: string[] | null = null;
    const m = await mount(
      <Sidebar
        appName="Solenta"
        searchPlaceholder="Search"
        projectsHeader="All projects"
        projects={[p1]}
        threads={threads}
        providers={providers}
        activeThreadId="fresh"
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onAddProject={() => {}}
        searchThreads={async () => threads}
        onClearSettled={(ids) => {
          cleared = ids;
        }}
      />,
    );
    const btn = m.query("[data-settled-clear-all]");
    assert.ok(btn, "Clear button renders on settled tail");
    await m.click(btn!);
    assert.deepEqual((cleared ?? []).sort(), ["old-a", "old-b"]);
    m.unmount();
  });

  it("no Clear button without the callback", async () => {
    const m = await mount(
      <Sidebar
        appName="Solenta"
        searchPlaceholder="Search"
        projectsHeader="All projects"
        projects={[p1]}
        threads={[quiet("old-a")]}
        providers={providers}
        activeThreadId={null}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onAddProject={() => {}}
        searchThreads={async () => []}
      />,
    );
    assert.equal(m.query("[data-settled-clear-all]"), null);
    m.unmount();
  });
});
