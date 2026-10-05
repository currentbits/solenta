/**
 * Sidebar search, project scope, filters, tags and saved filter views.
 *
 * Split out of sidebar.test.tsx: node:test gives each file one 20 s
 * --test-timeout budget, and as one file the suite sat at its edge on slow
 * Windows CI runners. Shared fixtures live in support/sidebarFixtures.tsx.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";
import {
  p1,
  p2,
  providers,
  FRESH,
  DAY_MS,
  thread,
  sidebar,
  openMoreMenu,
  THREADS,
  cardTitles,
  searchInput,
  scopeTrigger,
  settledToggle,
  openScopeMenu,
  clearSidebarStorage,
  portalMenu,
} from "./support/sidebarFixtures";

describe("Sidebar project scope", () => {
  it("filters the flat list to the scoped project and persists", async () => {
    await clearSidebarStorage();
    const m1 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.ok(cardTitles(m1).includes("busy"));
    assert.ok(cardTitles(m1).includes("billing-idle"));
    assert.match(scopeTrigger(m1).textContent || "", /All projects/);

    await openScopeMenu(m1);
    assert.ok(m1.query('[data-scope-item="all"]'));
    const p2Item = m1.query('[data-scope-item="p2"]');
    assert.ok(p2Item, "every project is a scope item");
    assert.match(p2Item!.textContent || "", /acme\/billing/);
    await m1.click(p2Item!);
    await m1.flush();

    const after = cardTitles(m1);
    assert.ok(after.includes("billing-idle"));
    assert.ok(!after.includes("busy"), "p1 attention is filtered out");
    assert.match(scopeTrigger(m1).textContent || "", /acme\/billing/);
    m1.unmount();


    const m2 = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.match(
      scopeTrigger(m2).textContent || "",
      /acme\/billing/,
      "scope persists via sidebar:projectScope",
    );
    assert.ok(!cardTitles(m2).includes("busy"));
    m2.unmount();
  });

  it("search ANDs with project scope (#553)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    assert.ok(!cardTitles(m).includes("merged-p1"));

    await m.type(searchInput(m), "merged ledger");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.deepEqual(
      cardTitles(m),
      [],
      "a p1 hit is dropped while scoped to p2",
    );
    m.unmount();
  });

  it("search still surfaces settled hits in the scoped project while the shelf is collapsed", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();

    await m.type(searchInput(m), "merged billing");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    assert.deepEqual(
      cardTitles(m),
      ["merged-p2"],
      "search bypasses the collapsed settled shelf inside the scoped project",
    );
    const hit = m.query('[data-thread-card="merged-p2"]');
    assert.ok(hit);
    assert.ok(
      hit!.querySelector("[data-card-slug]"),
      "search hits still carry the project slug",
    );
    m.unmount();
  });

  it("All projects restores the unfiltered list", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="all"]')!);
    await m.flush();
    assert.ok(cardTitles(m).includes("busy"));
    assert.ok(cardTitles(m).includes("billing-idle"));
    assert.match(scopeTrigger(m).textContent || "", /All projects/);
    m.unmount();
  });

  it("primary nav is labeled Planboard and Review (#1411: no Threads icon)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    const nav = m.query("nav[aria-label='App']");
    assert.ok(nav, "app nav");
    const labels = [...nav.querySelectorAll(":scope > [data-view-nav]")].map(
      (el) => el.textContent?.trim(),
    );
    assert.deepEqual(labels, ["Planboard", "Review"]);
    assert.equal(m.query("[data-app-more]"), null, "More stays hidden until a destination is wired");
    assert.equal(m.query('[data-view-nav="activity"]'), null);
    assert.equal(m.query('[data-view-nav="kanban"]'), null);
    m.unmount();
  });

  it("planboard nav passes the scoped project id (#597)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenPlanboard: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    const btn = m.query('[data-view-nav="planboard"]') as HTMLButtonElement | null;
    assert.ok(btn, "planboard nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, ["p2"]);
    m.unmount();
  });

  it("planboard nav passes null when unscoped (#597)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenPlanboard: (pid) => {
          opened.push(pid);
        },
      }),
    );
    const btn = m.query('[data-view-nav="planboard"]') as HTMLButtonElement | null;
    assert.ok(btn, "planboard nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, [null]);
    m.unmount();
  });

  it("kanban nav passes the scoped project id (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenKanban: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    await openMoreMenu(m);
    const btn = m.query(
      '[data-app-more-menu] [data-view-nav="kanban"]',
    ) as HTMLButtonElement | null;
    assert.ok(btn, "kanban nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, ["p2"]);
    m.unmount();
  });

  it("kanban nav passes null when unscoped (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenKanban: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openMoreMenu(m);
    const btn = m.query(
      '[data-app-more-menu] [data-view-nav="kanban"]',
    ) as HTMLButtonElement | null;
    assert.ok(btn, "kanban nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, [null]);
    m.unmount();
  });

  it("activity nav passes the scoped project id (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenActivity: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openScopeMenu(m);
    await m.click(m.query('[data-scope-item="p2"]')!);
    await m.flush();
    await openMoreMenu(m);
    const btn = m.query(
      '[data-app-more-menu] [data-view-nav="activity"]',
    ) as HTMLButtonElement | null;
    assert.ok(btn, "activity nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, ["p2"]);
    m.unmount();
  });

  it("activity nav passes null when unscoped (#598)", async () => {
    await clearSidebarStorage();
    const opened: Array<string | null | undefined> = [];
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenActivity: (pid) => {
          opened.push(pid);
        },
      }),
    );
    await openMoreMenu(m);
    const btn = m.query(
      '[data-app-more-menu] [data-view-nav="activity"]',
    ) as HTMLButtonElement | null;
    assert.ok(btn, "activity nav button");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opened, [null]);
    m.unmount();
  });

  it("shows a project icon on the scope item and thread card (#610)", async () => {
    await clearSidebarStorage();
    const iconUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const m = await mount(
      sidebar(THREADS, {
        projects: [
          { ...p1, iconUrl },
          p2,
        ],
      }),
    );
    await openScopeMenu(m);
    const item = m.query('[data-scope-item="p1"]');
    assert.ok(item?.querySelector("[data-project-icon]"), "scope row glyph");
    const card = m.query('[data-thread-card="busy"]');
    assert.ok(card?.querySelector("[data-project-icon]"), "thread card glyph");
    const p2Item = m.query('[data-scope-item="p2"]');
    assert.ok(
      !p2Item?.querySelector("[data-project-icon]"),
      "a project without iconUrl gets no image icon",
    );
    assert.ok(
      p2Item?.querySelector("[data-project-avatar]"),
      "but it does get an initials tile (#1429)",
    );
    m.unmount();
  });

  it("falls back to initials avatars on scope rows and cards when no icon is resolved (#1429)", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    await openScopeMenu(m);
    assert.equal(m.queryAll("[data-project-icon]").length, 0);
    assert.ok(
      m.query('[data-scope-item="p1"] [data-project-avatar]'),
      "scope row avatar",
    );
    const cards = m.queryAll("[data-thread-card]");
    assert.ok(cards.length > 0);
    for (const card of cards) {
      assert.ok(
        card.querySelector("[data-project-avatar]"),
        `avatar on row ${card.getAttribute("data-thread-card")}`,
      );
    }
    m.unmount();
  });
});

describe("Sidebar filter columns (#746)", () => {
  function cssBlock(className: string): string {
    const css = fs
      .readFileSync("src/components/Sidebar.module.css", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return css.match(new RegExp(`\\.${className}(?![\\w-])\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  }

  it("keeps filter columns on 3 tracks and app nav as footer icons", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(THREADS, {
        projects: [p1, p2],
        onOpenActivity: () => {},
        onOpenKanban: () => {},
        onOpenAutomations: () => {},
      }),
    );
    const filters = m.query("[data-filter-row]");
    const nav = m.query("footer nav[aria-label='App']");
    assert.ok(filters, "filter row");
    assert.ok(nav, "app nav sits in the footer beside Settings");
    assert.equal(filters!.children.length, 3, "three filter columns");
    assert.deepEqual(
      [...nav!.querySelectorAll(":scope > [data-view-nav]")].map((el) =>
        el.textContent?.trim(),
      ),
      ["Planboard", "Review"],
    );
    assert.equal(nav!.querySelectorAll("[data-app-more]").length, 1);
    m.unmount();

    const threeCol = /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/;
    assert.match(cssBlock("filterRow"), threeCol, "filter labels share three equal tracks");
    assert.match(cssBlock("viewNav"), /display:\s*flex/);
    assert.match(cssBlock("viewNav"), /flex-wrap:\s*nowrap/);
    assert.doesNotMatch(cssBlock("viewNav"), /grid-template-rows/);
    assert.match(cssBlock("viewNavBtn"), /height:\s*28px/);
    assert.match(cssBlock("viewNavLabel"), /white-space:\s*nowrap/);
    assert.match(cssBlock("appMoreMenu"), /transition:\s*none/);
    assert.match(
      cssBlock("filterTrigger"),
      /justify-content:\s*center/,
      "label+chevron sit on the column centerline above the icon",
    );
    assert.doesNotMatch(
      cssBlock("filterTriggerLabel"),
      /flex:\s*1/,
      "growing the label shoved the chevron to the far edge and un-centered the column",
    );
  });
});

describe("Sidebar filters (#553)", () => {
  const moreProviders: ProviderInfo[] = [
    ...providers,
    {
      id: "codex",
      name: "Codex",
      available: true,
      supportsResume: true,
      models: [],
      modelInfo: [],
      efforts: [],
    },
  ];

  const filterThreadsList: ThreadInfo[] = [
    ...THREADS,
    thread({
      id: "waiting-you",
      title: "needs input",
      status: "working",
      awaitingInput: true,
      runStartedAt: FRESH,
      createdAt: FRESH + 60,
      updatedAt: FRESH + 60,
      projectId: "p1",
    }),
    thread({
      id: "codex-idle",
      title: "codex idle",
      status: "idle",
      provider: "codex",
      createdAt: FRESH + 5,
      updatedAt: FRESH + 5,
      projectId: "p1",
    }),
    thread({
      id: "archived-old",
      title: "archived old",
      status: "idle",
      archived: true,
      createdAt: FRESH - DAY_MS,
      updatedAt: FRESH - DAY_MS,
      projectId: "p1",
    }),
  ];

  async function openStatusMenu(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    if (!m.query("[data-status-filter-menu]")) {
      const btn = m.query("[data-status-filter-trigger]");
      assert.ok(btn, "status filter trigger");
      await m.click(btn);
      await m.flush();
    }
  }

  async function openProviderMenu(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    if (!m.query("[data-provider-filter-menu]")) {
      const btn = m.query("[data-provider-filter-trigger]");
      assert.ok(btn, "provider filter trigger");
      await m.click(btn);
      await m.flush();
    }
  }

  async function openGroupMenu(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    if (!m.query("[data-group-by-menu]")) {
      const btn = m.query("[data-group-by-trigger]");
      assert.ok(btn, "group-by trigger");
      await m.click(btn);
      await m.flush();
    }
  }

  it("filters to waiting-on-you and keeps the open thread visible", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, {
        projects: [p1, p2],
        activeThreadId: "billing-idle",
      }),
    );
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="waiting"]')!);
    await m.flush();
    const ids = cardTitles(m);
    assert.ok(ids.includes("waiting-you"));
    assert.ok(ids.includes("billing-idle"), "#70 carve-out keeps the open thread");
    assert.ok(!ids.includes("busy"));
    assert.ok(!ids.includes("broken"));
    m.unmount();
  });

  it("filters to failed and persists the status", async () => {
    await clearSidebarStorage();
    const m1 = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    await openStatusMenu(m1);
    await m1.click(m1.query('[data-status-filter="failed"]')!);
    await m1.flush();
    assert.deepEqual(cardTitles(m1), ["broken"]);
    m1.unmount();

    const m2 = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    assert.match(
      m2.query("[data-status-filter-trigger]")!.textContent || "",
      /Failed/,
    );
    assert.deepEqual(cardTitles(m2), ["broken"]);
    m2.unmount();
  });

  it("provider chips are multi-select and AND with status", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, {
        projects: [p1, p2],
        providers: moreProviders,
      }),
    );
    await openProviderMenu(m);
    assert.ok(m.query('[data-provider-filter="claude"]'));
    await m.click(m.query('[data-provider-filter="codex"]')!);
    await m.flush();
    const afterProvider = cardTitles(m);
    assert.ok(afterProvider.includes("codex-idle"));
    assert.ok(!afterProvider.includes("busy"));
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="idle"]')!);
    await m.flush();
    assert.ok(cardTitles(m).includes("codex-idle"));
    assert.ok(!cardTitles(m).includes("busy"));
    m.unmount();
  });

  it("provider chips show a harness logo next to the name", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, {
        projects: [p1, p2],
        providers: moreProviders,
      }),
    );
    await openProviderMenu(m);
    const claude = m.query('[data-provider-filter="claude"]');
    assert.ok(claude, "claude chip");
    const mark = claude!.querySelector('[data-provider-mark="claude"]');
    assert.ok(mark, "chip reuses ProviderMark, not the raw id");
    assert.ok(mark!.querySelector("svg"), "known harness is a logo");
    assert.match(
      claude!.textContent || "",
      /Claude/,
      "the display name stays on the chip",
    );
    assert.equal(
      mark!.getAttribute("aria-hidden"),
      "true",
      "visible name is the accessible name; the mark is decorative",
    );
    m.unmount();
  });

  it("archived status expands the settled shelf", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    assert.equal(m.query('[data-thread-card="archived-old"]'), null);
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="archived"]')!);
    await m.flush();
    assert.ok(m.query('[data-thread-card="archived-old"]'));
    assert.equal(
      settledToggle(m).getAttribute("aria-expanded"),
      "true",
    );
    m.unmount();
  });

  it("group by project restores per-project headers", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(THREADS, { projects: [p1, p2] }));
    assert.equal(m.query("[data-filter-group]"), null);
    await openGroupMenu(m);
    await m.click(m.query('[data-group-by="project"]')!);
    await m.flush();
    assert.ok(m.query('[data-filter-group="p1"]'));
    assert.ok(m.query('[data-filter-group="p2"]'));
    assert.equal(m.query("[data-group-chevron]"), null, "retired selector stays gone");
    assert.equal(m.query("[data-pinned-divider]"), null);
    m.unmount();
  });

  it("group by status sections the active list", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(filterThreadsList, { projects: [p1, p2] }),
    );
    await openGroupMenu(m);
    await m.click(m.query('[data-group-by="status"]')!);
    await m.flush();
    assert.ok(m.query('[data-filter-group="running"]'));
    assert.ok(m.query('[data-filter-group="waiting"]'));
    assert.ok(m.query('[data-filter-group="failed"]'));
    assert.ok(m.query('[data-filter-group="idle"]'));
    m.unmount();
  });

  it("search ANDs with status without a second message scan", async () => {
    await clearSidebarStorage();
    let calls = 0;
    const m = await mount(
      sidebar(filterThreadsList, {
        projects: [p1, p2],
        searchThreads: async ({ query }) => {
          calls += 1;
          return filterThreadsList.filter((t) => t.title.includes(query));
        },
      }),
    );
    await m.type(searchInput(m), "work");
    await inAct(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    await m.flush();
    const afterSearch = calls;
    assert.ok(afterSearch >= 1, "search ran");
    assert.ok(cardTitles(m).includes("busy"));
    assert.ok(cardTitles(m).includes("broken"));
    await openStatusMenu(m);
    await m.click(m.query('[data-status-filter="failed"]')!);
    await m.flush();
    assert.equal(calls, afterSearch, "status filter does not re-scan messages");
    assert.deepEqual(cardTitles(m), ["broken"]);
    m.unmount();
  });
});

describe("Sidebar thread tags (#789)", () => {
  const TAGGED = [
    thread({
      id: "tagged-work",
      title: "tagged work",
      status: "idle",
      updatedAt: FRESH + 50,
      projectId: "p1",
      tags: ["work"],
    }),
    thread({
      id: "tagged-both",
      title: "tagged both",
      status: "idle",
      updatedAt: FRESH + 40,
      projectId: "p1",
      tags: ["work", "bug"],
    }),
    thread({
      id: "plain",
      title: "plain",
      status: "idle",
      updatedAt: FRESH + 30,
      projectId: "p1",
    }),
  ];

  it("renders tag chips on tagged cards only", async () => {
    const m = await mount(sidebar(TAGGED, { projects: [p1] }));
    assert.ok(m.query('[data-tag-row="tagged-work"]'));
    assert.ok(m.query('[data-tag-chip="work"]'));
    assert.ok(m.query('[data-tag-chip="bug"]'));
    assert.equal(m.query('[data-tag-row="plain"]'), null);
    m.unmount();
  });

  it("menu 'Edit tags' opens the chip editor; Enter adds, × removes", async () => {
    const calls: { threadId: string; tags: string[] }[] = [];
    const m = await mount(
      sidebar(TAGGED, {
        projects: [p1],
        onSetTags: (threadId, tags) => {
          calls.push({ threadId, tags });
        },
      }),
    );
    await m.click(m.query('[data-more-btn="tagged-both"]'));
    const menu = portalMenu();
    assert.ok(menu, "… menu must open");
    const editItem = menu.querySelector("[data-edit-tags]");
    assert.ok(editItem, "Edit tags item");
    await m.click(editItem as HTMLElement);
    await m.flush();
    const input = m.query('[data-tag-input="tagged-both"]');
    assert.ok(input, "tag editor opens");
    await m.type(input, "urgent");
    await inAct(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await m.flush();
    assert.deepEqual(calls.at(-1), {
      threadId: "tagged-both",
      tags: ["work", "bug", "urgent"],
    });
    await m.click(m.query('[data-tag-remove="work"]')!);
    await m.flush();
    assert.deepEqual(calls.at(-1), { threadId: "tagged-both", tags: ["bug"] });
    m.unmount();
  });

  it("group by tag sections the active list, multi-tag threads appear twice", async () => {
    await clearSidebarStorage();
    const m = await mount(sidebar(TAGGED, { projects: [p1] }));
    await m.click(m.query("[data-group-by-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-group-by="tag"]')!);
    await m.flush();
    assert.ok(m.query('[data-filter-group="bug"]'));
    assert.ok(m.query('[data-filter-group="work"]'));
    assert.ok(m.query('[data-filter-group="untagged"]'));
    m.unmount();
  });

  it("tag trigger hides until a tag exists; filter narrows the list", async () => {
    await clearSidebarStorage();
    const untagged = await mount(sidebar(THREADS, { projects: [p1] }));
    assert.equal(
      untagged.query("[data-tag-filter-trigger]"),
      null,
      "no tags anywhere → no tag filter trigger",
    );
    untagged.unmount();

    const m = await mount(sidebar(TAGGED, { projects: [p1] }));
    await m.click(m.query("[data-tag-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-tag-filter="work"]')!);
    await m.flush();
    const ids = cardTitles(m);
    assert.ok(ids.includes("tagged-work"));
    assert.ok(ids.includes("tagged-both"));
    assert.ok(!ids.includes("plain"));
    m.unmount();
  });
});

describe("Sidebar saved filter views (#939)", () => {
  const moreProviders: ProviderInfo[] = [
    ...providers,
    {
      id: "codex",
      name: "Codex",
      available: true,
      supportsResume: true,
      models: [],
      modelInfo: [],
      efforts: [],
    },
  ];

  const viewThreads: ThreadInfo[] = [
    thread({
      id: "busy",
      title: "busy work",
      status: "working",
      runStartedAt: FRESH,
      createdAt: FRESH + 50,
      updatedAt: FRESH + 50,
      projectId: "p1",
    }),
    thread({
      id: "codex-fail",
      title: "codex fail",
      status: "failed",
      provider: "codex",
      createdAt: FRESH + 40,
      updatedAt: FRESH + 40,
      projectId: "p1",
    }),
    thread({
      id: "release-tag",
      title: "release tagged",
      status: "idle",
      tags: ["release"],
      createdAt: FRESH + 30,
      updatedAt: FRESH + 30,
      projectId: "p1",
    }),
    thread({
      id: "billing-idle",
      title: "billing idle",
      status: "idle",
      createdAt: FRESH + 10,
      updatedAt: FRESH + 10,
      projectId: "p2",
    }),
  ];

  async function openViewsMenu(
    m: Awaited<ReturnType<typeof mount>>,
  ): Promise<void> {
    if (!m.query("[data-saved-views-menu]")) {
      const btn = m.query("[data-saved-views-trigger]");
      assert.ok(btn, "saved views trigger");
      await m.click(btn);
      await m.flush();
    }
  }

  async function saveCurrentView(
    m: Awaited<ReturnType<typeof mount>>,
    name: string,
  ): Promise<void> {
    await openViewsMenu(m);
    const save = m.query("[data-saved-view-save]");
    assert.ok(save, "Save current as");
    await m.click(save);
    await m.flush();
    const input = m.query("[data-saved-view-name]") as HTMLInputElement | null;
    assert.ok(input, "name input");
    await m.type(input, name);
    const confirm = m.query("[data-saved-view-save-confirm]");
    assert.ok(confirm, "save confirm");
    await m.click(confirm);
    await m.flush();
  }

  it("saves two combinations and recalls them independently after remount", async () => {
    await clearSidebarStorage();
    const opts = { projects: [p1, p2], providers: moreProviders };
    const m1 = await mount(sidebar(viewThreads, opts));
    await m1.click(m1.query("[data-status-filter-trigger]")!);
    await m1.flush();
    await m1.click(m1.query('[data-status-filter="failed"]')!);
    await m1.flush();
    await m1.click(m1.query("[data-provider-filter-trigger]")!);
    await m1.flush();
    await m1.click(m1.query('[data-provider-filter="codex"]')!);
    await m1.flush();
    await saveCurrentView(m1, "Failed Codex threads");
    assert.deepEqual(cardTitles(m1), ["codex-fail"]);
    m1.unmount();

    const m2 = await mount(sidebar(viewThreads, opts));
    await m2.click(m2.query("[data-status-filter-trigger]")!);
    await m2.flush();
    await m2.click(m2.query('[data-status-filter="all"]')!);
    await m2.flush();
    await m2.click(m2.query("[data-provider-filter-trigger]")!);
    await m2.flush();
    await m2.click(m2.query('[data-provider-filter="all"]')!);
    await m2.flush();
    await m2.click(m2.query("[data-tag-filter-trigger]")!);
    await m2.flush();
    await m2.click(m2.query('[data-tag-filter="release"]')!);
    await m2.flush();
    await saveCurrentView(m2, "Release-tagged threads");
    assert.deepEqual(cardTitles(m2), ["release-tag"]);
    m2.unmount();

    const m3 = await mount(sidebar(viewThreads, opts));
    await openViewsMenu(m3);
    await m3.click(m3.query('[data-saved-view-label="Failed Codex threads"]')!);
    await m3.flush();
    assert.deepEqual(cardTitles(m3), ["codex-fail"]);
    assert.match(
      m3.query("[data-saved-views-trigger]")!.textContent || "",
      /Failed Codex threads/,
    );
    m3.unmount();

    const m4 = await mount(sidebar(viewThreads, opts));
    await openViewsMenu(m4);
    await m4.click(m4.query('[data-saved-view-label="Release-tagged threads"]')!);
    await m4.flush();
    assert.deepEqual(cardTitles(m4), ["release-tag"]);
    m4.unmount();

    const m5 = await mount(sidebar(viewThreads, opts));
    await openViewsMenu(m5);
    await m5.click(m5.query('[data-saved-view-label="Failed Codex threads"]')!);
    await m5.flush();
    assert.deepEqual(cardTitles(m5), ["codex-fail"]);
    m5.unmount();
  });

  it("marks the active view modified when filters change, and update restores it", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(viewThreads, { projects: [p1, p2], providers: moreProviders }),
    );
    await m.click(m.query("[data-status-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-status-filter="failed"]')!);
    await m.flush();
    await saveCurrentView(m, "Failed");
    assert.equal(
      m.query("[data-saved-views-trigger]")!.getAttribute("data-modified"),
      null,
    );
    await m.click(m.query("[data-status-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-status-filter="idle"]')!);
    await m.flush();
    assert.equal(
      m.query("[data-saved-views-trigger]")!.getAttribute("data-modified"),
      "true",
    );
    await openViewsMenu(m);
    await m.click(m.query("[data-saved-view-update]")!);
    await m.flush();
    assert.equal(
      m.query("[data-saved-views-trigger]")!.getAttribute("data-modified"),
      null,
    );
    assert.ok(cardTitles(m).includes("release-tag"));
    assert.ok(!cardTitles(m).includes("codex-fail"));
    m.unmount();
  });

  it("new matching threads appear because views store criteria, not ids", async () => {
    await clearSidebarStorage();
    const opts = { projects: [p1, p2], providers: moreProviders };
    const m = await mount(sidebar(viewThreads, opts));
    await m.click(m.query("[data-status-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-status-filter="failed"]')!);
    await m.flush();
    await m.click(m.query("[data-provider-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-provider-filter="codex"]')!);
    await m.flush();
    await saveCurrentView(m, "Failed Codex");
    assert.deepEqual(cardTitles(m), ["codex-fail"]);
    await m.rerender(
      sidebar(
        [
          ...viewThreads,
          thread({
            id: "codex-fail-new",
            title: "new failure",
            status: "failed",
            provider: "codex",
            createdAt: FRESH + 80,
            updatedAt: FRESH + 80,
            projectId: "p1",
          }),
        ],
        opts,
      ),
    );
    const ids = cardTitles(m);
    assert.ok(ids.includes("codex-fail"));
    assert.ok(ids.includes("codex-fail-new"));
    assert.ok(!ids.includes("release-tag"));
    m.unmount();
  });

  it("explains the open-thread carve-out when it misses the filter", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(viewThreads, {
        projects: [p1, p2],
        providers: moreProviders,
        activeThreadId: "billing-idle",
      }),
    );
    await m.click(m.query("[data-status-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-status-filter="failed"]')!);
    await m.flush();
    assert.ok(cardTitles(m).includes("billing-idle"));
    const note = m.query("[data-filter-carve-out]");
    assert.ok(note, "carve-out is visible");
    assert.match(
      note!.textContent || "",
      /open thread stays visible/i,
    );
    m.unmount();
  });

  it("a missing project on an active view is unavailable, not silently broadened", async () => {
    await clearSidebarStorage();
    const { serializeSavedViews, addSavedView } = await import(
      "../src/sidebarViews.ts"
    );
    const views = addSavedView([], {
      name: "Gone project",
      criteria: {
        status: null,
        providers: [],
        projectId: "missing-project",
        tag: null,
        query: "",
        groupBy: "none",
      },
      now: 1,
      id: "v-gone",
    });
    window.localStorage.setItem("sidebar:savedViews", serializeSavedViews(views));
    window.localStorage.setItem("sidebar:activeSavedView", "v-gone");
    window.localStorage.setItem("sidebar:projectScope", "missing-project");
    const m = await mount(
      sidebar(viewThreads, { projects: [p1, p2], providers: moreProviders }),
    );
    const unavailable = m.query("[data-view-unavailable]");
    assert.ok(unavailable, "explicit unavailable state");
    assert.match(
      unavailable!.textContent || "",
      /project is no longer available/i,
    );
    assert.equal(
      cardTitles(m).length,
      0,
      "must not fall back to all projects",
    );
    m.unmount();
  });

  it("renames the active view from the same menu", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(viewThreads, { projects: [p1, p2], providers: moreProviders }),
    );
    await m.click(m.query("[data-status-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-status-filter="failed"]')!);
    await m.flush();
    await saveCurrentView(m, "Failed");
    await openViewsMenu(m);
    await m.click(m.query("[data-saved-view-rename]")!);
    await m.flush();
    const input = m.query("[data-saved-view-name]") as HTMLInputElement | null;
    assert.ok(input, "rename input");
    await m.type(input, "Failed Codex");
    await m.click(m.query("[data-saved-view-save-confirm]")!);
    await m.flush();
    assert.match(
      m.query("[data-saved-views-trigger]")!.textContent || "",
      /Failed Codex/,
    );
    assert.ok(m.query('[data-saved-view-label="Failed Codex"]'));
    m.unmount();
  });

  it("deleting a saved view leaves threads in place", async () => {
    await clearSidebarStorage();
    const m = await mount(
      sidebar(viewThreads, { projects: [p1, p2], providers: moreProviders }),
    );
    await m.click(m.query("[data-status-filter-trigger]")!);
    await m.flush();
    await m.click(m.query('[data-status-filter="failed"]')!);
    await m.flush();
    await saveCurrentView(m, "Failed");
    const before = cardTitles(m);
    await openViewsMenu(m);
    await m.click(m.query("[data-saved-view-delete]")!);
    await m.flush();
    assert.deepEqual(cardTitles(m), before);
    assert.equal(
      m.query('[data-saved-view-label="Failed"]'),
      null,
    );
    m.unmount();
  });
});
