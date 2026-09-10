/**
 * Onboarding setup step: project-first add/done states, optional
 * worktree / delegation / budget defaults behind a native disclosure,
 * Enable both, and inline budget validation.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/onboardingSetup.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { AppSettings } from "../src/shared/ipc";

async function boot(
  fake: ReturnType<typeof createFakeCoder>,
): Promise<Awaited<ReturnType<typeof mount>>> {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

/** Advance until setup. cli → setup is one Next; still works if welcome exists. */
async function gotoSetup(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const id = m
      .query("[data-onboarding-step]")
      ?.getAttribute("data-onboarding-step");
    if (id === "setup") return;
    const next = m.query("[data-onboarding-next]") as HTMLButtonElement | null;
    assert.ok(next, "Next control must exist while seeking setup");
    if (id === "tour" || next.textContent?.trim() === "Finish") break;
    await m.click(next);
  }
  assert.equal(
    m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
    "setup",
    "must land on the setup step",
  );
}

async function setOptionalOpen(
  m: Awaited<ReturnType<typeof mount>>,
  open: boolean,
): Promise<HTMLDetailsElement> {
  const details = m.query(
    "[data-onboarding-optional-defaults]",
  ) as HTMLDetailsElement | null;
  assert.ok(details, "optional defaults disclosure must render");
  if (details.open !== open) {
    await inAct(() => {
      details.open = open;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await m.flush();
  }
  assert.equal(
    details.open,
    open,
    open
      ? "optional defaults must be open"
      : "optional defaults must be collapsed",
  );
  return details;
}

async function openOptional(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<HTMLDetailsElement> {
  const details = await setOptionalOpen(m, true);
  assert.ok(
    m.query("[data-onboarding-default-worktree]"),
    "opening optional defaults must reveal the controls",
  );
  return details;
}

function settingsPatches(
  fake: ReturnType<typeof createFakeCoder>,
): Partial<AppSettings>[] {
  return fake.of("settings.set").map((c) => c.args[0] as Partial<AppSettings>);
}

describe("Onboarding setup step (#630)", () => {
  it("offers Add project when there are none, and opens the add-project modal", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      projects: [],
    });
    const m = await boot(fake);
    await gotoSetup(m);

    const add = m.query("[data-onboarding-add-project]");
    assert.ok(add, "zero projects must show the Add project button");
    assert.ok(
      !m.query("[data-onboarding-projects-done]"),
      "zero projects must not show the done-state",
    );
    assert.ok(
      m.text().includes("not a git repo"),
      "must mention that a non-repo folder is initialized automatically",
    );

    await m.click(add);
    assert.ok(
      m.query("[data-add-project-path]"),
      "Add project must open the existing add-project modal",
    );
    assert.ok(
      m.query("[data-add-project-path-input]"),
      "add-project modal must expose its path input",
    );
    m.unmount();
  });

  it("shows a done-state with the project count and name", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      projects: [
        project({ id: "p1", name: "solenta", slug: "currentbits/solenta" }),
        project({ id: "p2", name: "girder", slug: "currentbits/girder" }),
      ],
    });
    const m = await boot(fake);
    await gotoSetup(m);

    const done = m.query("[data-onboarding-projects-done]");
    assert.ok(done, "existing projects must show the done-state");
    const text = (done.textContent || "").replace(/\s+/g, " ");
    assert.ok(
      text.includes("2 projects added"),
      `done-state must show the count, got: ${text}`,
    );
    assert.ok(text.includes("solenta"), "done-state must list the first project");
    assert.ok(text.includes("girder"), "done-state must list the second project");
    assert.ok(
      !m.query("[data-onboarding-add-project]"),
      "done-state must not offer Add project",
    );
    m.unmount();
  });

  it("keeps optional defaults collapsed until the summary is opened", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);

    const details = m.query(
      "[data-onboarding-optional-defaults]",
    ) as HTMLDetailsElement | null;
    assert.ok(details, "optional defaults disclosure must render");
    assert.equal(details.open, false, "optional defaults must start collapsed");
    const summary = m.query(
      "[data-onboarding-optional-summary]",
    ) as HTMLElement | null;
    assert.ok(summary, "optional defaults summary must render");
    assert.match(
      (summary.textContent || "").trim(),
      /Optional defaults/,
      "summary must be labelled Optional defaults",
    );
    assert.equal(
      summary.tabIndex,
      0,
      "summary must be tabbable for the modal focus trap",
    );
    await inAct(() => {
      summary.focus();
    });
    assert.equal(
      summary.ownerDocument.activeElement,
      summary,
      "summary must be keyboard-focusable",
    );
    assert.ok(
      !m.query("[data-onboarding-default-worktree]"),
      "worktree control must stay hidden while collapsed",
    );
    assert.ok(
      !m.query("[data-onboarding-recommended]"),
      "Enable both must stay hidden while collapsed",
    );
    assert.ok(
      !m.query("[data-onboarding-budget]"),
      "budget control must stay hidden while collapsed",
    );

    await openOptional(m);
    assert.ok(
      m.query("[data-onboarding-default-worktree]"),
      "opening the disclosure must reveal the worktree control",
    );
    assert.ok(
      m.text().includes("now or later in Settings"),
      "optional copy must not claim new threads start without saved defaults",
    );
    m.unmount();
  });

  it("toggling worktree records settings.set with defaultWorktree: true", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const box = m.query(
      "[data-onboarding-default-worktree]",
    ) as HTMLInputElement | null;
    assert.ok(box, "worktree toggle must render");
    assert.equal(box.checked, false, "defaultWorktree ships off");

    await m.click(box);
    const patches = settingsPatches(fake);
    assert.ok(
      patches.some((p) => p.defaultWorktree === true),
      `worktree toggle must call settings.set with defaultWorktree: true, got: ${JSON.stringify(patches)}`,
    );
    m.unmount();
  });

  it("Enable both records defaultWorktree and defaultOrchestrate on", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const rec = m.query("[data-onboarding-recommended]");
    assert.ok(rec, "Enable both must render");
    assert.match(
      (rec.textContent || "").trim(),
      /Enable both/,
      `button must read Enable both, got: ${rec.textContent}`,
    );
    await m.click(rec);

    const patches = settingsPatches(fake);
    assert.ok(
      patches.some(
        (p) => p.defaultWorktree === true && p.defaultOrchestrate === true,
      ),
      `Enable both must save both flags, got: ${JSON.stringify(patches)}`,
    );
    m.unmount();
  });

  it("saved worktree and budget persist in the controls", async () => {
    const fake = createFakeCoder({
      settings: {
        onboardingSeen: false,
        defaultWorktree: true,
        dailyBudgetUsd: 25,
      },
    });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const worktree = m.query(
      "[data-onboarding-default-worktree]",
    ) as HTMLInputElement | null;
    const budget = m.query("[data-onboarding-budget]") as HTMLInputElement | null;
    assert.ok(worktree && budget, "optional controls must render");
    assert.equal(worktree.checked, true, "saved worktree default must stay on");
    assert.equal(budget.value, "25", "saved daily budget must fill the input");

    await m.type(budget, "40");
    await m.click(m.query("[data-onboarding-budget-save]"));
    const patches = settingsPatches(fake);
    assert.ok(
      patches.some((p) => p.dailyBudgetUsd === 40),
      `budget 40 must save, got: ${JSON.stringify(patches)}`,
    );

    await setOptionalOpen(m, false);
    assert.ok(
      !m.query("[data-onboarding-budget]"),
      "collapse must unmount optional controls",
    );
    await openOptional(m);
    const worktreeAgain = m.query(
      "[data-onboarding-default-worktree]",
    ) as HTMLInputElement | null;
    const budgetAgain = m.query(
      "[data-onboarding-budget]",
    ) as HTMLInputElement | null;
    assert.ok(worktreeAgain && budgetAgain, "reopen must restore the controls");
    assert.equal(
      worktreeAgain.checked,
      true,
      "worktree default must survive collapse",
    );
    assert.equal(
      budgetAgain.value,
      "40",
      "saved budget must survive collapse",
    );
    m.unmount();
  });

  it("budget input 12 saves 12 and empty saves null", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const input = m.query("[data-onboarding-budget]");
    const save = m.query("[data-onboarding-budget-save]");
    assert.ok(input, "budget input must render");
    assert.ok(save, "budget Save must render");

    await m.type(input, "12");
    await m.click(save);
    const afterNumber = settingsPatches(fake);
    assert.ok(
      afterNumber.some((p) => p.dailyBudgetUsd === 12),
      `budget 12 must save dailyBudgetUsd 12, got: ${JSON.stringify(afterNumber)}`,
    );

    await m.type(input, "");
    await m.click(save);
    const afterEmpty = settingsPatches(fake);
    assert.ok(
      afterEmpty.some(
        (p) =>
          Object.prototype.hasOwnProperty.call(p, "dailyBudgetUsd") &&
          p.dailyBudgetUsd === null,
      ),
      `empty budget must save dailyBudgetUsd null, got: ${JSON.stringify(afterEmpty)}`,
    );
    m.unmount();
  });

  it("invalid budget is rejected inline without calling settings.set", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const input = m.query("[data-onboarding-budget]");
    const save = m.query("[data-onboarding-budget-save]");
    assert.ok(input && save, "budget controls must render");

    await m.type(input, "0");
    await m.click(save);

    const err = m.query("[data-onboarding-setup-error]");
    assert.ok(err, "invalid budget must render data-onboarding-setup-error");
    assert.ok(
      (err.textContent || "").includes("above 0"),
      `error must explain a budget above 0, got: ${err.textContent}`,
    );
    assert.ok(
      !(err.textContent || "").includes("null"),
      `visible copy must not say null, got: ${err.textContent}`,
    );
    const afterZero = settingsPatches(fake);
    assert.ok(
      !afterZero.some((p) =>
        Object.prototype.hasOwnProperty.call(p, "dailyBudgetUsd"),
      ),
      `zero must not reach settings.set, got: ${JSON.stringify(afterZero)}`,
    );

    await m.type(input, "-3");
    await m.click(save);
    const afterNeg = settingsPatches(fake);
    assert.ok(
      !afterNeg.some((p) =>
        Object.prototype.hasOwnProperty.call(p, "dailyBudgetUsd"),
      ),
      `negative must not reach settings.set, got: ${JSON.stringify(afterNeg)}`,
    );
    assert.ok(
      (m.query("[data-onboarding-setup-error]")?.textContent || "").includes(
        "above 0",
      ),
      "negative must keep the above-0 error",
    );
    m.unmount();
  });

  it("unsaved budget draft survives collapse", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const input = m.query("[data-onboarding-budget]");
    assert.ok(input, "budget input must render");
    await m.type(input, "18");
    const before = settingsPatches(fake).filter((p) =>
      Object.prototype.hasOwnProperty.call(p, "dailyBudgetUsd"),
    );

    await setOptionalOpen(m, false);
    assert.ok(
      !m.query("[data-onboarding-budget]"),
      "collapse must unmount the budget input",
    );

    await openOptional(m);
    const again = m.query("[data-onboarding-budget]") as HTMLInputElement | null;
    assert.ok(again, "reopen must restore the budget input");
    assert.equal(again.value, "18", "unsaved budget draft must survive collapse");
    const after = settingsPatches(fake).filter((p) =>
      Object.prototype.hasOwnProperty.call(p, "dailyBudgetUsd"),
    );
    assert.equal(
      after.length,
      before.length,
      "collapse must not save the unsaved draft",
    );
    m.unmount();
  });

  it("malformed number input does not clear an existing cap", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false, dailyBudgetUsd: 25 },
    });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const input = m.query("[data-onboarding-budget]") as HTMLInputElement | null;
    const save = m.query("[data-onboarding-budget-save]");
    assert.ok(input && save, "budget controls must render");
    assert.equal(input.value, "25", "existing cap must fill the input");

    Object.defineProperty(input, "validity", {
      configurable: true,
      get: () => ({ badInput: true }),
    });
    await m.type(input, "");
    await m.click(save);

    const err = m.query("[data-onboarding-setup-error]");
    assert.ok(err, "badInput must render data-onboarding-setup-error");
    assert.ok(
      (err.textContent || "").includes("leave it blank"),
      `error must explain blank vs invalid, got: ${err.textContent}`,
    );
    const patches = settingsPatches(fake);
    assert.ok(
      !patches.some(
        (p) =>
          Object.prototype.hasOwnProperty.call(p, "dailyBudgetUsd") &&
          p.dailyBudgetUsd === null,
      ),
      `badInput must not save a cleared cap, got: ${JSON.stringify(patches)}`,
    );
    m.unmount();
  });

  it("a rejected save shows an inline error", async () => {
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      fail: { "settings.set": new Error("could not write settings") },
    });
    const m = await boot(fake);
    await gotoSetup(m);
    await openOptional(m);

    const box = m.query("[data-onboarding-default-worktree]");
    assert.ok(box, "worktree toggle must render");
    await m.click(box);

    const err = m.query("[data-onboarding-setup-error]");
    assert.ok(err, "rejected save must render data-onboarding-setup-error");
    assert.ok(
      (err.textContent || "").includes("could not write settings"),
      `error must show the async message, got: ${err.textContent}`,
    );
    m.unmount();
  });
});
