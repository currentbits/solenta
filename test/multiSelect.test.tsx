/**
 * Round 46 multi-select, batch toolbar, jump shortcuts, keyboard sheet.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { useState } from "react";
import { inAct, mount } from "./support/dom";
import { Sidebar } from "../src/components/Sidebar";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";
import { thread as mkThread } from "./support/fakeCoder";

const NOW = Date.now();
const p1: ProjectInfo = {
  id: "p1",
  slug: "acme/alpha",
  name: "alpha",
  path: "/a",
};
const p2: ProjectInfo = {
  id: "p2",
  slug: "acme/beta",
  name: "beta",
  path: "/b",
};
const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

function th(
  id: string,
  over: Partial<ThreadInfo> = {},
): ThreadInfo {
  return mkThread({
    id,
    title: id,
    projectId: "p1",
    updatedAt: NOW,
    ...over,
  });
}

/** Fixture: pinned + two projects + snoozed + settled; active = noise (not interesting). */
function fullFixture(): ThreadInfo[] {
  return [
    th("noise", { projectId: "p1", updatedAt: NOW + 100 }),
    th("pin-mid", { projectId: "p2", pinnedAt: NOW - 5000, updatedAt: NOW + 50 }),
    th("p1-mid", { projectId: "p1", updatedAt: NOW + 40 }),
    th("p2-mid", { projectId: "p2", updatedAt: NOW + 30 }),
    th("working-x", {
      projectId: "p1",
      status: "working",
      runStartedAt: NOW,
      updatedAt: NOW + 20,
    }),
    th("snooze-mid", {
      projectId: "p2",
      snoozedUntil: NOW + 60_000,
      snoozedAt: NOW - 1000,
      updatedAt: NOW - 2000,
    }),
    th("settled-mid", {
      projectId: "p1",
      status: "done",
      prState: "MERGED",
      settledAt: NOW - 100,
      updatedAt: NOW - 100,
    }),
  ];
}

