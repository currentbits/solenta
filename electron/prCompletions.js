"use strict";
const { gitTryAsync, ghApiTryAsync, tailErr } = require('./worktrees.js');
const { gitlabRemote, glabApi } = require('./gitlab.js');
const { parseRepoSlug } = require('./prLinks.js');

// Every request resolves origin anew. Never search all users or all accounts.
async function prCompletions(input) {
  const cwd = String(input?.projectPath || '');
  const kind = input?.kind;
  if (!cwd || !['@', '#', '!'].includes(kind)) return { ok: false, reason: 'Invalid completion request' };
  // Match the textarea token grammar at the trust boundary too. In particular,
  // GitHub search qualifiers, spaces and quotes must never augment repo scope.
  const query = input.query == null ? '' : input.query;
  if (typeof query !== 'string' || !/^[\w.-]{0,100}$/.test(query)) {
    return { ok: false, reason: 'Invalid completion query' };
  }
  const page = Math.max(1, Math.min(10, Math.trunc(Number(input.page) || 1)));
  const remote = await gitTryAsync(cwd, ['remote', 'get-url', 'origin']);
  if (!remote.ok) return { ok: false, reason: 'Repository unavailable' };
  const origin = String(remote.stdout || '').trim();
  const gl = gitlabRemote(origin);
  let rows;
  let exact = null;
  const numeric = kind !== "@" && page === 1 && /^[1-9]\d*$/.test(query) && Number.isSafeInteger(Number(query));
  if (gl) {
    // Explicit cross-repo requests stay on the origin host and its authenticated account.
    if (input.repo) gl.path = String(input.repo);
    const endpoint = kind === '@' ? '/members/all' : kind === '!' ? '/merge_requests' : '/issues';
    const [result, direct] = await Promise.all([
      glabApi(cwd, gl, 'GET', `${endpoint}?per_page=20&page=${page}&${kind === '@' ? 'query' : 'search'}=${encodeURIComponent(query)}`),
      numeric ? glabApi(cwd, gl, 'GET', `${endpoint}/${Number(query)}`) : null,
    ]);
    if (direct?.ok && Number(direct.data?.iid) === Number(query)) exact = direct.data;
    if (!result.ok && !exact) return result;
    rows = result.ok && Array.isArray(result.data) ? result.data : [];
  } else {
    if (kind === '!') return { ok: true, items: [], hasMore: false };
    const slug = parseRepoSlug(input.repo || origin);
    if (!slug) return { ok: false, reason: 'Repository unavailable' };
    const endpoint = kind === '@'
      ? `repos/${slug}/assignees?per_page=20&page=${page}`
      : `search/issues?q=${encodeURIComponent(`repo:${slug} ${query}`)}&per_page=20&page=${page}`;
    const host = origin.match(/^[^@/]+@([^:]+):/)?.[1] || (() => { try { return new URL(origin).hostname; } catch { return null; } })();
    if (!host) return { ok: false, reason: 'Repository host unavailable' };
    const request = endpoint => ghApiTryAsync(cwd, ['api', endpoint, '--hostname', host], { originUrl: origin, timeout: 15000 });
    const [result, direct] = await Promise.all([
      request(endpoint), numeric ? request(`repos/${slug}/issues/${Number(query)}`) : null,
    ]);
    if (direct?.ok) {
      try { const data = JSON.parse(direct.stdout); if (Number(data?.number) === Number(query)) exact = data; } catch { /* search remains available */ }
    }
    if (!result.ok && !exact) return { ok: false, reason: tailErr(result.stderr || result.combined, 'Completion search failed') };
    try { const data = result.ok ? JSON.parse(result.stdout) : []; rows = Array.isArray(data) ? data : data.items || []; }
    catch { if (!exact) return { ok: false, reason: 'Invalid completion response' }; rows = []; }
  }
  const hasMore = rows.length >= 20 && page < 10;
  // Pin the exact reference without displacing any of the 20 search rows or
  // shifting subsequent search pages. A first numeric page has at most 21 items.
  if (exact) rows = [exact, ...rows.filter(row => Number(row.iid || row.number) !== Number(query))];
  const items = rows.map(row => kind === '@'
    ? { value: `@${row.username || row.login}`, label: row.name || row.username || row.login }
    : { value: `${kind}${row.iid || row.number}`, label: row.title || '' })
    .filter(row => row.value.toLowerCase().includes(query.toLowerCase()) || row.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, exact ? 21 : 20);
  return { ok: true, items, hasMore };
}
module.exports = { prCompletions: async input => {
  try { return await prCompletions(input); }
  catch { return { ok: false, reason: 'Completion search unavailable' }; }
} };
