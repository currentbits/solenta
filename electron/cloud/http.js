"use strict";

async function readJSON(stream, maxBytes = 32768) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("Cloud message is too large."), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Expected a cloud JSON object.");
  return value;
}

async function fetchJSON(fetch, url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) throw Object.assign(new Error("Cloud service request failed."), { remoteStatus: response.status });
  return readJSON(response.body);
}

module.exports = { readJSON, fetchJSON };
