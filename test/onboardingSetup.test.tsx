/**
 * Onboarding setup step (#630): add-project handoff, recommended
 * defaultWorktree / defaultOrchestrate toggles, Use recommended, and
 * the optional daily budget field.
 *
 * Run: node --import=./test/support/render.mjs --test test/onboardingSetup.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
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

async function gotoSetup(
  m: Awaited<ReturnType<typeof mount>>,
): Promise<void> {
  const next = m.query("[data-onboarding-next]");
  assert.ok(next, "Next control must exist");
  await m.click(next);
  await m.click(next);
  assert.equal(
    m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
    "setup",
    "two Next clicks must land on the setup step",
  );
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

  it("toggling worktree records settings.set with defaultWorktree: true", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);

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

  it("Use recommended records defaultWorktree and defaultOrchestrate on", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);

    const rec = m.query("[data-onboarding-recommended]");
    assert.ok(rec, "Use recommended must render");
    await m.click(rec);

    const patches = settingsPatches(fake);
    assert.ok(
      patches.some(
        (p) => p.defaultWorktree === true && p.defaultOrchestrate === true,
      ),
      `Use recommended must save both flags, got: ${JSON.stringify(patches)}`,
    );
    m.unmount();
  });

  it("budget input 12 saves 12 and empty saves null", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);

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

  it("a rejected save shows an inline error", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    await gotoSetup(m);

    const input = m.query("[data-onboarding-budget]");
    const save = m.query("[data-onboarding-budget-save]");
    assert.ok(input, "budget input must render");
    assert.ok(save, "budget Save must render");

    await m.type(input, "0");
    await m.click(save);

    const err = m.query("[data-onboarding-setup-error]");
    assert.ok(err, "rejected save must render data-onboarding-setup-error");
    assert.ok(
      (err.textContent || "").includes("Daily budget must be a positive number"),
      `error must show the backend message, got: ${err.textContent}`,
    );
    m.unmount();
  });
});
