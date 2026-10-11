"use strict";

/**
 * Linked PRs + viewed-mark / stack helpers (#1527).
 * Keep in lockstep with src/prLinks.ts, src/prViewed.ts, src/prStack.ts.
 */

function prLinkKey(link) {
  return `${String((link && link.repo) || "").trim().toLowerCase()}#${Number(link && link.number)}`;
}

function normalizePrLink(raw) {
  if (!raw || typeof raw !== "object") return null;
  const number = Number(raw.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const link = { number };
  if (raw.repo != null && String(raw.repo).trim()) link.repo = String(raw.repo).trim();
  if (raw.url != null && String(raw.url).trim()) link.url = String(raw.url).trim();
  const state = String(raw.state || "").toUpperCase();
  if (state === "OPEN" || state === "CLOSED" || state === "MERGED") link.state = state;
  if (raw.title != null && String(raw.title).trim()) link.title = String(raw.title).trim();
  return link;
}

function normalizePrLinks(thread) {
  const raw = thread && Array.isArray(thread.prLinks) ? thread.prLinks : [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const link = normalizePrLink(row);
    if (!link) continue;
    const key = prLinkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  const primary = Number(thread && thread.prNumber);
  if (Number.isInteger(primary) && primary > 0) {
    const key = prLinkKey({ number: primary });
    if (!out.some((l) => prLinkKey(l) === key) && !out.some((l) => l.number === primary && l.repo)) {
      const link = normalizePrLink({
        number: primary,
        url: thread.prUrl,
        state: thread.prState,
      });
      if (link) out.unshift(link);
    }
  }
  return out;
}

function upsertPrLink(links, next) {
  const key = prLinkKey(next);
  const existing = (links || []).find((l) => prLinkKey(l) === key);
  const out = (links || []).filter((l) => prLinkKey(l) !== key);
  out.push({ ...existing, ...next, number: next.number });
  return out;
}

function parseRepoSlug(value) {
  const raw = String(value || "").trim().replace(/\.git$/i, "");
  if (!raw) return null;
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
  const ssh = raw.match(/^git@[^:]+:(.+)$/);
  if (ssh) {
    const parts = ssh[1].replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  }
  try {
    const withProto = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withProto);
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function viewedKey(repo, prNumber) {
  return `${String(repo || "").trim().toLowerCase()}#${Number(prNumber)}`;
}

function viewedStatus(mark, current) {
  if (!mark || !mark.headSha) return "unseen";
  if (mark.blobSha && current && current.blobSha) {
    return mark.blobSha === current.blobSha ? "viewed" : "changed";
  }
  return mark.headSha === (current && current.headSha) ? "viewed" : "changed";
}

function refKey(name) {
  return String(name || "").trim().replace(/^refs\/heads\//, "");
}

function detectPrStacks(prs) {
  const rows = (prs || []).filter((p) => p && p.number > 0 && refKey(p.headRefName));
  const byHead = new Map();
  for (const pr of rows) byHead.set(refKey(pr.headRefName), pr);
  const seen = new Set();
  const stacks = [];
  for (const pr of rows) {
    if (seen.has(pr.number)) continue;
    let bottom = pr;
    const down = new Set();
    while (refKey(bottom.baseRefName)) {
      if (down.has(bottom.number)) break;
      down.add(bottom.number);
      const parent = byHead.get(refKey(bottom.baseRefName));
      if (!parent || parent.number === bottom.number) break;
      bottom = parent;
    }
    const chain = [];
    let cur = bottom;
    const up = new Set();
    while (cur && !up.has(cur.number)) {
      up.add(cur.number);
      chain.push(cur);
      seen.add(cur.number);
      const head = refKey(cur.headRefName);
      cur = rows.find((p) => p.number !== cur.number && refKey(p.baseRefName) === head);
    }
    if (chain.length >= 2) stacks.push(chain);
  }
  return stacks;
}

function stackContaining(stacks, prNumber) {
  const n = Number(prNumber);
  return (stacks || []).find((s) => s.some((p) => p.number === n)) || null;
}

/**
 * Attach a PR to a thread. First link becomes prNumber/prUrl/prState.
 * Never bumps updatedAt.
 */
function linkPullRequest(store, input) {
  const threadId = input && input.threadId;
  const thread = store.getThread(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  const number = Number(input && input.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("PR number must be a positive integer");
  }
  const repo = parseRepoSlug(input && input.repo) || parseRepoSlug(input && input.url);
  const link = normalizePrLink({
    number,
    repo,
    url: input && input.url,
    state: input && input.state,
    title: input && input.title,
  });
  if (!link) throw new Error("invalid pull request");
  const links = upsertPrLink(normalizePrLinks(thread), link);
  const primary = thread.prNumber == null ? link : null;
  const patch = {
    prLinks: links,
    ...(primary
      ? {
          prNumber: primary.number,
          prUrl: primary.url || thread.prUrl || null,
          prState: primary.state || thread.prState || null,
        }
      : {}),
  };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated || { ...thread, ...patch };
}

module.exports = {
  prLinkKey,
  normalizePrLink,
  normalizePrLinks,
  upsertPrLink,
  parseRepoSlug,
  viewedKey,
  viewedStatus,
  detectPrStacks,
  stackContaining,
  linkPullRequest,
};
