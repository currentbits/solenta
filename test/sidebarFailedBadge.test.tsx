/**
 * Failed sidebar badge: lastError is the native title tooltip (issue #140).
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

describe("failed badge lastError tooltip", () => {
  it("renders lastError as the Failed badge title", async () => {
    const m = await mount(
      <ThreadCard
        thread={thread({
          status: "failed",
          lastError: "Run error: exit 1",
        })}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={Date.now()}
        onSelect={() => {}}
      />,
    );
    const badge = m
      .queryAll("span")
      .find((el) => (el.textContent || "").trim() === "Failed");
    assert.ok(badge, "Failed badge must render");
    assert.equal(badge.getAttribute("title"), "Run error: exit 1");
    m.unmount();
  });

  it("renders Quota wait · clock instead of Failed", async () => {
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
    const badge = m.query("[data-quota-wait]");
    assert.ok(badge, "quota-wait badge must render");
    assert.match((badge.textContent || "").trim(), /Quota wait/);
    assert.ok(
      !m
        .queryAll("span")
        .some((el) => (el.textContent || "").trim() === "Failed"),
      "must not render Failed while parked",
    );
    m.unmount();
  });
});
