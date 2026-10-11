/**
 * Sandboxed HTML pages in the thread (#1525).
 *
 * srcdoc + sandbox="allow-scripts" (no allow-same-origin) gives the page a
 * unique opaque origin, so it cannot read the preload bridge or the web
 * token. CSP then blocks network. wrapHtmlPage is the only way a page
 * reaches an iframe.
 */

export const HTML_SANDBOX = "allow-scripts";

/** ~200KB of source. Charts and tables fit; a dumped site does not. */
export const HTML_MAX_CHARS = 200_000;

/**
 * No 'self' on connect-src: if someone later adds allow-same-origin, 'self'
 * would be the renderer origin (preload + local token).
 */
export const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`;

export function htmlFitsCap(html: string): boolean {
  return html.length <= HTML_MAX_CHARS;
}

function stripHostileMeta(html: string): string {
  return html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
}

export function wrapHtmlPage(html: string): string {
  if (!htmlFitsCap(html)) throw new Error("HTML page too large");
  const body = stripHostileMeta(html);
  if (/<html[\s>]/i.test(body)) {
    if (/<head[\s>]/i.test(body)) {
      return body.replace(/<head(\s[^>]*)?>/i, `<head$1>${CSP_META}`);
    }
    return body.replace(/<html(\s[^>]*)?>/i, `<html$1><head>${CSP_META}</head>`);
  }
  return `<!doctype html><html><head>${CSP_META}</head><body>${body}</body></html>`;
}

function mimeLooksHtml(mime: unknown): boolean {
  return typeof mime === "string" && /^text\/html\b/i.test(mime);
}

function uriLooksUi(uri: unknown): boolean {
  return typeof uri === "string" && uri.startsWith("ui://");
}

function htmlFromNode(node: unknown, seen: WeakSet<object>): string | null {
  if (node == null) return null;
  if (typeof node === "string") {
    const t = node.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
    if (!/ui:\/\//.test(t) && !/"text\/html/.test(t)) return null;
    try {
      return htmlFromNode(JSON.parse(t), seen);
    } catch {
      return null;
    }
  }
  if (typeof node !== "object") return null;
  if (seen.has(node)) return null;
  seen.add(node);

  const o = node as Record<string, unknown>;
  const resource =
    o.resource && typeof o.resource === "object"
      ? (o.resource as Record<string, unknown>)
      : o;
  const text = resource.text;
  if (
    typeof text === "string" &&
    text &&
    (uriLooksUi(resource.uri) || mimeLooksHtml(resource.mimeType))
  ) {
    return text;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = htmlFromNode(item, seen);
      if (hit) return hit;
    }
    return null;
  }

  for (const key of ["content", "contents", "success", "result"]) {
    if (key in o) {
      const hit = htmlFromNode(o[key], seen);
      if (hit) return hit;
    }
  }
  return null;
}

/** Best-effort pull of an embedded MCP UI page from already-stored tool output. */
export function htmlFromToolOutput(output: string | null | undefined): string | null {
  if (output == null) return null;
  return htmlFromNode(output, new WeakSet());
}

export type McpAppHost = {
  source: object;
  post: (msg: unknown) => void;
};

function jsonRpcError(id: unknown, message: string) {
  return { jsonrpc: "2.0", id, error: { code: -32601, message } };
}

function initializeResult(id: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "solenta", version: "0" },
      hostCapabilities: {
        openLinks: {},
        logging: {},
        sandbox: {
          csp: {
            connectDomains: [] as string[],
            resourceDomains: [] as string[],
            frameDomains: [] as string[],
            baseUriDomains: [] as string[],
          },
        },
      },
      hostContext: {
        displayMode: "inline",
        platform: "desktop",
        containerDimensions: { maxHeight: 480 },
      },
    },
  };
}

/**
 * Host side of the MCP Apps postMessage bridge. Only messages from this
 * iframe are handled. tools/call is refused: the host has no MCP client
 * (a follow-up), and granting it would let the page drive configured servers.
 */
export function handleMcpAppMessage(event: MessageEvent, host: McpAppHost): void {
  if (event.source !== host.source) return;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const msg = data as { jsonrpc?: unknown; id?: unknown; method?: unknown };
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  if (msg.id == null) return;
  if (msg.method === "ui/initialize") {
    host.post(initializeResult(msg.id));
    return;
  }
  host.post(jsonRpcError(msg.id, "not proxied"));
}