function Host({
  initial = fullFixture(),
  onRemoveProject,
}: {
  initial?: ThreadInfo[];
  onRemoveProject?: (projectId: string) => void | Promise<void>;
}) {
  const [threads, setThreads] = useState(initial);
  const [active, setActive] = useState("noise");
  const patch = (id: string, fn: (t: ThreadInfo) => ThreadInfo) =>
    setThreads((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  // Force shelves open via data attributes after mount is handled in tests
  // by clicking headers. Provide settled/snoozed in list for partition.
  return (
    <div data-host="">
      <Sidebar
        appName="Coder"
        searchPlaceholder="Search"
        projectsHeader="All projects"
        projects={[p1, p2]}
        threads={threads}
        providers={providers}
        activeThreadId={active}
        onSelectThread={setActive}
        onCreateThread={() => {}}
        onAddProject={() => {}}
        onRemoveProject={onRemoveProject}
        onSetSettled={(id, override) => {
          patch(id, (t) => ({
            ...t,
            settledOverride: override,
            settledAt: override ? Date.now() : null,
            pinnedAt: override === "settled" ? null : t.pinnedAt,
          }));
        }}
        onSetArchived={(id, archived) => {
          patch(id, (t) => ({ ...t, archived }));
        }}
        onSetPinned={(id, pinned) => {
          patch(id, (t) => ({
            ...t,
            pinnedAt: pinned ? Date.now() : null,
            settledOverride:
              pinned && t.settledOverride === "settled"
                ? null
                : t.settledOverride,
            settledAt:
              pinned && t.settledOverride === "settled" ? null : t.settledAt,
          }));
        }}
        onSetSnoozed={(id, until) => {
          patch(id, (t) => ({
            ...t,
            snoozedUntil: until,
            snoozedAt: until == null ? null : Date.now(),
          }));
        }}
        searchThreads={async () => threads}
      />
    </div>
  );
}

async function openShelves(m: Awaited<ReturnType<typeof mount>>) {
  const snoozeH = m.query("[data-snoozed-header]");
  if (snoozeH) {
    await m.click(snoozeH);
    await m.flush();
  }
  const settledH = m
    .queryAll("button")
    .find((b) => (b.textContent || "").includes("Settled ·"));
  if (settledH) {
    await m.click(settledH);
    await m.flush();
  }
}

function dispatchKey(
  type: "keydown" | "keyup",
  key: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
  target: EventTarget = document,
) {
  const ev = new KeyboardEvent(type, {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  });
  target.dispatchEvent(ev);
}

describe("Sidebar multi-select (round 46)", () => {
  it("cmd+click toggles; plain click clears; toolbar at 2+", async () => {
    const m = await mount(<Host />);
    await openShelves(m);

    const card = m.query('[data-thread-card="p1-mid"]');
    assert.ok(card);
    const btn = card!.querySelector("button")!;
    // meta click
    await inAct(async () => {
      btn.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          metaKey: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();
    assert.equal(card!.getAttribute("data-multi"), "true");

    const card2 = m.query('[data-thread-card="p2-mid"]');
    const btn2 = card2!.querySelector("button")!;
    await inAct(async () => {
      btn2.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          metaKey: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();

    assert.ok(m.query("[data-batch-bar]"), "toolbar at 2+");
    assert.ok(
      (m.query("[data-batch-count]")?.textContent || "").includes("2 selected"),
    );

    // Plain click clears multi
    await inAct(async () => {
      btn.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await m.flush();
    assert.equal(
      m.query("[data-batch-bar]") != null,
      false,
      "plain click clears multi-select toolbar",
    );
    m.unmount();
  });

  it("shift-click range crosses section boundary into settled tail", async () => {
    const m = await mount(<Host />);
    await openShelves(m);

    // Anchor on p1-mid (attention), shift-click settled-mid
    const a = m.query('[data-thread-card="p1-mid"]')!.querySelector("button")!;
    await inAct(async () => {
      a.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          metaKey: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();

    const b = m
      .query('[data-thread-card="settled-mid"]')!
      .querySelector("button")!;
    await inAct(async () => {
      b.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          shiftKey: true,
          cancelable: true,
        }),
      );
    });
    await m.flush();

    // Range should include mid attention rows + snooze + settled
    assert.equal(
      m.query('[data-thread-card="p1-mid"]')?.getAttribute("data-multi"),
      "true",
    );
    assert.equal(
      m.query('[data-thread-card="settled-mid"]')?.getAttribute("data-multi"),
      "true",
    );
    assert.ok(m.query("[data-batch-bar]"));
    m.unmount();
  });

  it("batch archive records setArchived for each selected id", async () => {
    const archived: string[] = [];

    function HostTrack() {
      const [threads, setThreads] = useState(fullFixture());
      return (
        <Sidebar
          appName="Coder"
          searchPlaceholder="S"
          projectsHeader="All"
          projects={[p1, p2]}
          threads={threads}
          providers={providers}
          activeThreadId="noise"
          onSelectThread={() => {}}
          onCreateThread={() => {}}
          onAddProject={() => {}}
          onSetArchived={(id, a) => {
            archived.push(id);
            setThreads((prev) =>
              prev.map((t) => (t.id === id ? { ...t, archived: a } : t)),
            );
          }}
          onSetSettled={() => {}}
          searchThreads={async () => threads}
        />
      );
    }

    const m = await mount(<HostTrack />);
    await openShelves(m);

    for (const id of ["p1-mid", "working-x", "p2-mid"]) {
      const btn = m.query(`[data-thread-card="${id}"]`)!.querySelector("button")!;
      await inAct(async () => {
        btn.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            metaKey: true,
            cancelable: true,
          }),
        );
      });
      await m.flush();
    }
    assert.ok(m.query("[data-batch-archive]"), "toolbar must render at 2+");

    await m.click(m.query("[data-batch-archive]")!);
    await m.flush();
    assert.deepEqual(archived.sort(), ["p1-mid", "p2-mid", "working-x"].sort());
    assert.equal(
      m.query("[data-batch-count]") != null,
      false,
      "selection cleared after batch archive",
    );
    m.unmount();
  });

  it("batch settle skips working; records only idle; feedback + clear", async () => {
    // Fresh fixture — do not reuse threads archived by another test half.
    const settled: string[] = [];

    function HostSettle() {
      const [threads, setThreads] = useState(fullFixture());
      return (
        <Sidebar
          appName="Coder"
          searchPlaceholder="S"
          projectsHeader="All"
          projects={[p1, p2]}
          threads={threads}
          providers={providers}
          activeThreadId="noise"
          onSelectThread={() => {}}
          onCreateThread={() => {}}
          onAddProject={() => {}}
          onSetArchived={() => {}}
          onSetSettled={(id, o) => {
            settled.push(id);
            setThreads((prev) =>
              prev.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      settledOverride: o,
                      settledAt: o ? Date.now() : null,
                    }
                  : t,
              ),
            );
          }}
          searchThreads={async () => threads}
        />
      );
    }

    const m = await mount(<HostSettle />);
    await openShelves(m);

    // Mixed selection: 2 idle + 1 working (interesting rows not index 0).
    for (const id of ["p1-mid", "working-x", "p2-mid"]) {
      const card = m.query(`[data-thread-card="${id}"]`);
      assert.ok(card, `fixture must expose ${id}`);
      const btn = card!.querySelector("button")!;
      await inAct(async () => {
        btn.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            metaKey: true,
            cancelable: true,
          }),
        );
      });
      await m.flush();
    }

    const settleBtn = m.query("[data-batch-settle]");
    assert.ok(settleBtn, "toolbar Settle must render at 2+ selected");

    await m.click(settleBtn!);
    await m.flush();

    assert.deepEqual(
      settled.slice().sort(),
      ["p1-mid", "p2-mid"].sort(),
      "exactly 2 setSettled calls for the idle ids",
    );
    assert.equal(
      settled.includes("working-x"),
      false,
      "working thread must not receive setSettled",
    );
    assert.equal(
      m.query("[data-batch-feedback]")?.textContent,
      "2 settled · 1 skipped (running)",
    );
    assert.equal(
      m.query("[data-batch-count]") != null,
      false,
      "selection cleared after batch settle",
    );
    assert.equal(
      m.query('[data-thread-card="p1-mid"]')?.getAttribute("data-multi"),
      null,
    );
    m.unmount();
  });
});

