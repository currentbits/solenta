"use strict";

/** Keep in sync with src/htmlPage.ts HTML_MAX_CHARS. */
const HTML_MAX_CHARS = 200_000;

function mimeLooksHtml(mime) {
  return typeof mime === "string" && /^text\/html\b/i.test(mime);
}

function uriLooksUi(uri) {
  return typeof uri === "string" && uri.startsWith("ui://");
}

function isUiResource(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const resource =
    node.resource && typeof node.resource === "object" ? node.resource : node;
  const text = resource.text;
  return (
    typeof text === "string" &&
    text &&
    (uriLooksUi(resource.uri) || mimeLooksHtml(resource.mimeType))
  );
}

function resourceText(node) {
  if (!isUiResource(node)) return null;
  const resource =
    node.resource && typeof node.resource === "object" ? node.resource : node;
  return resource.text;
}

function collectHtml(node, seen) {
  if (node == null) return null;
  if (typeof node === "string") {
    const t = node.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
    if (!/ui:\/\//.test(t) && !/"text\/html/.test(t)) return null;
    try {
      return collectHtml(JSON.parse(t), seen);
    } catch {
      return null;
    }
  }
  if (typeof node !== "object") return null;
  if (seen.has(node)) return null;
  seen.add(node);
  const own = resourceText(node);
  if (own) return own;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = collectHtml(item, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of ["content", "contents", "success", "result"]) {
    if (key in node) {
      const hit = collectHtml(node[key], seen);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function extractHtml(value) {
  const html = collectHtml(value, new WeakSet());
  if (!html || html.length > HTML_MAX_CHARS) return null;
  return html;
}

function rewriteHtml(node, seen) {
  if (node == null || typeof node !== "object") return node;
  if (seen.has(node)) return node;
  seen.add(node);
  if (isUiResource(node)) {
    if (node.resource && typeof node.resource === "object") {
      return {
        ...node,
        resource: { ...node.resource, text: "[html]" },
      };
    }
    return { ...node, text: "[html]" };
  }
  if (Array.isArray(node)) return node.map((item) => rewriteHtml(item, seen));
  const out = { ...node };
  for (const key of ["content", "contents", "success", "result"]) {
    if (key in out) out[key] = rewriteHtml(out[key], seen);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redactHtml(value) {
  if (typeof value === "string") {
    const t = value.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return value;
    if (!/ui:\/\//.test(t) && !/"text\/html/.test(t)) return value;
    try {
      return JSON.stringify(rewriteHtml(JSON.parse(t), new WeakSet()));
    } catch {
      return value;
    }
  }
  return rewriteHtml(value, new WeakSet());
}

function flattenLooksHtml(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "resource" || block.type === "resource_link") {
    const resource =
      block.resource && typeof block.resource === "object"
        ? block.resource
        : block;
    return uriLooksUi(resource.uri) || mimeLooksHtml(resource.mimeType);
  }
  return isUiResource(block);
}

module.exports = {
  HTML_MAX_CHARS,
  extractHtml,
  redactHtml,
  flattenLooksHtml,
  isUiResource,
};
