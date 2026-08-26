/**
 * Channel table (#623): bindCoderApi is the wireClient/preload invoke
 * surface. A row that does not produce ns:method is the defect class.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindCoderApi,
  IPC_CHANNELS,
  ipcChannelName,
  PUSH_CHANNELS,
} from "../src/shared/ipcChannels.ts";
import { WIRE_PUSH_CHANNELS } from "../src/shared/wire.ts";

describe("ipcChannels table", () => {
  it("names every invoke channel ns:method with unique rows", () => {
    const seen = new Set<string>();
    assert.ok(IPC_CHANNELS.length > 20);
    for (const row of IPC_CHANNELS) {
      const ch = ipcChannelName(row);
      assert.equal(ch, `${row.ns}:${row.method}`);
      assert.equal(seen.has(ch), false, `duplicate channel ${ch}`);
      seen.add(ch);
    }
  });

  it("wire push list is the desktop list minus simulator pushes", () => {
    assert.deepEqual([...WIRE_PUSH_CHANNELS], [
      "threads:changed",
      "thread:updated",
      "thread:select",
      "boot:ready",
    ]);
    assert.ok((PUSH_CHANNELS as readonly string[]).includes("simulator:changed"));
    assert.ok((PUSH_CHANNELS as readonly string[]).includes("simulator:focus"));
  });

  it("bindCoderApi invokes ns:method for every row", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const api = bindCoderApi(async (channel, ...args) => {
      calls.push({ channel, args });
      return channel;
    });
    for (const row of IPC_CHANNELS) {
      const ns = api[row.ns] as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      const result = await ns[row.method]("arg-one", "arg-two");
      assert.equal(result, ipcChannelName(row));
    }
    assert.equal(calls.length, IPC_CHANNELS.length);
    assert.deepEqual(calls[0], {
      channel: "app:status",
      args: ["arg-one", "arg-two"],
    });
    const verify = calls.find((c) => c.channel === "threads:setVerifyCommand");
    assert.ok(verify, "table must include threads:setVerifyCommand (#622)");
  });
});
