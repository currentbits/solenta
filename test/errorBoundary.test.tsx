/**
 * ErrorBoundary component unit tests: one boundary per main pane
 * (issue #81), so a render crash degrades one pane instead of blanking
 * the whole window.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { drainConsoleErrors, mount } from "./support/dom";
import { ErrorBoundary } from "../src/components/ErrorBoundary";

/** Crashes expected by these tests; drained so the console gate stays green. */
const EXPECTED_CRASH = /boom|\[ErrorBoundary\]/;

function Bomb(): never {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", async () => {
    const m = await mount(
      <ErrorBoundary pane="Sidebar">
        <div>pane content</div>
      </ErrorBoundary>,
    );
    assert.ok(m.text().includes("pane content"));
    assert.equal(m.query("[role='alert']"), null);
  });

  it("catches a render crash and shows a fallback with retry + reload", async () => {
    const m = await mount(
      <ErrorBoundary pane="Sidebar">
        <Bomb />
      </ErrorBoundary>,
    );
    drainConsoleErrors(EXPECTED_CRASH);
    assert.ok(m.text().includes("Sidebar crashed"), "fallback names the pane");
    assert.ok(m.text().includes("boom"), "fallback shows the error message");
    assert.ok(m.byText("Try again"), "retry affordance present");
    assert.ok(m.byText("Reload app"), "reload affordance present");
  });

  it("Try again recovers once the child stops throwing", async () => {
    let shouldThrow = true;
    function MaybeBomb() {
      if (shouldThrow) throw new Error("boom");
      return <div>recovered</div>;
    }
    const m = await mount(
      <ErrorBoundary pane="Thread view">
        <MaybeBomb />
      </ErrorBoundary>,
    );
    drainConsoleErrors(EXPECTED_CRASH);
    assert.ok(m.text().includes("Thread view crashed"));

    shouldThrow = false;
    await m.click(m.byText("Try again"));
    drainConsoleErrors(EXPECTED_CRASH);
    assert.ok(m.text().includes("recovered"), "children render again");
    assert.equal(m.query("[role='alert']"), null);
  });

  it("Try again re-catches when the child still throws", async () => {
    const m = await mount(
      <ErrorBoundary pane="Agents panel">
        <Bomb />
      </ErrorBoundary>,
    );
    drainConsoleErrors(EXPECTED_CRASH);
    await m.click(m.byText("Try again"));
    drainConsoleErrors(EXPECTED_CRASH);
    assert.ok(m.text().includes("Agents panel crashed"));
  });

  it("Reload app invokes the reload affordance", async () => {
    let reloaded = false;
    const m = await mount(
      <ErrorBoundary
        pane="Sidebar"
        onReload={() => {
          reloaded = true;
        }}
      >
        <Bomb />
      </ErrorBoundary>,
    );
    drainConsoleErrors(EXPECTED_CRASH);
    await m.click(m.byText("Reload app"));
    assert.equal(reloaded, true);
  });
});
