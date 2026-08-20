/**
 * Conflict-forecast badges on ThreadCard (sidebar) and KanbanView.
 * Run: npm run test:renderer -- test/conflictForecastBadge.test.tsx
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

const sidebarCss = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/components/Sidebar.module.css",
  ),
  "utf8",
);

/** Body of `.className {` after comments are stripped. */
function cssRuleBody(css: string, className: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{`);
  const m = re.exec(clean);
  if (!m) return "";
  const brace = m.index + m[0].length - 1;
  const end = clean.indexOf("}", brace);
  if (end < 0) return "";
  return clean.slice(brace + 1, end);
}

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
    const tip = m.query("[data-conflict-tip]");
    assert.ok(tip, "hover tip must be in the DOM");
    assert.match(tip.textContent || "", /beta work/);
    assert.match(tip.textContent || "", /src\/a\.ts/);
    assert.doesNotMatch(tip.textContent || "", /overlaps/);
    m.unmount();
  });

  it("shows a quiet overlap badge when pairs only overlap", async () => {
    const m = await card(overlapForecast());
    const badge = m.query("[data-conflict-forecast]");
    assert.ok(badge, "overlap badge must render");
    assert.equal(badge.getAttribute("data-conflict-forecast"), "overlap");
    assert.equal((badge.textContent || "").trim(), "overlap");
    const tip = m.query("[data-conflict-tip]");
    assert.ok(tip, "hover tip must be in the DOM");
    assert.match(tip.textContent || "", /overlaps beta work/);
    assert.match(tip.textContent || "", /src\/a\.ts/);
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
    const tip = m.query("[data-conflict-tip]");
    assert.ok(tip);
    const lines = [...tip.querySelectorAll("[data-conflict-kind]")].map(
      (el) => el.getAttribute("data-conflict-kind"),
    );
    assert.deepEqual(lines, ["conflict", "overlap"]);
    assert.match(tip.textContent || "", /beta work/);
    assert.match(tip.textContent || "", /overlaps gamma work/);
    m.unmount();
  });

  it("is keyboard-focusable so the tip is not hover-only", async () => {
    const m = await card(loudForecast());
    const badge = m.query("[data-conflict-forecast]");
    assert.ok(badge);
    assert.equal(badge.getAttribute("tabindex"), "0");
    assert.match(badge.getAttribute("aria-label") || "", /beta work/);
    m.unmount();
  });
});

describe("conflict tip readability", () => {
  // Spec: restyle the forecast marker to plain 11px text/icon, no pill.
  // These CSS pins keep the tip readable after that restyle.
  it("paints the tip on an opaque card surface, not the sidebar fill", () => {
    const body = cssRuleBody(sidebarCss, "conflictTip");
    assert.match(
      body,
      /background\s*:\s*var\(--card\)/,
      "tip must use --card so it does not dissolve into --bg-elevated / transparent cards",
    );
    assert.doesNotMatch(
      body,
      /--bg-elevated|transparent|color-mix/,
      "a see-through tip is how the overlay became unreadable over the next card",
    );
  });

  it("raises the open card above siblings so the tip is not buried", () => {
    const clean = sidebarCss.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(
      clean,
      /\.card:has\(\.conflictWrap:hover\)/,
      "card must rise on tip hover; z-index 8 inside cardBody cannot escape the next card",
    );
    assert.match(
      clean,
      /\.card:has\(\.conflictWrap:focus-within\)/,
      "keyboard focus on the pill must raise the card the same way",
    );
    const hoverRule =
      /\.card:has\(\.conflictWrap:hover\)[^{]*\{([^}]*)\}/.exec(clean);
    assert.ok(hoverRule, "hover :has() rule must have a body");
    const z = /z-index\s*:\s*(\d+)/.exec(hoverRule[1] || "");
    assert.ok(z, "raised card must set z-index");
    assert.ok(
      Number(z[1]) > 2,
      `raised card z-index must beat cardActions (2); got ${z[1]}`,
    );
  });

  it("keeps overlap lines at full text contrast", () => {
    const clean = sidebarCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const mutedOverlap =
      /\.conflictTipLine\[data-conflict-kind="overlap"\]\s*\{([^}]*)\}/.exec(
        clean,
      );
    if (mutedOverlap) {
      assert.doesNotMatch(
        mutedOverlap[1] || "",
        /--text-muted|--text-dim/,
        "muted overlap copy disappears on the next card",
      );
    }
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
