/**
 * Sandboxed HTML pages (#1525): wrap/CSP/cap and the MCP Apps host
 * listener. The iframe component is in htmlFence.test.tsx.
 *
 * Run: node --import=./test/support/render.mjs --test test/htmlPage.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HTML_CSP,
  HTML_MAX_CHARS,
  HTML_SANDBOX,
  handleMcpAppMessage,
  htmlFitsCap,
  htmlFromToolOutput,
  wrapHtmlPage,
} from "../src/htmlPage";

describe("html page wrap (#1525)", () => {
  it("uses allow-scripts only and a no-network CSP", () => {
    assert.equal(HTML_SANDBOX, "allow-scripts");
    assert.match(HTML_CSP, /default-src 'none'/);
    assert.match(HTML_CSP, /connect-src 'none'/);
    assert.match(HTML_CSP, /frame-src 'none'/);
    assert.match(HTML_CSP, /base-uri 'none'/);
    assert.match(HTML_CSP, /form-action 'none'/);
    assert.doesNotMatch(HTML_SANDBOX, /same-origin|popups|top-navigation|forms/);
    assert.doesNotMatch(HTML_CSP, /connect-src 'self'/);
  });

  it("wraps a fragment and injects the CSP meta", () => {
    const out = wrapHtmlPage("<h1>Hi</h1><script>document.title=1</script>");
    assert.match(out, /<html[\s>]/i);
    assert.match(out, /<meta http-equiv="Content-Security-Policy"/i);
    assert.match(out, /<h1>Hi<\/h1>/);
    assert.match(out, /document\.title=1/);
    assert.ok(out.includes(HTML_CSP));
  });

  it("injects CSP into an existing document and drops a looser policy", () => {
    const out = wrapHtmlPage(
      "<!doctype html><html><head>" +
        '<meta http-equiv="Content-Security-Policy" content="default-src *">' +
        '<meta http-equiv="refresh" content="0;url=https://evil.test">' +
        "</head><body>ok</body></html>",
    );
    assert.equal(
      (out.match(/Content-Security-Policy/gi) || []).length,
      1,
      "only our CSP remains",
    );
    assert.doesNotMatch(out, /default-src \*/);
    assert.doesNotMatch(out, /refresh/i);
    assert.match(out, /<body>ok<\/body>/);
  });

  it("caps oversized pages", () => {
    assert.equal(htmlFitsCap("x".repeat(HTML_MAX_CHARS)), true);
    assert.equal(htmlFitsCap("x".repeat(HTML_MAX_CHARS + 1)), false);
    assert.throws(() => wrapHtmlPage("x".repeat(HTML_MAX_CHARS + 1)), /too large/i);
  });
});

describe("html from tool output (#1525)", () => {
  it("pulls embedded ui:// HTML out of a tool result", () => {
    const html = htmlFromToolOutput(
      JSON.stringify({
        content: [
          { type: "text", text: "opened chart" },
          {
            type: "resource",
            resource: {
              uri: "ui://charts/sales",
              mimeType: "text/html",
              text: "<div id='c'>sales</div>",
            },
          },
        ],
      }),
    );
    assert.equal(html, "<div id='c'>sales</div>");
  });

  it("accepts text/html;profile=mcp-app and a flat resource block", () => {
    const html = htmlFromToolOutput(
      JSON.stringify({
        type: "resource",
        uri: "ui://app",
        mimeType: "text/html;profile=mcp-app",
        text: "<p>app</p>",
      }),
    );
    assert.equal(html, "<p>app</p>");
  });

  it("ignores resource_link without text and ordinary tool JSON", () => {
    assert.equal(
      htmlFromToolOutput(
        JSON.stringify({
          type: "resource_link",
          uri: "ui://charts/sales",
          mimeType: "text/html",
        }),
      ),
      null,
    );
    assert.equal(htmlFromToolOutput(JSON.stringify({ path: "probe.txt" })), null);
    assert.equal(htmlFromToolOutput("just stdout"), null);
    assert.equal(htmlFromToolOutput(null), null);
  });
});

describe("MCP Apps host messages (#1525)", () => {
  const iframe = {};

  function send(data: unknown, source: object = iframe) {
    const posted: unknown[] = [];
    handleMcpAppMessage(
      { data, source } as MessageEvent,
      {
        source: iframe,
        post: (msg) => posted.push(msg),
      },
    );
    return posted;
  }

  it("answers ui/initialize without proxying tools or resources", () => {
    const posted = send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26" },
    });
    assert.equal(posted.length, 1);
    const reply = posted[0] as {
      id: number;
      result: {
        protocolVersion: string;
        hostCapabilities: Record<string, unknown>;
        hostInfo: { name: string };
      };
    };
    assert.equal(reply.id, 1);
    assert.equal(reply.result.protocolVersion, "2026-01-26");
    assert.equal(reply.result.hostInfo.name, "solenta");
    assert.equal(reply.result.hostCapabilities.serverTools, undefined);
    assert.equal(reply.result.hostCapabilities.serverResources, undefined);
    assert.ok(reply.result.hostCapabilities.openLinks);
  });

  it("rejects tools/call and resources/read so the frame cannot reach MCP", () => {
    for (const method of ["tools/call", "resources/read", "resources/list"]) {
      const posted = send({ jsonrpc: "2.0", id: 7, method, params: {} });
      assert.equal(posted.length, 1, method);
      const err = posted[0] as { id: number; error: { code: number; message: string } };
      assert.equal(err.id, 7);
      assert.ok(err.error.code < 0);
      assert.match(err.error.message, /not proxied|not supported/i);
    }
  });

  it("ignores messages from any other window", () => {
    const posted = send(
      { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} },
      {},
    );
    assert.deepEqual(posted, []);
  });
});
