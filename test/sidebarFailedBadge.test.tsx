/**
 * Failed status dot: lastError is the native title tooltip (issue #140,
 * flattened to the one-dot row contract in #566).
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadCard } from "../src/components/Sidebar";
import { thread } from "./support/fakeCoder.ts";
import type { ProviderInfo } from "../src/shared/ipc";

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

describe("failed dot lastError tooltip", () => {
  it("renders lastError as the failed dot title", async () => {
    const t = thread({
      status: "failed",
      lastError: "Run error: exit 1",
    });
    const m = await mount(
      <ThreadCard
        thread={t}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={Date.now()}
        onSelect={() => {}}
      />,
    );
    const dot = m.query('[data-status-dot="failed"]');
    assert.ok(dot, "failed dot must render");
    assert.equal(dot!.getAttribute("title"), "Run error: exit 1");
    assert.equal(dot!.getAttribute("data-failed"), t.id, "legacy failed flag");
    assert.ok(
      m.query(`button[aria-label="Select thread: ${t.title}, failed"]`),
      "select button speaks the failed state",
    );
    m.unmount();
  });

  it("renders an attention quota-wait dot instead of failed", async () => {
    const now = Date.now();
    const until = now + 3 * 60 * 60 * 1000;
    const m = await mount(
      <ThreadCard
        thread={thread({
          status: "quota-wait",
          quotaWaitUntil: until,
          lastError: "You've hit your limit · resets 3pm",
        })}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={now}
        onSelect={() => {}}
      />,
    );
    const dot = m.query("[data-quota-wait]");
    assert.ok(dot, "quota-wait dot must render");
    assert.equal(dot!.getAttribute("data-status-dot"), "attention");
    assert.equal(
      dot!.getAttribute("title"),
      "You've hit your limit · resets 3pm",
      "lastError wins the tooltip over the resume clock",
    );
    assert.equal(
      m.query('[data-status-dot="failed"]'),
      null,
      "must not render a failed dot while parked",
    );
    m.unmount();
  });
});
