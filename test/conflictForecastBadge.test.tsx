/**
 * Conflict-forecast badges on ThreadCard (sidebar) and KanbanView.
 * Run: npm run test:renderer -- test/conflictForecastBadge.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { ThreadCard } from "../src/components/Sidebar";
import { KanbanView } from "../src/components/KanbanView";
import { thread } from "./support/fakeCoder.ts";
import type {
  ConflictForecast,
  ProjectInfo,
  ProviderInfo,
} from "../src/shared/ipc";

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

const project: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};

const titles = new Map<string, string>([
  ["t1", "alpha work"],
  ["t2", "beta work"],
  ["t3", "gamma work"],
]);

function loudForecast(): ConflictForecast {
  return {
    computedAt: 1,
    pairs: [
      {
        threadA: "t1",
        threadB: "t2",
        overlap: ["src/a.ts", "src/b.ts"],
        conflicts: ["src/a.ts"],
      },
    ],
  };
}

function overlapForecast(): ConflictForecast {
  return {
    computedAt: 1,
    pairs: [
      {
        threadA: "t1",
        threadB: "t2",
        overlap: ["src/a.ts", "src/b.ts"],
        conflicts: [],
      },
    ],
  };
}

function multiForecast(): ConflictForecast {
  return {
    computedAt: 1,
    pairs: [
      {
        threadA: "t1",
        threadB: "t2",
        overlap: ["src/a.ts"],
        conflicts: ["src/a.ts"],
      },
      {
        threadA: "t1",
        threadB: "t3",
        overlap: ["src/c.ts"],
        conflicts: [],
      },
    ],
  };
}

async function card(forecast: ConflictForecast | null, id = "t1") {
  return mount(
    <ThreadCard
      thread={thread({ id, title: titles.get(id) ?? id, status: "idle" })}
      slug="acme/ledger"
      providers={providers}
      active={false}
      now={Date.now()}
      onSelect={() => {}}
      conflictForecast={forecast}
      threadTitles={titles}
    />,
  );
}

describe("ThreadCard conflict forecast badge", () => {
  it("shows a loud conflict badge when a pair has conflicts", async () => {
    const m = await card(loudForecast());
    const badge = m.query("[data-conflict-forecast]");
    assert.ok(badge, "conflict badge must render");
    assert.equal(badge.getAttribute("data-conflict-forecast"), "conflict");
    assert.equal((badge.textContent || "").trim(), "conflict");
    assert.match(badge.getAttribute("title") || "", /beta work/);
    assert.match(badge.getAttribute("title") || "", /src\/a\.ts/);
    m.unmount();
  });

  it("shows a quiet overlap badge when pairs only overlap", async () => {
    const m = await card(overlapForecast());
    const badge = m.query("[data-conflict-forecast]");
    assert.ok(badge, "overlap badge must render");
    assert.equal(badge.getAttribute("data-conflict-forecast"), "overlap");
    assert.equal((badge.textContent || "").trim(), "overlap");
    assert.match(badge.getAttribute("title") || "", /beta work/);
    assert.match(badge.getAttribute("title") || "", /src\/a\.ts/);
    m.unmount();
  });

  it("shows no badge when the thread is in no pair", async () => {
    const m = await card(loudForecast(), "t3");
    assert.equal(m.query("[data-conflict-forecast]"), null);
    m.unmount();
  });

  it("includes a count when the thread is in more than one pair", async () => {
    const m = await card(multiForecast());
    const badge = m.query("[data-conflict-forecast]");
    assert.ok(badge);
    assert.equal(badge.getAttribute("data-conflict-forecast"), "conflict");
    assert.equal((badge.textContent || "").trim(), "conflict · 2");
    const title = badge.getAttribute("title") || "";
    assert.match(title, /beta work/);
    assert.match(title, /gamma work/);
    m.unmount();
  });
});

describe("KanbanView conflict forecast badge", () => {
  const threads = [
    thread({ id: "t1", title: "alpha work", status: "idle" }),
    thread({ id: "t2", title: "beta work", status: "idle" }),
    thread({ id: "t3", title: "gamma work", status: "idle" }),
  ];

  async function board(forecast: ConflictForecast) {
    return mount(
      <KanbanView
        threads={threads}
        projects={[project]}
        providers={providers}
        onSelectThread={() => {}}
        conflictForecast={forecast}
      />,
    );
  }

  it("shows a loud conflict badge on the overlapping card", async () => {
    const m = await board(loudForecast());
    const cardEl = m.query('[data-thread-card="t1"]');
    assert.ok(cardEl);
    const badge = cardEl.querySelector("[data-conflict-forecast]");
    assert.ok(badge);
    assert.equal(badge.getAttribute("data-conflict-forecast"), "conflict");
    m.unmount();
  });

  it("shows a quiet overlap badge when pairs only overlap", async () => {
    const m = await board(overlapForecast());
    const cardEl = m.query('[data-thread-card="t1"]');
    assert.ok(cardEl);
    const badge = cardEl.querySelector("[data-conflict-forecast]");
    assert.ok(badge);
    assert.equal(badge.getAttribute("data-conflict-forecast"), "overlap");
    m.unmount();
  });

  it("shows no badge on a thread in no pair", async () => {
    const m = await board(loudForecast());
    const cardEl = m.query('[data-thread-card="t3"]');
    assert.ok(cardEl);
    assert.equal(cardEl.querySelector("[data-conflict-forecast]"), null);
    m.unmount();
  });
});
