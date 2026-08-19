/**
 * Failed status label: lastError is the native title tooltip (issue #140,
 * T3 text label instead of a status dot).
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

describe("failed label lastError tooltip", () => {
  it("renders lastError as the failed label title", async () => {
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
    const label = m.query("[data-status-label]");
    assert.ok(label, "failed status label must render");
    assert.match(label!.textContent || "", /^Failed$/);
    assert.equal(label!.getAttribute("title"), "Run error: exit 1");
    assert.equal(label!.getAttribute("data-failed"), t.id, "legacy failed flag");
    assert.equal(m.query("[data-status-dot]"), null);
    assert.ok(
      m.query(`button[aria-label="Select thread: ${t.title}, failed"]`),
      "select button speaks the failed state",
    );
    m.unmount();
  });

  it("renders a Quota label instead of Failed", async () => {
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
    const label = m.query("[data-status-label]");
    assert.ok(label, "quota-wait label must render");
    assert.match(label!.textContent || "", /^Quota$/);
    assert.ok(label!.hasAttribute("data-quota-wait") || m.query("[data-quota-wait]"));
    assert.equal(
      label!.getAttribute("title"),
      "You've hit your limit · resets 3pm",
      "lastError wins the tooltip over the resume clock",
    );
    assert.equal(
      m.query('[data-failed]'),
      null,
      "must not render a failed label while parked",
    );
    m.unmount();
  });
});
