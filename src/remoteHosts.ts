/**
 * Saved Remote Connections (Settings > Connections), kept in localStorage.
 * Also the Teleport targets in the thread menu (#1702).
 */

import type { CoderApi, SidebarHostStatus } from "./shared/ipc";

export type SavedHost = {
  id: string;
  label: string;
  host: string;
  remotePort: number;
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
      item.remotePort <= 65535,
    ).slice(0, 30);
  } catch {
    return [];
  }
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
    .map(({ host, remotePort, label }) => ({ host, remotePort, label }));
  return setSidebarHosts(shown).catch(() => []);
}