describe("Sidebar jump shortcuts (round 46)", () => {
  it("cmd+3 selects 3rd visible; hints show on cmd and clear on keyup/blur", async () => {
    const m = await mount(<Host />);
    await openShelves(m);
    await m.flush();

    // Hold cmd
    await inAct(async () => {
      dispatchKey("keydown", "Meta", { metaKey: true });
    });
    await m.flush();
    assert.ok(
      m.query("[data-index-hint]") || m.queryAll("[data-index-hint]").length > 0,
      "index hints while cmd held",
    );

    await inAct(async () => {
      dispatchKey("keydown", "3", { metaKey: true });
    });
    await m.flush();
    // 3rd visible: pin-mid is 1st (index 0), noise might be in p1...
    // Order: pin-mid, noise, p1-mid, working-x, p2-mid, snooze-mid, settled-mid
    // cmd+3 → index 2 = p1-mid
    assert.equal(
      m.query('[data-thread-card="p1-mid"]')?.getAttribute("data-active"),
      "true",
    );

    await inAct(async () => {
      dispatchKey("keyup", "Meta");
    });
    await m.flush();
    assert.equal(
      m.queryAll("[data-index-hint]").length,
      0,
      "hints clear on keyup",
    );

    await inAct(async () => {
      dispatchKey("keydown", "Meta", { metaKey: true });
    });
    await m.flush();
    await inAct(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await m.flush();
    assert.equal(
      m.queryAll("[data-index-hint]").length,
      0,
      "hints clear on window blur",
    );
    m.unmount();
  });

  it("cmd+j / cmd+k wrap through the list", async () => {
    const m = await mount(<Host />);
    await openShelves(m);
    // Order: pin-mid, noise, …, settled-mid. Start at pin-mid, cmd+k wraps to last.
    const pinBtn = m
      .query('[data-thread-card="pin-mid"]')!
      .querySelector("button")!;
    await m.click(pinBtn);
    await m.flush();
    assert.equal(
      m.query("[data-thread-card][data-active=true]")?.getAttribute(
        "data-thread-card",
      ),
      "pin-mid",
    );

    await inAct(async () => {
      dispatchKey("keydown", "k", { metaKey: true });
    });
    await m.flush();
    assert.equal(
      m.query("[data-thread-card][data-active=true]")?.getAttribute(
        "data-thread-card",
      ),
      "settled-mid",
      "cmd+k from first wraps to last",
    );

    await inAct(async () => {
      dispatchKey("keydown", "j", { metaKey: true });
    });
    await m.flush();
    assert.equal(
      m.query("[data-thread-card][data-active=true]")?.getAttribute(
        "data-thread-card",
      ),
      "pin-mid",
      "cmd+j from last wraps to first",
    );
    m.unmount();
  });
});

describe("Keyboard sheet (round 46)", () => {
  it("? opens sheet; Escape closes; ? in textarea is ignored", async () => {
    const m = await mount(<Host />);
    await inAct(async () => {
      dispatchKey("keydown", "?");
    });
    await m.flush();
    assert.ok(m.query("[data-keyboard-sheet]"), "? opens sheet");

    await inAct(async () => {
      dispatchKey("keydown", "Escape");
    });
    await m.flush();
    assert.equal(
      m.query("[data-keyboard-sheet]") != null,
      false,
      "Escape closes sheet",
    );

    // Focus a textarea
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    await inAct(async () => {
      dispatchKey("keydown", "?", {}, ta);
    });
    await m.flush();
    assert.equal(
      m.query("[data-keyboard-sheet]") != null,
      false,
      "? in textarea does nothing",
    );
    ta.remove();
    m.unmount();
  });

  it("shortcuts dead while a modal dialog is open", async () => {
    const m = await mount(<Host onRemoveProject={() => {}} />);
    await openShelves(m);

    const remove = m.query('[data-project-remove="p1"]');
    assert.ok(remove, "remove control requires onRemoveProject on Host");
    await m.click(remove!);
    await m.flush();

    const dialog = m.query('[role="dialog"]');
    assert.ok(dialog, "confirm dialog must open");
    assert.ok(
      m.query('[data-remove-confirm="p1"]'),
      "real remove-project confirm, not a stub",
    );

    // Active stays noise; none of the jump / sheet shortcuts may act.
    await inAct(async () => {
      dispatchKey("keydown", "3", { metaKey: true });
    });
    await m.flush();
    await inAct(async () => {
      dispatchKey("keydown", "j", { metaKey: true });
    });
    await m.flush();
    await inAct(async () => {
      dispatchKey("keydown", "?");
    });
    await m.flush();

    assert.equal(
      m.query("[data-thread-card][data-active=true]")?.getAttribute(
        "data-thread-card",
      ),
      "noise",
      "cmd+3 / cmd+j must no-op while modal open",
    );
    assert.equal(
      m.query("[data-keyboard-sheet]") != null,
      false,
      "? must not open keyboard sheet while modal open",
    );
    m.unmount();
  });
});
