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

/** Vite DEV build flag, injectable so the DEV branches are testable (the
 *  esbuild test harness pins import.meta.env.DEV falsy). */
export function isDevBuild(): boolean {
  return Boolean(import.meta.env?.DEV);
}

export function needsWebTokenGate(isDev: boolean = isDevBuild()): boolean {
  // A Vite DEV build with no Electron bridge is `npm run dev` in a browser,
  // not a deployed web app: use devCoder (resolveCoderApi) rather than
  // prompting for a token dev has no way to produce. Without this the gate
  // intercepts every browser dev session. isDevBuild() is false in the
  // production web bundle, so a real deploy still gates.
  if (isDev) return false;
  return isWebMode() && !resolveWebToken();
}

export function resolveCoderApi(isDev: boolean = isDevBuild()): CoderApi {
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
  // BootApp renders the gate before this is reached.
  if (isDev) return devCoder;
  throw new Error("Missing web token");
}
