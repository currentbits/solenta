/**
 * Wire protocol for Coder Web (Tier 3): the SAME CoderApi channel map that
 * preload.js exposes over Electron IPC, carried over one WebSocket.
 *
 * Design rules (the contract for rounds 51+):
 * - Channel names are IDENTICAL to the IPC names ("projects:list",
 *   "threads:fork", ...). The server routes them to the same services the
 *   IPC handlers use — one behavior, two transports.
 * - Push channels are exactly preload's PUSH_CHANNELS ("threads:changed",
 *   "thread:updated"); the server fans every broadcast out to every
 *   authenticated socket. No subscription protocol: pushes are cheap and
 *   the renderer already tolerates redundant ones.
 * - Auth: the FIRST client message must be {kind:"auth", token}. The token
 *   is generated (crypto-random) when serve mode starts, printed to stdout
 *   and persisted next to the store. Any other first message closes the
 *   socket. Invokes before auth-ok are dropped with an error reply.
 * - Security defaults: the HTTP+WS server binds 127.0.0.1 unless an
 *   explicit --host flag widens it. There is no TLS in v1 — LAN exposure
 *   is the operator's informed choice, and the flag's help text says so.
 * - Errors: service throws become {kind:"reply", id, error: message}, the
 *   same string the IPC path would reject with; the client rethrows as
 *   Error(message) so the renderer cannot tell transports apart.
 * - Reconnect: the client reconnects with capped backoff, re-auths, then
 *   re-emits a synthetic "threads:changed" REQUEST (invoke threads:list)
 *   so the UI resyncs state missed while disconnected.
 */

/** Client → server. */
export type WireClientMessage =
  | { kind: "auth"; token: string }
  | { kind: "invoke"; id: number; channel: string; args: unknown[] };

/** Server → client. */
export type WireServerMessage =
  | { kind: "auth-ok" }
  | { kind: "reply"; id: number; result?: unknown; error?: string }
  | { kind: "push"; channel: string; payload: unknown };

/** Push channels mirrored from preload.js — keep the two in lockstep. */
export const WIRE_PUSH_CHANNELS = ["threads:changed", "thread:updated"] as const;

/**
 * True when the renderer is served over HTTP (no Electron preload bridge).
 * Feature gates that must degrade on the web (native dialogs, app-quit
 * concerns) branch on this — never on user-agent sniffing.
 */
export function isWebMode(): boolean {
  return typeof window !== "undefined" && !("coder" in window);
}
