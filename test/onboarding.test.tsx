/**
 * First-run onboarding wizard scaffold (#628). Open when onboardingSeen is
 * unset, walk welcome→cli→setup→tour, skip persists the flag, and Settings
 * can relaunch after the first run.
 *
 * Run: node --import=./test/support/render.mjs --test test/onboarding.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
import { mount } from "./support/dom.ts";
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

describe("Onboarding wizard (#628)", () => {
  it("shows the modal when onboardingSeen is unset", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: undefined } });
    const m = await boot(fake);
    assert.ok(
      m.query("[data-onboarding]"),
      "unset onboardingSeen must show the wizard",
    );
    assert.equal(
      stepId(m),
      "welcome",
      "first-run must open on the welcome step",
    );
    m.unmount();
  });

  it("Next and Back walk welcome → cli → setup → tour", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    const next = m.query("[data-onboarding-next]");
    const back = m.query("[data-onboarding-back]");
    assert.ok(next, "Next control must exist");
    assert.ok(back, "Back control must exist");
    assert.equal(stepId(m), "welcome", "start on welcome");
    assert.equal(
      (back as HTMLButtonElement).disabled,
      true,
      "Back must be disabled on the first step",
    );

    await m.click(next);
    assert.equal(stepId(m), "cli", "Next from welcome must land on cli");
    await m.click(next);
    assert.equal(stepId(m), "setup", "Next from cli must land on setup");
    await m.click(next);
    assert.equal(stepId(m), "tour", "Next from setup must land on tour");
    assert.equal(
      next.textContent?.trim(),
      "Finish",
      "Next must read Finish on the last step",
    );

    await m.click(back);
    assert.equal(stepId(m), "setup", "Back from tour must land on setup");
    await m.click(back);
    assert.equal(stepId(m), "cli", "Back from setup must land on cli");
    await m.click(back);
    assert.equal(stepId(m), "welcome", "Back from cli must land on welcome");
    m.unmount();
  });

  it("Skip records onboardingSeen: true and unmounts the modal", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    const skip = m.query("[data-onboarding-skip]");
    assert.ok(skip, "Skip tour control must exist");
    await m.click(skip);

    const sets = fake.of("settings.set");
    assert.ok(
      sets.some((c) => {
        const patch = c.args[0] as { onboardingSeen?: boolean };
        return patch.onboardingSeen === true;
      }),
      "Skip must call settings.set with onboardingSeen: true",
    );
    assert.ok(
      !m.query("[data-onboarding]"),
      "Skip must unmount the wizard",
    );
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
    assert.equal(
      stepId(m),
      "welcome",
      "relaunch must start on the welcome step",
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
            onClose={() => setOpen(false)}
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
    const second = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(second), "second Tab stays inside");
    assert.notEqual(second, first);

    await m.pressFocused("Escape");
    assert.equal(m.query("[data-onboarding]"), null);
    assert.equal(document.activeElement, opener, "Escape restores the opener");
    m.unmount();
  });
});
