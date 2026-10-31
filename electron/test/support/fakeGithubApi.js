"use strict";

/**
 * In-memory GitHub for one repo, served through an injected fetch (#1534).
 * Answers exactly the GraphQL/REST shapes electron/github.js ghPr/ghIssue
 * send. `failWith: <status>` makes every request fail; `calls` logs each
 * request.
 *
 * @param {{ prs?: object[], checks?: object[], failWith?: number, repo?: { allowSquash?: boolean, allowMerge?: boolean, allowRebase?: boolean } }} [seed]
 */
function fakeGithubApi(seed = {}) {
  // The signed-in identity: default comment/reaction author, and what
  // viewerDidAuthor / viewerHasReacted compare against.
  const VIEWER_LOGIN = "octocat";
  let nextCommentId = 1000;
  let nextReactionId = 1;

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
      comments: (p.comments || []).map((c) => ({
        databaseId: nextCommentId++,
        author: VIEWER_LOGIN,
        createdAt: "2026-09-10T12:00:00Z",
        reactions: [],
        ...c,
      })),
    })),
    checks: seed.checks || [],
    // issue #1781: GET /repos/o/r for the allowed merge methods.
    repo: {
      allowSquash: true,
      allowMerge: true,
      allowRebase: true,
      ...(seed.repo || {}),
    },
    /** @type {Array<{ url: string, method: string, body: any }>} */
    calls: [],
  };
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const authorOf = (p) => (typeof p.author === "string" ? { login: p.author } : p.author || { login: VIEWER_LOGIN });
  const labelsOf = (p) =>
    Array.isArray(p.labels) ? { nodes: p.labels.map((name) => ({ name })) } : undefined;
  const commentNode = (c) => {
    const byContent = new Map();
    for (const r of c.reactions || []) {
      if (!byContent.has(r.content)) byContent.set(r.content, []);
      byContent.get(r.content).push(r.login);
    }
    const reactionGroups = [...byContent.entries()].map(([content, logins]) => ({
      content,
      viewerHasReacted: logins.includes(VIEWER_LOGIN),
      users: { totalCount: logins.length },
    }));
    const { reactions, ...rest } = c;
    return {
      ...rest,
      author: authorOf(c),
      url: c.url || `https://github.com/acme/demo/pull/0#issuecomment-${c.databaseId}`,
      reactionGroups,
    };
  };
  const node = (p) => {
    const labels = labelsOf(p);
    return {
      id: `PR_${p.number}`,
      ...p,
      author: authorOf(p),
      ...(labels ? { labels } : {}),
      comments: { nodes: (p.comments || []).map(commentNode) },
    };
  };
  const byNumber = (n) => state.prs.find((p) => p.number === Number(n));
  const findComment = (id) => {
    for (const pr of state.prs) {
      const comment = (pr.comments || []).find((c) => c.databaseId === Number(id));
      if (comment) return { pr, comment };
    }
    return null;
  };

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

    const u = new URL(url);
    const pathname = u.pathname;
    if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname) && init.method === "GET") {
      return reply(200, {
        allow_squash_merge: state.repo.allowSquash !== false,
        allow_merge_commit: state.repo.allowMerge !== false,
        allow_rebase_merge: state.repo.allowRebase !== false,
      });
    }

    // Comment-scoped endpoints (#1795 features 2/3): not nested under a PR
    // number, gh's REST comment/reaction ids are global to the repo.
    const reactionMatch = pathname.match(
      /\/repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/comments\/(\d+)\/reactions(?:\/(\d+))?$/,
    );
    if (reactionMatch) {
      const [, commentId, reactionId] = reactionMatch;
      const found = findComment(commentId);
      if (!found) return reply(404, { message: "Not Found" });
      if (init.method === "GET") {
        const content = u.searchParams.get("content");
        const rows = (found.comment.reactions || [])
          .filter((r) => !content || r.content === content)
          .map((r) => ({ id: r.id, content: r.content, user: { login: r.login } }));
        return reply(200, rows);
      }
      if (init.method === "POST") {
        const reaction = { id: nextReactionId++, content: body.content, login: VIEWER_LOGIN };
        found.comment.reactions = found.comment.reactions || [];
        found.comment.reactions.push(reaction);
        return reply(201, { id: reaction.id, content: reaction.content, user: { login: VIEWER_LOGIN } });
      }
      if (init.method === "DELETE" && reactionId) {
        found.comment.reactions = (found.comment.reactions || []).filter(
          (r) => r.id !== Number(reactionId),
        );
        return reply(204, null);
      }
      return reply(404, { message: "Not Found" });
    }
    const commentMatch = pathname.match(/\/repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/comments\/(\d+)$/);
    if (commentMatch && init.method === "PATCH") {
      const found = findComment(commentMatch[1]);
      if (!found) return reply(404, { message: "Not Found" });
      if (body.body != null) found.comment.body = body.body;
      return reply(200, { id: found.comment.databaseId });
    }

    const m = pathname.match(/\/repos\/[^/]+\/[^/]+\/(pulls|issues)(?:\/(\d+))?(\/merge|\/comments|\/update-branch)?$/);
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
    if (tail === "/update-branch" && init.method === "PUT") {
      pr.mergeStateStatus = "CLEAN";
      return reply(202, { message: "Updating pull request branch.", url: pr.url });
    }
    if (tail === "/comments" && init.method === "POST") {
      const comment = {
        databaseId: nextCommentId++,
        author: VIEWER_LOGIN,
        body: body.body,
        createdAt: "2026-10-09T00:00:00Z",
        reactions: [],
      };
      pr.comments.push(comment);
      comment.url = `${pr.url}#issuecomment-${comment.databaseId}`;
      return reply(201, { html_url: comment.url });
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
