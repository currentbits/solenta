/**
 * Split streaming markdown into independently parseable chunks (#1475).
 *
 * A chunk boundary is a line at column 0 that follows a blank line, outside
 * any fenced code block. At such a line every container has closed: a blank
 * line ends paragraphs, tables, blockquotes and HTML blocks, and an unindented
 * line after it ends list items and indented code. So parsing each chunk on
 * its own yields the same blocks as parsing the whole text. Everything before
 * the last boundary is settled; only the last chunk still grows.
 *
 * When unsure, don't split:
 * - a list marker never starts a chunk if the current chunk already has one
 *   (`- a\n\n- b` is ONE loose list);
 * - a line starting with `<` never starts a chunk, and a chunk that starts
 *   with `<` never ends: a chunk of only raw HTML renders nothing, which would
 *   leave a stray separator;
 * - the whole text stays one chunk if it has a link reference or footnote
 *   definition (it can resolve `[x]` in ANY chunk, even earlier ones) or an
 *   HTML block that may span blank lines (`<!--`, `<pre`, `<script`, ...).
 *
 * ponytail: fence tracking strips list/quote prefixes and doesn't model
 * indented code, so a fence-like line inside indented code can desync it.
 * Only a streaming message is ever split, and its final render is one parse,
 * so a desync shows at worst until the reply finishes.
 */
const DEFINITION = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?\[[^\]]+\]:/m;
const SPANNING_HTML = /^ {0,3}<(?:[!?]|(?:pre|script|style|textarea)(?:[\s>]|$))/im;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const CONTAINER_PREFIX = /^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]*)*/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;

export function markdownChunks(text: string): string[] {
  if (DEFINITION.test(text) || SPANNING_HTML.test(text)) return [text];
  const chunks: string[] = [];
  let start = 0;
  let fence: string | null = null;
  let afterBlank = false;
  let hasList = false;
  let startsHtml = false;
  let pos = 0;
  for (const line of text.split("\n")) {
    if (
      fence === null &&
      afterBlank &&
      !startsHtml &&
      /^[^\s<]/.test(line) &&
      !(hasList && LIST_ITEM.test(line))
    ) {
      chunks.push(text.slice(start, pos));
      start = pos;
      hasList = false;
    }
    if (pos === start) startsHtml = /^ {0,3}</.test(line);
    if (LIST_ITEM.test(line)) hasList = true;
    const f = FENCE.exec(line.replace(CONTAINER_PREFIX, ""));
    if (f) {
      if (fence === null) {
        // A backtick fence's info string can't contain a backtick.
        if (!(f[1][0] === "`" && f[2].includes("`"))) fence = f[1];
      } else if (
        f[1][0] === fence[0] &&
        f[1].length >= fence.length &&
        !f[2].trim()
      ) {
        fence = null;
      }
    }
    afterBlank = line.trim() === "";
    pos += line.length + 1;
  }
  chunks.push(text.slice(start));
  return chunks;
}
