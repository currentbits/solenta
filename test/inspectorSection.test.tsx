/**
 * Shared inspector building blocks (inspector tabs redesign).
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/inspectorSection.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import {
  InspectorBanner,
  InspectorSection,
} from "../src/components/InspectorSection";

afterEach(unmountAll);

describe("InspectorSection", () => {
  it("renders title, count, action and children in a labelled section", async () => {
    const m = await mount(
      <InspectorSection
        title="Run"
        count={3}
        action={<button type="button">Go</button>}
        data-probe=""
      >
        <p>body</p>
      </InspectorSection>,
    );
    const section = m.query("[data-probe]");
    assert.ok(section, "data-* attributes pass through");
    assert.equal(section.tagName, "SECTION");
    assert.equal(section.getAttribute("aria-label"), "Run");
    assert.equal(m.query("[data-section-count]")?.textContent, "3");
    assert.ok(m.byText("Go"), "action slot renders");
    assert.match(m.text(), /body/);
  });

  it("renders nothing without children", async () => {
    const m = await mount(
      <div data-host="">
        <InspectorSection title="Empty">{null}</InspectorSection>
        <InspectorSection title="False">{false}</InspectorSection>
      </div>,
    );
    assert.equal(m.query("[data-host]")?.innerHTML, "");
  });

  it("collapsible: honours defaultOpen and re-applies it when it changes", async () => {
    const el = (open: boolean) => (
      <InspectorSection
        title="Lanes"
        count={0}
        collapsible
        defaultOpen={open}
        data-probe=""
      >
        <p>lanes body</p>
      </InspectorSection>
    );
    const m = await mount(el(false));
    const details = m.query("[data-probe]") as HTMLDetailsElement;
    assert.equal(details.tagName, "DETAILS");
    assert.equal(details.open, false, "closed by default when asked");
    assert.match(m.query("summary")?.textContent ?? "", /Lanes\s*0/);
    assert.match(m.text(), /lanes body/, "body stays in the DOM while closed");
    await m.rerender(el(true));
    assert.equal(details.open, true, "opens when defaultOpen flips");
  });
});

describe("InspectorBanner", () => {
  it("shows text and a › action, and passes data attributes through", async () => {
    let hits = 0;
    const m = await mount(
      <InspectorBanner
        data-probe=""
        text="2 skills out of sync"
        actionLabel="Sync"
        onAction={() => {
          hits += 1;
        }}
        actionProps={{ "aria-label": "Sync missing skills", "data-act": "" }}
      />,
    );
    const banner = m.query("[data-probe]");
    assert.ok(banner);
    assert.match(banner.textContent ?? "", /2 skills out of sync/);
    const btn = m.query("[data-act]") as HTMLButtonElement;
    assert.equal(btn.textContent, "Sync ›");
    assert.equal(btn.getAttribute("aria-label"), "Sync missing skills");
    await m.click(btn);
    assert.equal(hits, 1);
  });

  it("can be a single action with no leading text", async () => {
    const m = await mount(
      <InspectorBanner
        data-probe=""
        actionLabel="1 memory needs review"
        onAction={() => {}}
      />,
    );
    assert.equal(m.query("[data-probe]")?.textContent, "1 memory needs review ›");
  });
});
