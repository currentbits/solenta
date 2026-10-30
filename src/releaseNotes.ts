/**
 * Short "what's new" summary from a GitHub release body, for the sidebar's
 * update popover (issue #1757). Pure and synchronous.
 *
 * Strips <details> blocks and HTML comments, then keeps either the bullets
 * under a Highlights/Added/New heading, or the first bullet list in the body
 * (the "What's Changed" shape `gh release create --generate-notes` produces),
 * or the first paragraph when there is no bullet list at all (the one-line
 * nightly body). Each kept line has its "(#123)" issue ref and GitHub's
 * generated "by @user in <url>" tail dropped. Capped so the popover never
 * grows unbounded.
 */

export const RELEASE_SUMMARY_MAX_CHARS = 280;
export const RELEASE_SUMMARY_MAX_BULLETS = 5;

const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^[-*]\s+(.*)/;
const HIGHLIGHT_HEADING_RE = /^#{1,6}\s*(highlights|added|new)\b/i;

function stripNoise(body: string): string {
  return body
    .replace(/<details[\s\S]*?<\/details>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\*\*Full Changelog\*\*:.*$/im, "")
    .replace(/^#{1,6}\s*new contributors[\s\S]*$/im, "")
    .trim();
}

/** Drop a GitHub-generated bullet's "(#123)" ref and "by @user in <url>" tail. */
function cleanLine(text: string): string {
  return text
    .replace(/\s+by\s+@[\w-]+\s+in\s+https?:\/\/\S+\s*$/i, "")
    .replace(/\[([^\]]*)\]\(https?:\/\/\S+\)/g, "$1")
    .replace(/\s*\(#\d+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capSummary(rawLines: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const raw of rawLines.slice(0, RELEASE_SUMMARY_MAX_BULLETS)) {
    const line = cleanLine(raw);
    if (!line) continue;
    const remaining = RELEASE_SUMMARY_MAX_CHARS - total;
    if (remaining <= 1) break;
    const text =
      line.length > remaining ? `${line.slice(0, remaining - 1).trimEnd()}…` : line;
    out.push(text);
    total += text.length;
  }
  return out;
}

/** Text of the first contiguous bullet list starting at or after `from`. */
function firstBulletList(lines: string[], from = 0): string[] {
  const bullets: string[] = [];
  let started = false;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim();
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      started = true;
      if (bullet[1].trim()) bullets.push(bullet[1].trim());
      continue;
    }
    if (!started) continue; // keep scanning past headings/blank lines for the first bullet
    if (line === "") continue; // blank line inside/after the list
    break; // non-bullet prose ends the list
  }
  return bullets;
}

/** 1-5 short lines summarizing a release body, or [] when there is nothing usable. */
export function summarizeReleaseNotes(body: string | null | undefined): string[] {
  if (!body || !body.trim()) return [];
  const lines = stripNoise(body).split(/\r?\n/);

  const highlightIdx = lines.findIndex((l) => HIGHLIGHT_HEADING_RE.test(l.trim()));
  if (highlightIdx !== -1) {
    const bullets = firstBulletList(lines, highlightIdx + 1);
    if (bullets.length) return capSummary(bullets);
  }

  const anyBullets = firstBulletList(lines);
  if (anyBullets.length) return capSummary(anyBullets);

  const paragraph = lines
    .join("\n")
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .find((p) => p.length > 0 && !HEADING_RE.test(p) && !BULLET_RE.test(p));
  return paragraph ? capSummary([paragraph]) : [];
}
