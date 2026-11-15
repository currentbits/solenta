"use strict";

const MAX_STEPS = 12;
const MAX_CONTENT = 200;

function parseTurnPlan(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_STEPS || items.some((item) =>
    !item || typeof item.content !== "string" || !item.content.trim() || item.content.length > MAX_CONTENT ||
    !["pending", "in_progress", "completed"].includes(item.status))) {
    throw new Error(`Plan needs 1–${MAX_STEPS} steps with content (1–${MAX_CONTENT} characters) and status pending, in_progress, or completed`);
  }
  return items.map(({ content, status }) => ({ content: content.trim(), status }));
}

module.exports = { parseTurnPlan, MAX_STEPS, MAX_CONTENT };
