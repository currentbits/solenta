import { persistWebToken, WEB_COMPUTER_KEY } from "./coderApi";

export type WebEnrollment = { grant: string; computerId: string };
let pending: WebEnrollment | null = null;
let exchange: Promise<void> | null = null;

/** Capture once in memory and remove secrets before App or its requests run.
 * A reload cannot replay the grant. Failed/ambiguous exchanges need a new link. */
export function captureWebEnrollment(loc: Location = window.location, hist: History = window.history): WebEnrollment | null {
  const fragment = new URLSearchParams(loc.hash.slice(1));
  const query = new URLSearchParams(loc.search);
  if (!fragment.has("pair") && !query.has("pair")) return pending;
  const grant = fragment.get("pair") || "";
  const computerId = fragment.get("computerId") || "";
  for (const key of ["pair", "computerId", "token", "allowLegacy"]) { fragment.delete(key); query.delete(key); }
  hist.replaceState(null, "", `${loc.pathname}${query.size ? `?${query}` : ""}${fragment.size ? `#${fragment}` : ""}`);
  pending = { grant, computerId };
  exchange = null;
  return pending;
}

/** Testable exchange uses no cookies, redirects or credentials in request URLs. */
export async function exchangeWebEnrollment(input: WebEnrollment, deps: {
  origin: string; fetch?: typeof fetch; storage?: Storage;
}): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(input.grant) || !input.computerId || input.computerId.length > 128) throw new Error("This enrollment link is incomplete. Create a new browser link on the host.");
  const request = deps.fetch ?? fetch;
  const origin = new URL(deps.origin);
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("Browser enrollment requires an HTTP or HTTPS host.");
  const options = { credentials: "omit" as const, redirect: "error" as const, cache: "no-store" as const };
  const description = await request(new URL("/.well-known/solenta", origin.origin), { ...options, signal: AbortSignal.timeout(5000) });
  if (!description.ok) throw new Error("This computer cannot confirm its identity. No enrollment credential was sent.");
  const computer = await description.json();
  if (!computer || computer.kind !== "solenta" || computer.computerId !== input.computerId ||
    !computer.protocol || !Number.isInteger(computer.protocol.min) || !Number.isInteger(computer.protocol.max) || computer.protocol.min > 1 || computer.protocol.max < 1 ||
    !["server", "desktop"].includes(computer.runtimeKind)) throw new Error("This address does not match the enrollment computer. No enrollment credential was sent.");
  const response = await request(new URL("/api/enroll", origin.origin), {
    ...options, method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (text.length > 8192) throw new Error("The computer returned an invalid enrollment response.");
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("The computer returned an invalid enrollment response."); }
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Enrollment failed. Create a new browser link on the host.");
  if (result.computerId !== input.computerId || typeof result.token !== "string" || result.token.length < 32 || result.token.length > 512 || !Number.isFinite(result.expiresAt)) throw new Error("The computer returned an invalid enrollment session.");
  const storage = deps.storage ?? window.localStorage;
  persistWebToken(result.token, storage);
  storage.setItem(WEB_COMPUTER_KEY, input.computerId);
}

/** React StrictMode and repeated renders share one one-time redemption. */
export function redeemCapturedEnrollment(input: WebEnrollment): Promise<void> {
  exchange ??= exchangeWebEnrollment(input, { origin: window.location.origin });
  return exchange;
}

// This module is the first BootApp dependency: strip the fragment before the
// application module evaluates, including when a previous session is saved.
if (typeof window !== "undefined") captureWebEnrollment();
