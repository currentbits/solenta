const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractHtml, redactHtml } = require("../tool-html.js");
const { harvestToolResult } = require("../tool-images.js");
const { flattenContent } = require("../claude.js");

const PAGE = "<div id='c'>sales</div>";
const UI = {
  type: "resource",
  resource: {
    uri: "ui://charts/sales",
    mimeType: "text/html",
    text: PAGE,
  },
};

describe("tool html (#1525)", () => {
  it("extracts embedded ui:// HTML and skips resource_link / ordinary JSON", () => {
    assert.equal(extractHtml([{ type: "text", text: "opened" }, UI]), PAGE);
    assert.equal(
      extractHtml({
        success: { content: [{ type: "text", text: "opened" }, UI] },
      }),
      PAGE,
    );
    assert.equal(
      extractHtml({
        type: "resource",
        uri: "ui://app",
        mimeType: "text/html;profile=mcp-app",
        text: PAGE,
      }),
      PAGE,
    );
    assert.equal(
      extractHtml({ type: "resource_link", uri: "ui://x", mimeType: "text/html" }),
      null,
    );
    assert.equal(extractHtml({ path: "probe.txt" }), null);
    assert.equal(extractHtml("stdout"), null);
  });

  it("harvests HTML before truncate and redacts it from the stored output", () => {
    const harvested = harvestToolResult([{ type: "text", text: "opened" }, UI]);
    assert.equal(harvested.html, PAGE);
    const text = JSON.stringify(harvested.redacted);
    assert.ok(!text.includes("<div id='c'>"), "page body must not sit in output JSON");
    assert.match(text, /\[html\]/);
  });

  it("flattenContent prints [html] instead of the page source", () => {
    assert.equal(
      flattenContent([{ type: "text", text: "opened" }, UI]),
      "opened\n[html]",
    );
  });
});
