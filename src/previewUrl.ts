/**
 * Renderer-side preview URL helpers (issue #155). Main-process enforcement
 * lives in electron/links.js; keep the loopback check in lockstep.
 */

export function coercePreviewUrl(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Require :// so "localhost:5173" is a host:port, not a scheme.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  return `http://${s}`;
}

export function isLoopbackPreviewUrl(url: string): boolean {
  try {
    const u = new URL(coercePreviewUrl(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "::" ||
      host === "::ffff:127.0.0.1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
