/**
 * Saved Remote Connections (Settings > Connections), kept in localStorage.
 * Also the Teleport targets in the thread menu (#1702).
 */

import type { CoderApi, SidebarHostStatus, RemoteComputerDescriptor, CloudRouteRef } from "./shared/ipc";

export type SavedHost = {
  id: string;
  computerId?: string;
  cloud?: CloudRouteRef;
  descriptor?: RemoteComputerDescriptor;
  legacy?: true;
  label: string;
  host: string;
  remotePort: number;
  /**
   * Direct route (#1824): the host's Solenta Web origin, reached over a
   * tailnet or LAN with a device token instead of SSH. Never holds a token.
   */
  url?: string;
  /** Hint only: the encrypted token itself lives in the main process. */
  tokenSaved?: boolean;
  /** Show this host's projects and threads in the main sidebar (#1819). */
  inSidebar?: boolean;
};
export const STORAGE_KEY = "coder.remoteConnections";

export function loadHosts(): SavedHost[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is SavedHost =>
      item && typeof item.id === "string" &&
      typeof item.label === "string" && typeof item.host === "string" &&
      Number.isInteger(item.remotePort) && item.remotePort > 0 &&
      item.remotePort <= 65535 &&
      (item.url === undefined || typeof item.url === "string") &&
      (item.computerId === undefined || typeof item.computerId === "string") &&
      (item.cloud === undefined || (item.cloud && typeof item.cloud.accountId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(item.cloud.accountId) &&
        typeof item.cloud.computerId === "string" && item.cloud.computerId === item.computerId &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(item.cloud.computerId) &&
        (item.cloud.scopes === undefined || (Array.isArray(item.cloud.scopes) && item.cloud.scopes.length > 0 &&
          item.cloud.scopes.every((scope: unknown) => typeof scope === "string" && ["full", "read", "steer", "files", "git", "terminal:observe", "terminal:type", "preview", "settings"].includes(scope)))))),
    ).slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * The hub's key for a saved host, also what its row shows: the address of
 * a direct route, else host:port.
 */
export function hostKeyOf(h: Pick<SavedHost, "host" | "remotePort" | "url" | "cloud">): string {
  return h.cloud ? `cloud:${h.cloud.accountId}:${h.cloud.computerId}` : h.url || `${h.host}:${h.remotePort}`;
}

/**
 * Hand main the saved hosts to show in the sidebar (#1819). Desktop only;
 * a backend without the channel just shows no remote rows.
 */
export function pushSidebarHosts(
  setSidebarHosts: CoderApi["app"]["setSidebarHosts"] | undefined,
  hosts: SavedHost[] = loadHosts(),
): Promise<SidebarHostStatus[]> {
  if (typeof setSidebarHosts !== "function") return Promise.resolve([]);
  const shown = hosts
    .filter((h) => h.inSidebar)
    .map(({ host, remotePort, url, label, computerId, legacy, cloud }) => ({ host, remotePort, label, ...(cloud ? { cloud } : {}), ...(url ? { url } : {}), ...(computerId ? { computerId } : {}), ...(legacy ? { allowLegacy: true } : {}) }));
  return setSidebarHosts(shown).catch(() => []);
}

/** Routes stay separate for credential storage; only verified identities group. */
export type SavedComputer = { key: string; computerId?: string; label: string; routes: SavedHost[] };
export function groupSavedComputers(hosts: SavedHost[]): SavedComputer[] {
  const computers = new Map<string, SavedComputer>();
  for (const route of hosts) {
    const key = route.computerId ? `computer:${route.computerId}` : `route:${hostKeyOf(route)}`;
    const held = computers.get(key);
    if (held) {
      if (!held.routes.some((r) => hostKeyOf(r) === hostKeyOf(route))) held.routes.push(route);
    } else computers.set(key, { key, computerId: route.computerId, label: route.label, routes: [route] });
  }
  return [...computers.values()];
}
