/**
 * Local Servers card on the Git tab: rows, count badge, empty state.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { LocalServersCard } from "../src/components/AgentsPanel";
import type { LocalServerInfo } from "../src/shared/ipc";

const TWO: LocalServerInfo[] = [
  {
    pid: 1234,
    command: "node",
    host: "*",
    port: 5173,
    url: "http://localhost:5173",
  },
  {
    pid: 5678,
    command: "Python",
    host: "127.0.0.1",
    port: 8000,
    url: "http://127.0.0.1:8000",
  },
];

describe("LocalServersCard", () => {
  it("shows empty copy and a zero count when no servers are detected", async () => {
    const m = await mount(
      <LocalServersCard threadId="t1" listLocalServers={async () => []} />,
    );
    await m.flush();
    assert.ok(m.query("[data-local-servers]"), "card is present");
    assert.ok(
      m.query("[data-local-servers-empty]"),
      "empty state is present",
    );
    assert.equal(
      (m.query("[data-local-servers-empty]")?.textContent || "").trim(),
      "No dev servers detected",
    );
    assert.equal(
      (m.query("[data-local-servers-count]")?.textContent || "").trim(),
      "0",
    );
    assert.equal(m.queryAll("a").length, 0, "no server links");
    m.unmount();
  });

  it("renders a row per server with command, :port, and a blank-target url", async () => {
    const m = await mount(
      <LocalServersCard
        threadId="t1"
        listLocalServers={async () => TWO}
      />,
    );
    await m.flush();
    const count = m.query("[data-local-servers-count]");
    assert.equal((count?.textContent || "").trim(), "2");
    assert.equal(m.query("[data-local-servers-empty]"), null);

    const links = m.queryAll("a") as HTMLAnchorElement[];
    assert.equal(links.length, 2);
    assert.ok(
      (links[0]!.textContent || "").includes("node"),
      "command name on first row",
    );
    assert.ok(
      (links[0]!.textContent || "").includes(":5173"),
      ":port on first row",
    );
    assert.equal(links[0]!.getAttribute("href"), "http://localhost:5173");
    assert.equal(links[0]!.getAttribute("target"), "_blank");
    assert.equal(links[0]!.getAttribute("rel"), "noreferrer");
    assert.ok(
      (links[1]!.textContent || "").includes("Python"),
      "command name on second row",
    );
    assert.ok(
      (links[1]!.textContent || "").includes(":8000"),
      ":port on second row",
    );
    assert.equal(links[1]!.getAttribute("href"), "http://127.0.0.1:8000");
    m.unmount();
  });
});
