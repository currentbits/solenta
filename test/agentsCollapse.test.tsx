/**
 * Right panel collapse: chevron in the panel header hides it to a rail,
 * the rail chevron brings it back, and the choice persists.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";

describe("agents panel collapse", () => {
  it("collapses to a rail and restores", async () => {
    const shell = await mount(<div />);
    window.localStorage.removeItem("coder.agentsCollapsed");
    installFakeCoder(createFakeCoder());
    shell.unmount();
    const m = await mount(<App />);

    const collapse = m.query('[data-panel-collapse="collapse"]');
    assert.ok(collapse, "collapse chevron missing");
    await m.click(collapse);

    assert.ok(!m.query('[data-panel-tab="pulse"]'), "panel body must be gone");
    assert.equal(
      m.query('[data-layout="app"]')?.getAttribute("data-agents-rail"),
      "true",
    );
    assert.equal(window.localStorage.getItem("coder.agentsCollapsed"), "1");

    const expand = m.query('[data-panel-collapse="expand"]');
    assert.ok(expand, "rail chevron missing");
    await m.click(expand);
    assert.ok(m.query('[data-panel-tab="pulse"]'), "panel must come back");
    assert.equal(window.localStorage.getItem("coder.agentsCollapsed"), "0");

    m.unmount();
  });
});
