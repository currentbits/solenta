import type { CoderApi } from "./shared/ipc";
import { getWireStatus, subscribeWireStatus } from "./wireStatus";

/** Read-side recovery only. A restored connection never resubmits a command. */
export function subscribeConnectionRecovery(api: CoderApi, recover: () => void): () => void {
  const cleanups: Array<() => void> = [];
  let state = getWireStatus().state;
  cleanups.push(subscribeWireStatus(() => {
    const next = getWireStatus().state;
    if (next === "connected" && state !== "connected") recover();
    state = next;
  }));

  // Desktop hosts have their own transport. Re-read mounted consumers when
  // any host returns; their thread IDs still route reads to the owning host.
  let online = new Set<string>();
  try {
    cleanups.push(api.on("hosts:changed", (hosts) => {
      const next = new Set(hosts.filter((host) => host.status === "online").map((host) => host.key));
      const restored = [...next].some((key) => !online.has(key));
      online = next;
      if (restored) recover();
    }));
  } catch {
    // Browser wire clients intentionally have no desktop host-hub push.
  }
  return () => { for (const off of cleanups) off(); };
}
