/**
 * Dev server card on the Environment tab: start/stop wiring, url, error line.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { DevServerCard } from "../src/components/AgentsPanel";
import type { DevServerState } from "../src/shared/ipc";

describe("DevServerCard", () => {
  it("wires Start and Stop to the callbacks and shows the captured url", async () => {
    const calls: string[] = [];
    let current: DevServerState = { running: false };
    const m = await mount(
      <DevServerCard
        threadId="t1"
        listDevScripts={async () => ["dev"]}
        startDevServer={async (id, script) => {
          calls.push(`start:${id}:${script}`);
          current = {
            running: true,
            script,
            url: "http://localhost:5173/",
            startedAt: Date.now(),
            lastLines: ["  Local: http://localhost:5173/"],
          };
          return current;
        }}
        stopDevServer={async (id) => {
          calls.push(`stop:${id}`);
          current = { running: false };
          return current;
        }}
        devServerStatus={async () => current}
      />,
    );
    await m.flush();
    const startBtn = m.query("[data-dev-server-start]");
    assert.ok(startBtn, "Start button is present");
    await m.click(startBtn);
    assert.deepEqual(calls, ["start:t1:dev"]);
    const link = m.query("[data-dev-server-url]") as HTMLAnchorElement | null;
    assert.ok(link, "url link is present after start");
    assert.equal(link!.getAttribute("href"), "http://localhost:5173/");
    assert.equal(link!.getAttribute("target"), "_blank");
    assert.equal(link!.getAttribute("rel"), "noreferrer");
    assert.equal((link!.textContent || "").trim(), "http://localhost:5173/");
    assert.match(
      (m.query("[data-dev-server-state]")?.textContent || "").trim(),
      /^running /,
    );
    assert.equal(m.query("[data-dev-server-start]"), null);
    const stopBtn = m.query("[data-dev-server-stop]");
    assert.ok(stopBtn, "Stop button is present while running");
    await m.click(stopBtn);
    assert.deepEqual(calls, ["start:t1:dev", "stop:t1"]);
    assert.equal(
      (m.query("[data-dev-server-state]")?.textContent || "").trim(),
      "stopped",
    );
    assert.equal(m.query("[data-dev-server-url]"), null);
    m.unmount();
  });

  it("shows the last log line when start fails", async () => {
    const m = await mount(
      <DevServerCard
        threadId="t1"
        listDevScripts={async () => ["dev"]}
        startDevServer={async () => ({
          running: false,
          script: "dev",
          lastLines: [
            "  ready",
            "Error: listen EADDRINUSE: address already in use :::5173",
          ],
        })}
        stopDevServer={async () => ({ running: false })}
        devServerStatus={async () => ({ running: false })}
      />,
    );
    await m.flush();
    await m.click(m.query("[data-dev-server-start]"));
    const err = m.query("[data-dev-server-error]");
    assert.ok(err, "error line is present");
    assert.match(err!.textContent || "", /EADDRINUSE/);
    m.unmount();
  });
});
