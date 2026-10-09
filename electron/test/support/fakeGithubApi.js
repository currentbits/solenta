"use strict";

/**
 * In-memory GitHub for one repo, served through an injected fetch (#1534).
 * Answers exactly the GraphQL/REST shapes electron/github.js ghPr sends.
 * `failWith: <status>` makes every request fail; `calls` logs each request.
 *
 * @param {{ prs?: object[], checks?: object[], failWith?: number }} [seed]
 */
function fakeGithubApi(seed = {}) {
  const state = {
    failWith: seed.failWith || 0,
    prs: (seed.prs || []).map((p) => ({
      state: "OPEN",
      isDraft: false,
      title: "",
      body: "",
      baseRefName: "main",
      isCrossRepository: false,
      comments: [],
      ...p,
    })),
    checks: seed.checks || [],
    /** @type {Array<{ url: string, method: string, body: any }>} */
    calls: [],
  };
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const node = (p) => ({ id: `PR_${p.number}`, author: { login: "octocat" }, ...p, comments: { nodes: p.comments } });
  const byNumber = (n) => state.prs.find((p) => p.number === Number(n));

  async function fetchFn(url, init) {
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ url, method: init.method, body });
    if (state.failWith) return reply(state.failWith, { message: "boom" });

    if (url.endsWith("/graphql")) {
      const q = body.query;
      const v = body.variables || {};
      const toggle = q.match(/(markPullRequestReadyForReview|convertPullRequestToDraft)/);
      if (toggle) {
        const pr = state.prs.find((p) => `PR_${p.number}` === v.id);
        pr.isDraft = toggle[1] === "convertPullRequestToDraft";
        return reply(200, { data: { [toggle[1]]: { clientMutationId: null } } });
      }
      if (/pullRequest\(number: \$n\) \{ commits/.test(q)) {
        const pr = byNumber(v.n);
        const nodes = state.checks;
        return reply(200, {
          data: { repository: { pullRequest: pr ? { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } } : null } },
        });
      }
      if (/pullRequest\(number: \$n\)/.test(q)) {
        const pr = byNumber(v.n);
        return reply(200, { data: { repository: { pullRequest: pr ? node(pr) : null } } });
      }
      if (/headRefName: \$head/.test(q)) {
        const nodes = state.prs.filter((p) => p.headRefName === v.head).reverse().map(node);
        return reply(200, { data: { repository: { pullRequests: { nodes } } } });
      }
      if (/pullRequests\(first: \$first/.test(q)) {
        const all = state.prs.filter((p) => v.states.includes(p.state)).reverse();
        const start = v.after ? Number(v.after) : 0;
        const page = all.slice(start, start + v.first);
        const end = start + page.length;
        const withReviews = (p) => (/reviews\(/.test(q) ? { ...node(p), reviews: { nodes: p.reviews || [] } } : node(p));
        return reply(200, {
          data: { repository: { pullRequests: { nodes: page.map(withReviews), pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } },
        });
      }
      return reply(200, { errors: [{ message: `fake: unhandled query ${q}` }] });
    }

    const m = new URL(url).pathname.match(/\/repos\/[^/]+\/[^/]+\/(pulls|issues)(?:\/(\d+))?(\/merge|\/comments)?$/);
    if (!m) return reply(404, { message: "Not Found" });
    const [, kind, num, tail] = m;
    if (kind === "pulls" && !num && init.method === "POST") {
      const number = state.prs.reduce((n, p) => Math.max(n, p.number), 0) + 1;
      const pr = {
        number,
        url: `https://github.com/acme/demo/pull/${number}`,
        state: "OPEN",
        isDraft: Boolean(body.draft),
        title: body.title,
        body: body.body,
        headRefName: body.head,
        baseRefName: body.base,
        isCrossRepository: false,
        comments: [],
      };
      state.prs.push(pr);
      return reply(201, { number, html_url: pr.url });
    }
    const pr = byNumber(num);
    if (!pr) return reply(404, { message: "Not Found" });
    if (tail === "/merge" && init.method === "PUT") {
      if (pr.state !== "OPEN") return reply(405, { message: "Pull Request is not mergeable" });
      pr.state = "MERGED";
      return reply(200, { merged: true });
    }
    if (tail === "/comments" && init.method === "POST") {
      pr.comments.push({ author: { login: "octocat" }, body: body.body, createdAt: "2026-10-09T00:00:00Z" });
      return reply(201, { html_url: `${pr.url}#issuecomment-${pr.comments.length}` });
    }
    if (!tail && init.method === "PATCH") {
      if (body.title != null) pr.title = body.title;
      if (body.body != null) pr.body = body.body;
      if (body.state === "closed") pr.state = "CLOSED";
      return reply(200, { number: pr.number });
    }
    return reply(404, { message: "Not Found" });
  }

  return { fetchFn, state, tokenFn: async () => "t0k" };
}

module.exports = { fakeGithubApi };
