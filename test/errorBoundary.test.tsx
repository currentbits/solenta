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
import { ErrorBoundary, formatErrorReport } from "../src/components/ErrorBoundary";

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

  it("shows the stack trace in a collapsed details element", async () => {
    const m = await mount(
      <ErrorBoundary pane="Sidebar">
        <Bomb />
      </ErrorBoundary>,
    );
    drainConsoleErrors(EXPECTED_CRASH);
    const details = m.query("details");
    assert.ok(details, "stack trace lives in a <details>");
    assert.equal(details?.hasAttribute("open"), false, "collapsed by default");
    assert.ok(m.text().includes("Stack trace"));
    assert.ok(m.text().includes("Bomb"), "the real stack is rendered inside it");
  });

  it("Copy error report copies message, stack and componentStack, then flips the label (#1773)", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (t: string) => {
          writes.push(t);
        },
      },
      configurable: true,
    });
    const m = await mount(
      <ErrorBoundary pane="Agents panel">
        <Bomb />
      </ErrorBoundary>,
    );
    drainConsoleErrors(EXPECTED_CRASH);
    assert.ok(m.byText("Copy error report"));
    await m.click(m.byText("Copy error report"));
    assert.equal(writes.length, 1);
    const report = writes[0]!;
    assert.ok(report.includes("Pane: Agents panel"));
    assert.ok(report.includes("boom"), "carries error.message");
    assert.ok(report.includes("Bomb"), "carries error.stack");
    assert.ok(report.includes("Component stack:"));
    const [, afterLabel] = report.split("Component stack:");
    assert.ok(afterLabel && afterLabel.includes("Bomb"), "carries componentStack");
    assert.ok(m.byText("Copied"), "label flips after copy");
  });

  it("Copy error report is inert without a clipboard (insecure context)", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const m = await mount(
      <ErrorBoundary pane="Sidebar">
        <Bomb />
      </ErrorBoundary>,
    );
    drainConsoleErrors(EXPECTED_CRASH);
    await m.click(m.byText("Copy error report"));
    assert.equal(m.byText("Copied"), null, "no clipboard, no false success");
  });
});

describe("formatErrorReport", () => {
  it("includes app version, platform, pane, message, stack and componentStack", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at Bomb (file.tsx:1:1)";
    const report = formatErrorReport({
      pane: "Sidebar",
      error,
      componentStack: "\n    in Bomb\n    in ErrorBoundary",
      appVersion: "abc1234",
      platform: "MacIntel",
    });
    assert.match(report, /Solenta abc1234/);
    assert.match(report, /Platform: MacIntel/);
    assert.match(report, /Pane: Sidebar/);
    assert.match(report, /boom/);
    assert.match(report, /at Bomb \(file\.tsx:1:1\)/);
    assert.match(report, /Component stack:/);
    assert.match(report, /in Bomb/);
  });

  it("falls back cleanly with no version and no componentStack", () => {
    const error = new Error("boom");
    error.stack = undefined;
    const report = formatErrorReport({
      pane: "Sidebar",
      error,
      componentStack: null,
      appVersion: null,
      platform: "MacIntel",
    });
    assert.match(report, /Solenta unknown version/);
    assert.match(report, /No stack available/);
    assert.match(report, /\(none\)/);
  });
});
