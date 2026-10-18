/**
 * Connection state of the Solenta Web wire client, for the banner and the
 * token gate. One client per page, so one module-level store.
 */
export type WireState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "rejected"
  | "rateLimited";

export type WireStatus = {
  state: WireState;
  /** A message went into the offline queue since the last auth-ok. */
  queuedSend: boolean;
};

let status: WireStatus = { state: "connecting", queuedSend: false };
const subscribers = new Set<() => void>();

export function getWireStatus(): WireStatus {
  return status;
}

export function setWireStatus(patch: Partial<WireStatus>): void {
  const next = { ...status, ...patch };
  if (next.state === status.state && next.queuedSend === status.queuedSend) return;
  status = next;
  for (const cb of subscribers) cb();
}

export function subscribeWireStatus(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
