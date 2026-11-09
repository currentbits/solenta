import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { CoderApi, SidebarHostStatus } from "../src/shared/ipc";
import { subscribeConnectionRecovery } from "../src/connectionRecovery";
import { setWireStatus } from "../src/wireStatus";

afterEach(() => setWireStatus({ state: "connecting", queuedSend: false }));

it("recovers on authenticated transport restoration, not disconnected status churn", () => {
  let recovered = 0;
  const api = { on: () => { throw new Error("desktop push unavailable"); } } as unknown as CoderApi;
  const off = subscribeConnectionRecovery(api, () => recovered++);
  setWireStatus({ state: "connected" });
  setWireStatus({ queuedSend: true });
  setWireStatus({ state: "reconnecting" });
  setWireStatus({ state: "connected" });
  assert.equal(recovered, 2);
  off();
  setWireStatus({ state: "reconnecting" });
  setWireStatus({ state: "connected" });
  assert.equal(recovered, 2);
});

it("recovers when a desktop host returns online and releases its subscription", () => {
  let notify!: (hosts: SidebarHostStatus[]) => void;
  let unsubscribed = false;
  let recovered = 0;
  const api = { on: (_: string, cb: typeof notify) => {
    notify = cb;
    return () => { unsubscribed = true; };
  } } as unknown as CoderApi;
  const off = subscribeConnectionRecovery(api, () => recovered++);
  const host = (status: SidebarHostStatus["status"]): SidebarHostStatus => ({
    key: "work", host: "work", label: "Work", remotePort: 4620, status,
  });
  notify([host("online")]);
  notify([host("online")]);
  notify([host("offline")]);
  notify([host("connecting")]);
  notify([host("online")]);
  assert.equal(recovered, 2);
  off();
  assert.equal(unsubscribed, true);
});
