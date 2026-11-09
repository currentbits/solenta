import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadHosts, groupSavedComputers, pushSidebarHosts, STORAGE_KEY } from "../src/remoteHosts.ts";
import type { CoderApi } from "../src/shared/ipc.ts";

const route = { id: "one", host: "box", remotePort: 4620, label: "Box", tokenSaved: true, inSidebar: true };

describe("remote computer catalog", () => {
  it("loads legacy saved addresses intact while leaving identity unbound", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "window");
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => key === STORAGE_KEY ? JSON.stringify([route]) : null } } });
      assert.deepEqual(loadHosts(), [route]);
      assert.equal(groupSavedComputers(loadHosts())[0].computerId, undefined);
    } finally {
      if (before) Object.defineProperty(globalThis, "window", before);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("groups only bound identities and keeps each route's order and credential hint", () => {
    const direct = { ...route, id: "two", url: "https://box.ts.net", computerId: "computer-one" };
    const ssh = { ...route, computerId: "computer-one" };
    const elsewhere = { ...route, id: "three", host: "other", computerId: "computer-two" };
    const groups = groupSavedComputers([direct, ssh, elsewhere, { ...route, id: "legacy" }]);
    assert.deepEqual(groups.map((g) => g.routes.map((r) => r.id)), [["two", "one"], ["three"], ["legacy"]]);
    assert.equal(groups[0].routes.every((r) => r.tokenSaved), true);
    assert.equal(groupSavedComputers([ssh, ssh])[0].routes.length, 1);
  });

  it("forwards expected identity and explicit legacy compatibility to the actual sidebar hub", async () => {
    let received: unknown;
    const setHosts = async (input: unknown) => { received = input; return []; };
    await pushSidebarHosts(setHosts as CoderApi["app"]["setSidebarHosts"], [{ ...route, computerId: "computer-one" }, { ...route, id: "old", host: "old", legacy: true }]);
    assert.deepEqual(received, [
      { host: "box", remotePort: 4620, label: "Box", computerId: "computer-one" },
      { host: "old", remotePort: 4620, label: "Box", allowLegacy: true },
    ]);
  });
});
