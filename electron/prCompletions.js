"use strict";
const { gitTryAsync, ghApiTryAsync, tailErr } = require('./worktrees.js');
const { gitlabRemote, glabApi } = require('./gitlab.js');
const { parseRepoSlug } = require('./prLinks.js');

// Every request resolves origin anew. Never search all users or all accounts.
async function prCompletions(input) {
  const cwd = String(input?.projectPath || '');
  const kind = input?.kind;
  if (!cwd || !['@', '#', '!'].includes(kind)) return { ok: false, reason: 'Invalid completion request' };
  const query = String(input.query || '').slice(0, 100);
  const page = Math.max(1, Math.min(10, Math.trunc(Number(input.page) || 1)));
  const remote = await gitTryAsync(cwd, ['remote', 'get-url', 'origin']);
  if (!remote.ok) return { ok: false, reason: 'Repository unavailable' };
  const origin = String(remote.stdout || '').trim();
  const gl = gitlabRemote(origin);
  let rows;
  if (gl) {
    // Explicit cross-repo requests stay on the origin host and its authenticated account.
    if (input.repo) gl.path = String(input.repo);
    const endpoint = kind === '@' ? '/members/all' : kind === '!' ? '/merge_requests' : '/issues';
    const result = await glabApi(cwd, gl, 'GET', `${endpoint}?per_page=20&page=${page}&${kind === '@' ? 'query' : 'search'}=${encodeURIComponent(query)}`);
    if (!result.ok) return result;
    rows = Array.isArray(result.data) ? result.data : [];
  } else {
    if (kind === '!') return { ok: true, items: [], hasMore: false };
    const slug = parseRepoSlug(input.repo || origin);
    if (!slug) return { ok: false, reason: 'Repository unavailable' };
    const endpoint = kind === '@'
      ? `repos/${slug}/assignees?per_page=20&page=${page}`
      : `search/issues?q=${encodeURIComponent(`repo:${slug} ${query}`)}&per_page=20&page=${page}`;
    const host = origin.match(/^[^@/]+@([^:]+):/)?.[1] || (() => { try { return new URL(origin).hostname; } catch { return null; } })();
    if (!host) return { ok: false, reason: 'Repository host unavailable' };
    const result = await ghApiTryAsync(cwd, ['api', endpoint, '--hostname', host], { originUrl: origin, timeout: 15000 });
    if (!result.ok) return { ok: false, reason: tailErr(result.stderr || result.combined, 'Completion search failed') };
    try { const data = JSON.parse(result.stdout); rows = Array.isArray(data) ? data : data.items || []; }
    catch { return { ok: false, reason: 'Invalid completion response' }; }
  }
  const hasMore = rows.length >= 20 && page < 10;
  const items = rows.map(row => kind === '@'
    ? { value: `@${row.username || row.login}`, label: row.name || row.username || row.login }
    : { value: `${kind}${row.iid || row.number}`, label: row.title || '' })
    .filter(row => row.value.toLowerCase().includes(query.toLowerCase()) || row.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 20);
  return { ok: true, items, hasMore };
}
module.exports = { prCompletions: async input => {
  try { return await prCompletions(input); }
  catch { return { ok: false, reason: 'Completion search unavailable' }; }
} };
