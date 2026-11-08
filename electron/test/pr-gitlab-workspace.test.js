"use strict";
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const source = require.resolve('../prWorkspace.js');
const localRequire = createRequire(source);
it('loads and edits GitLab descriptions and comments on the origin host/project', async () => {
  const calls = [];
  const mr = { iid: 7, web_url: 'https://gitlab.example/team/private/-/merge_requests/7', title: 'MR', description: '@alice !7', source_branch: 'feature', state: 'opened' };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module: mod, require(name) {
    if (name === './worktrees.js') return { ...localRequire(name), gitTryAsync: async () => ({ ok: true, stdout: 'git@gitlab.example:team/private.git' }) };
    if (name === './gitlab.js') return { ...localRequire(name), glabGraphql: async () => ({ ok: false, reason: 'field unavailable' }), glabApi: async (cwd, remote, method, endpoint, fields) => {
      calls.push({ cwd, remote, method, endpoint, fields });
      if (method === 'PUT') Object.assign(mr, fields);
      return { ok: true, data: endpoint.includes('/notes') ? [] : mr };
    } };
    return localRequire(name);
  } });
  const detail = await mod.exports.viewPrDetail('/repo', 7);
  assert.equal(detail.pr.forge, 'gitlab');
  assert.equal(detail.pr.body, '@alice !7');
  const edited = await mod.exports.editPr('/repo', { prNumber: 7, body: '@bob #2 !8' });
  assert.equal(edited.pr.body, '@bob #2 !8');
  assert.equal((await mod.exports.commentPr('/repo', { prNumber: 7, body: '@bob !7' })).ok, true);
  assert.equal(calls.find(c => c.method === 'POST').fields.body, '@bob !7');
  for (const call of calls) {
    assert.equal(call.remote.host, 'gitlab.example');
    assert.equal(call.remote.path, 'team/private');
    assert.equal(call.cwd, '/repo');
  }
});
