import type { CoderApi } from "./shared/ipc";
import { isWebMode } from "./shared/wire";
import { createWireCoder } from "./wireClient";
import { devCoder } from "./devCoder";

export const WEB_TOKEN_KEY = "coder.web.token";
export const WEB_COMPUTER_KEY = "coder.web.computerId";
export const WEB_LEGACY_KEY = "coder.web.allowLegacy";

/** Mirrors WS_PATH in electron/webBridge.js; the server rejects upgrades elsewhere. */
const WS_PATH = "/ws";

export function wsUrlFromLocation(loc: {
  protocol: string;
  host: string;
}): string {
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc.host}${WS_PATH}`;
}

export function persistWebToken(
  token: string,
  storage: Storage = window.localStorage,
): void {
  storage.setItem(WEB_TOKEN_KEY, token);
  // Entering a new token is explicit enrollment. Old route identity must not
  // silently attach to that token; supplied connection metadata rebinds below.
  storage.removeItem(WEB_COMPUTER_KEY);
  storage.removeItem(WEB_LEGACY_KEY);
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
  const fragment = new URLSearchParams(loc.hash.slice(1));
  const fromQuery = fragment.get("token") || params.get("token");
  if (fromQuery) {
    persistWebToken(fromQuery, storage);
    const computerId = fragment.get("computerId") || params.get("computerId");
    if (computerId) storage.setItem(WEB_COMPUTER_KEY, computerId);
    else if ((fragment.get("allowLegacy") || params.get("allowLegacy")) === "1") storage.setItem(WEB_LEGACY_KEY, "1");
  }
  const scrub = ["token", "computerId", "allowLegacy"];
  const changed = scrub.some((key) => params.has(key) || fragment.has(key));
  if (changed) {
    for (const key of scrub) { params.delete(key); fragment.delete(key); }
    const qs = params.toString();
    const hash = loc.hash && !scrub.some((key) => new URLSearchParams(loc.hash.slice(1)).has(key))
      ? loc.hash : fragment.toString() ? `#${fragment}` : "";
    hist.replaceState(
      null,
      "",
      `${loc.pathname}${qs ? `?${qs}` : ""}${hash}`,
    );
  }
  if (fromQuery) return fromQuery;
  return storage.getItem(WEB_TOKEN_KEY);
}

/** Vite DEV build flag. The esbuild test harness pins import.meta.env.DEV
 *  falsy, so tests that need the `npm run dev:browser` path replace
 *  `devBuild.isDev` (same seam style as webNavigation.reload). */
export const devBuild = {
  isDev(): boolean {
    return Boolean(import.meta.env?.DEV);
  },
};

export function isDevBuild(): boolean {
  return devBuild.isDev();
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
      expectedComputerId: window.localStorage.getItem(WEB_COMPUTER_KEY) || undefined,
      allowLegacy: window.localStorage.getItem(WEB_LEGACY_KEY) === "1",
      onComputer: (computer) => {
        window.localStorage.setItem(WEB_COMPUTER_KEY, computer.computerId);
        window.localStorage.removeItem(WEB_LEGACY_KEY);
      },
    });
  }
  // No Electron bridge and no web token. In a Vite DEV build that's the dev
  // server — fall back to devCoder (restores main's `window.coder ??
  // devCoder`, which round 51's web selection dropped). In a PRODUCTION web
  // build a missing token is the token-gate case (needsWebTokenGate), and
  // BootApp renders the gate before this is reached.
  // The MODE check is a build-time constant, so production bundles drop
  // devCoder and its fake-data modules (~100 kB) entirely (#1475).
  if (isDev && import.meta.env?.MODE !== "production") return devCoder();
  throw new Error("Missing web token");
}
