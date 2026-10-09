"use strict";

/**
 * Opt-in squash-message cleanup (#1531): drop `Co-authored-by:` trailers that
 * name an AI agent, keep human co-authors.
 */

const AGENT_WORD = /claude|codex|grok|cursor|gemini|copilot|chatgpt|openai|aider|devin|kimi|opencode/i;
const AGENT_DOMAIN = /@(anthropic\.com|openai\.com|x\.ai|cursor\.(com|sh)|google\.com)$/i;
const NOREPLY = /no-?reply/i;
const TRAILER = /^\s*co-authored-by:\s*(.*?)\s*(?:<([^>]*)>)?\s*$/i;

/**
 * An agent identity: a `[bot]` account, an agent-ish or noreply mailbox at an
 * agent vendor, or an agent-named noreply. "Claude Monet <c@monet.fr>" stays.
 * @param {string} name
 * @param {string} email
 */
function isAgentIdentity(name, email) {
  if (/\[bot\]/i.test(name) || /\[bot\]/i.test(email)) return true;
  const local = email.split("@")[0] || "";
  if (AGENT_DOMAIN.test(email) && (NOREPLY.test(local) || AGENT_WORD.test(local))) {
    return true;
  }
  const first = name.trim().split(/\s+/)[0] || "";
  return AGENT_WORD.test(first) && NOREPLY.test(email);
}

/**
 * Remove agent `Co-authored-by:` lines and the trailing blank lines that
 * leaves. Pure; everything else in the message is kept verbatim.
 * @param {string} message
 * @returns {string}
 */
function stripAgentCoauthors(message) {
  const kept = String(message ?? "")
    .split("\n")
    .filter((line) => {
      const m = TRAILER.exec(line);
      return !m || !isAgentIdentity(m[1] || "", m[2] || "");
    });
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join("\n");
}

/**
 * `gh pr merge` args overriding the squash body with agent co-authors
 * stripped. Rebuilds GitHub's default commit-list body from the PR commits;
 * returns [] (leave GitHub's message alone) when nothing would be stripped or
 * the commits cannot be read.
 * @param {string} cwd
 * @param {number | string} number
 * @param {(cwd: string, args: string[], opts?: object) => Promise<{ ok: boolean, stdout: string }>} runGh
 * @returns {Promise<string[]>}
 */
async function strippedSquashBodyArgs(cwd, number, runGh) {
  const viewed = await runGh(cwd, ["pr", "view", String(number), "--json", "commits"]);
  if (!viewed.ok) return [];
  let commits;
  try {
    commits = JSON.parse(viewed.stdout).commits;
  } catch {
    return [];
  }
  if (!Array.isArray(commits) || commits.length === 0) return [];
  // Strip per commit so a trailer mid-list never leaves a blank-line gap.
  const build = (strip) => {
    const bodyOf = (c) => {
      const body = String((c && c.messageBody) || "").trim();
      return strip ? stripAgentCoauthors(body) : body;
    };
    if (commits.length === 1) return bodyOf(commits[0]);
    return commits
      .map((c) => {
        const body = bodyOf(c);
        return `* ${String((c && c.messageHeadline) || "").trim()}${body ? `\n\n${body}` : ""}`;
      })
      .join("\n\n");
  };
  const stripped = build(true);
  return stripped === build(false) ? [] : ["--body", stripped];
}

module.exports = { isAgentIdentity, stripAgentCoauthors, strippedSquashBodyArgs };
