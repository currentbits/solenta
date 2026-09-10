/**
 * First-run onboarding: Agent → Project → First thread. Skip persists
 * onboardingSeen, Settings can relaunch, backdrop does not complete.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/onboarding.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useState } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";
import { OnboardingModal } from "../src/components/onboarding/OnboardingModal";

async function boot(
  fake: ReturnType<typeof createFakeCoder>,
): Promise<Awaited<ReturnType<typeof mount>>> {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function stepId(m: Awaited<ReturnType<typeof mount>>): string | null {
  return m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step") ?? null;
}

afterEach(unmountAll);

describe("Onboarding wizard", () => {
  it("shows the modal when onboardingSeen is unset", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: undefined } });
    const m = await boot(fake);
    assert.ok(
      m.query("[data-onboarding]"),
      "unset onboardingSeen must show the wizard",
    );
    assert.equal(stepId(m), "cli", "first-run must open on the Agent (cli) step");
    assert.equal(
      m.query("[data-onboarding-progress]")?.textContent?.trim(),
      "Step 1 of 3",
    );
    assert.match(
      m.query("[data-onboarding-benefit]")?.textContent ?? "",
      /share project context/,
      "first step must keep the shared-memory product line",
    );
    m.unmount();
  });

  it("Next and Back walk cli → setup → tour", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    const next = m.query("[data-onboarding-next]");
    const back = m.query("[data-onboarding-back]");
    assert.ok(next, "Next control must exist");
    assert.ok(back, "Back control must exist");
    assert.equal(stepId(m), "cli", "start on cli");
    assert.equal(
      (back as HTMLButtonElement).disabled,
      true,
      "Back must be disabled on the first step",
    );
    assert.equal(
      m.query("[data-onboarding] h2")?.textContent?.trim(),
      "Agent",
      "first step is labelled Agent",
    );

    await m.click(next);
    assert.equal(stepId(m), "setup", "Next from cli must land on setup");
    assert.equal(
      m.query("[data-onboarding-progress]")?.textContent?.trim(),
      "Step 2 of 3",
    );
    assert.equal(m.query("[data-onboarding] h2")?.textContent?.trim(), "Project");

    await m.click(next);
    assert.equal(stepId(m), "tour", "Next from setup must land on tour");
    assert.equal(
      m.query("[data-onboarding-progress]")?.textContent?.trim(),
      "Step 3 of 3",
    );
    assert.equal(
      m.query("[data-onboarding] h2")?.textContent?.trim(),
      "First thread",
    );
    assert.equal(
      next.textContent?.trim(),
      "Do this later",
      "last-step footer is secondary Do this later, not Finish",
    );
    assert.ok(
      m.query("[data-onboarding-create-thread]"),
      "Create first thread is the last-step primary action",
    );

    await m.click(back);
    assert.equal(stepId(m), "setup", "Back from tour must land on setup");
    await m.click(back);
    assert.equal(stepId(m), "cli", "Back from setup must land on cli");
    m.unmount();
  });

  it("Skip records onboardingSeen: true and unmounts the modal", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    const skip = m.query("[data-onboarding-skip]");
    assert.ok(skip, "Skip control must exist");
    await m.click(skip);

    const sets = fake.of("settings.set");
    assert.ok(
      sets.some((c) => {
        const patch = c.args[0] as { onboardingSeen?: boolean };
        return patch.onboardingSeen === true;
      }),
      "Skip must call settings.set with onboardingSeen: true",
    );
    assert.ok(!m.query("[data-onboarding]"), "Skip must unmount the wizard");
    m.unmount();
  });

  it("does not show the modal when onboardingSeen is true", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    assert.ok(
      !m.query("[data-onboarding]"),
      "seen onboarding must not show the wizard",
    );
    m.unmount();
  });

  it("SettingsModal Show welcome tour reopens the wizard", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    assert.ok(
      !m.query("[data-onboarding]"),
      "precondition: wizard is closed when already seen",
    );

    const gear = m.byText("Settings");
    assert.ok(gear, "Settings control must exist");
    await m.click(gear);

    const relaunch = m.query("[data-show-onboarding]");
    assert.ok(relaunch, "Show welcome tour must exist in Settings");
    await m.click(relaunch);

    assert.ok(
      m.query("[data-onboarding]"),
      "Show welcome tour must reopen the wizard even when onboardingSeen is true",
    );
    assert.equal(stepId(m), "cli", "relaunch must start on the Agent (cli) step");
    m.unmount();
  });

  it("backdrop click does not complete onboarding", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    const backdrop = m.query("[data-onboarding-backdrop]") as HTMLElement | null;
    assert.ok(backdrop, "backdrop must exist");
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await m.flush();
    assert.ok(
      m.query("[data-onboarding]"),
      "backdrop mousedown must not dismiss the wizard",
    );
    assert.equal(
      fake.of("settings.set").filter((c) => {
        const patch = c.args[0] as { onboardingSeen?: boolean };
        return patch.onboardingSeen === true;
      }).length,
      0,
      "backdrop must not persist onboardingSeen",
    );
    m.unmount();
  });

  it("a rejected onboardingSeen save stays open with retry", async () => {
    const fail: Record<string, Error> = {
      "settings.set": new Error("disk full"),
    };
    const fake = createFakeCoder({
      settings: { onboardingSeen: false },
      fail,
    });
    const m = await boot(fake);
    const skip = m.query("[data-onboarding-skip]");
    assert.ok(skip, "Skip control must exist");
    await m.click(skip);

    assert.ok(
      m.query("[data-onboarding]"),
      "failed persist must keep the wizard open",
    );
    const err = m.query("[data-onboarding-persist-error]");
    assert.ok(err, "failed persist must show an error");
    assert.ok(
      (err.textContent || "").includes("disk full"),
      `persist error must show the backend message, got: ${err.textContent}`,
    );
    const retry = m.query("[data-onboarding-persist-retry]");
    assert.ok(retry, "failed persist must offer Retry save");

    delete fail["settings.set"];
    await m.click(retry);
    assert.ok(
      !m.query("[data-onboarding]"),
      "successful retry must unmount the wizard",
    );
    m.unmount();
  });
});

describe("OnboardingModal focus trap", () => {
  it("opening the dialog moves focus inside; Tab stays inside; Escape restores", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            data-trap-opener=""
            onClick={() => setOpen(true)}
          >
            Open onboarding
          </button>
          <OnboardingModal
            open={open}
            onFinish={() => setOpen(false)}
            providers={[]}
            refreshProviders={async () => {}}
            projects={[]}
            onAddProject={() => {}}
            settings={null}
            onSaveSettings={async (patch) => patch}
          />
        </>
      );
    }
    const m = await mount(<Harness />);
    const opener = m.query("[data-trap-opener]") as HTMLElement;
    opener.focus();
    await m.click(opener);
    const dialog = m.query("[data-onboarding]") as HTMLElement | null;
    assert.ok(dialog, "onboarding dialog");
    assert.ok(
      dialog.contains(document.activeElement),
      "opening the dialog must move focus inside it",
    );
    assert.notEqual(document.activeElement, opener);

    await m.pressFocused("Tab");
    const first = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(first), "Tab stays inside");
    assert.notEqual(first, dialog, "Tab moves to a focusable inside the dialog");
    await m.pressFocused("Tab");
    assert.ok(
      dialog.contains(document.activeElement),
      "second Tab stays inside",
    );

    await m.pressFocused("Escape");
    assert.equal(m.query("[data-onboarding]"), null);
    assert.equal(document.activeElement, opener, "Escape restores the opener");
    m.unmount();
  });
});
