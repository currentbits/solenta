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
});
