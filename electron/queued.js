"use strict";

/**
 * Type-ahead queue rows (#137, #809, #1512). `items` is one string per
 * queued thought and `itemAttachments` the files each one was queued with,
 * index for index, so a drained item takes only its own files. `prompt`
 * and `attachments` stay as the joined text and the flattened files for
 * readers that want the whole blob.
 */

/**
 * Normalize a stored queue row. Rows from before #809 have no items: split
 * the prompt once, as the queue strip always has. Rows from before #1512
 * have no itemAttachments: their files all ride with the first item,
 * which is where #1501's one-per-turn drain sent them.
 *
 * @param {any} q
 * @returns {any}
 */
function normalizeQueued(q) {
  if (!q || typeof q !== "object") return null;
  const items =
    Array.isArray(q.items) && q.items.length
      ? q.items.map((s) => String(s))
      : String(q.prompt ?? "").split("\n\n");
  const files =
    Array.isArray(q.itemAttachments) && q.itemAttachments.length === items.length
      ? q.itemAttachments.map((f) => (Array.isArray(f) ? f : []))
      : items.map((_, i) => (i === 0 && Array.isArray(q.attachments) ? q.attachments : []));
  return withItems(q, items, files);
}

/**
 * Rebuild the derived fields from items + per-item files.
 * @param {object} q
 * @param {string[]} items
 * @param {object[][]} files
 */
function withItems(q, items, files) {
  /** @type {Record<string, unknown>} */
  const next = { ...q, prompt: items.join("\n\n"), items, itemAttachments: files };
  const flat = files.flat();
  if (flat.length) next.attachments = flat;
  else delete next.attachments;
  return next;
}

module.exports = { normalizeQueued, withItems };
