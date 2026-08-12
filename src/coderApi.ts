import type { CoderApi } from "./shared/ipc";
import { isWebMode } from "./shared/wire";
import { createWireCoder } from "./wireClient";
import { devCoder } from "./devCoder";

export const WEB_TOKEN_KEY = "coder.web.token";

export function wsUrlFromLocation(loc: {
  protocol: string;
  host: string;
}): string {
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc.host}`;
}

export function persistWebToken(
  token: string,
  storage: Storage = window.localStorage,
): void {
  storage.setItem(WEB_TOKEN_KEY, token);
}

/** Seam so tests can observe reload without redefining window.location. */
export const webNavigation = {
  reload(): void {
    window.location.reload();
  },
};

export function resolveWebToken(
  loc: Location = window.location,
  storage: Storage = window.localStorage,
  hist: History = window.history,
): string | null {
  const params = new URLSearchParams(loc.search);
  const fromQuery = params.get("token");
  if (fromQuery) {
    persistWebToken(fromQuery, storage);
    params.delete("token");
    const qs = params.toString();
    hist.replaceState(
      null,
      "",
      `${loc.pathname}${qs ? `?${qs}` : ""}${loc.hash}`,
    );
    return fromQuery;
  }
  return storage.getItem(WEB_TOKEN_KEY);
}

export function needsWebTokenGate(): boolean {
  return isWebMode() && !resolveWebToken();
}

export function resolveCoderApi(): CoderApi {
  const w = window as unknown as { coder?: CoderApi };
  if (w.coder) return w.coder;
  const token = resolveWebToken();
  if (token) {
    return createWireCoder({
      url: wsUrlFromLocation(window.location),
      token,
    });
  }
  // No Electron bridge and no web token. In a Vite DEV build that's the dev
  // server — fall back to devCoder (restores main's `window.coder ??
  // devCoder`, which round 51's web selection dropped). In a PRODUCTION web
  // build a missing token is the token-gate case (needsWebTokenGate), and
  // the caller must render the gate rather than reach here.
  if (import.meta.env?.DEV) return devCoder;
  throw new Error("Missing web token");
}
