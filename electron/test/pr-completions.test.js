"use strict";
const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
let spawn;
function setExecFile(fn) { spawn = fn; }
function setGithubApi() {}
const run = (cwd, args, bin) => new Promise(resolve => spawn(bin, args, { cwd }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr })));
const moduleStub = { exports: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../prCompletions.js'), 'utf8'), { module: moduleStub, URL, require(name) {
  if (name === './worktrees.js') return { gitTryAsync: (cwd, args) => run(cwd, args, 'git'), ghApiTryAsync: (cwd, args) => run(cwd, args, 'gh'), tailErr: (text, fallback) => text || fallback };
  if (name === './gitlab.js') return { gitlabRemote: require('../gitlab.js').gitlabRemote, glabApi: async (cwd, remote, method, endpoint) => {
    const r = await run(cwd, ['api', '--hostname', remote.host, '-X', method, `projects/${encodeURIComponent(remote.path)}${endpoint}`], 'glab');
    return r.ok ? { ok: true, data: JSON.parse(r.stdout) } : { ok: false, reason: r.stderr };
  } };
  return require(name === './prLinks.js' ? '../prLinks.js' : name);
} });
const { prCompletions } = moduleStub.exports;
afterEach(() => { spawn = null; });
it('keeps GitHub reference search bounded to the selected repository and origin host', async () => {
  const calls = [];
  setGithubApi(false);
  setExecFile((bin, args, opts, cb) => {
    calls.push({ bin, args, cwd: opts.cwd });
    cb(null, args[0] === 'remote' ? 'git@github.com:owner/private.git\n' : JSON.stringify({ items: [{ number: 12, title: 'Fix' }] }), '');
  });
  const result = await prCompletions({ projectPath: '/repo', repo: 'owner/selected', kind: '#', query: '12' });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ value: '#12', label: 'Fix' }]);
  const search = calls.find(c => c.args[0] === 'api');
  assert.match(decodeURIComponent(search.args[1]), /repo:owner\/selected 12/);
  assert.deepEqual(Array.from(search.args.slice(-2)), ['--hostname', 'github.com']);
  assert.match(search.args[1], /per_page=20&page=1/);
});
it('uses GitLab project members and MR iid notation on the original host', async () => {
  const calls = [];
  setExecFile((bin, args, opts, cb) => {
    calls.push(args);
    cb(null, args[0] === 'remote' ? 'git@gitlab.example:team/private.git\n' : JSON.stringify([{ iid: 7, title: 'Patch' }]), '');
  });
  const result = await prCompletions({ projectPath: '/repo', kind: '!', query: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ value: '!7', label: 'Patch' }]);
  assert.deepEqual(calls[1].slice(0, 5), ['api', '--hostname', 'gitlab.example', '-X', 'GET']);
  assert.match(calls[1][5], /^projects\/team%2Fprivate\/merge_requests\?/);
});
it('never falls back to global user search and reports denied access', async () => {
  setGithubApi(false);
  setExecFile((bin, args, opts, cb) => {
    if (args[0] === 'remote') return cb(null, 'git@github.com:owner/private.git\n', '');
    assert.match(args[1], /^repos\/owner\/private\/assignees\?/);
    cb(new Error('denied'), '', 'HTTP 403: permission denied');
  });
  assert.equal((await prCompletions({ projectPath: '/repo', kind: '@', query: '' })).ok, false);
});

it('includes repository assignees who have never contributed', async () => {
  setExecFile((bin, args, opts, cb) => {
    if (args[0] === 'remote') return cb(null, 'git@github.com:owner/private.git', '');
    assert.match(args[1], /\/assignees\?/);
    cb(null, JSON.stringify([{ login: 'maintainer', name: 'Review maintainer' }]), '');
  });
  const result = await prCompletions({ projectPath: '/repo', kind: '@', query: 'maint' });
  assert.equal(result.items[0].value, '@maintainer');
});

it('finds numeric GitHub references independently of title text and deduplicates them', async () => {
  const calls = [];
  setExecFile((bin, args, opts, cb) => {
    calls.push(args);
    if (args[0] === 'remote') return cb(null, 'git@github.com:owner/private.git', '');
    cb(null, JSON.stringify(args[1].endsWith('/issues/42')
      ? { number: 42, title: 'Unrelated title' }
      : { items: [{ number: 142, title: 'Text 42 match' }] }), '');
  });
  const result = await prCompletions({ projectPath: '/repo', kind: '#', query: '42' });
  assert.equal(result.items[0].value, '#42');
  assert.equal(result.items[0].label, 'Unrelated title');
  assert.equal(result.items[1].value, '#142');
  assert.ok(calls.some(args => args[1] === 'repos/owner/private/issues/42'));
  calls.length = 0;
  await prCompletions({ projectPath: '/repo', kind: '#', query: '42', page: 2 });
  assert.equal(calls.some(args => args[1]?.endsWith('/issues/42')), false);
});

it('finds numeric GitLab issues and merge requests even without text search matches', async () => {
  for (const kind of ['#', '!']) {
    const calls = [];
    setExecFile((bin, args, opts, cb) => {
      calls.push(args);
      if (args[0] === 'remote') return cb(null, 'git@gitlab.example:team/private.git', '');
      cb(null, JSON.stringify(args[5].endsWith('/42') ? { iid: 42, title: 'Unrelated title' } : []), '');
    });
    const result = await prCompletions({ projectPath: '/repo', kind, query: '42' });
    assert.equal(result.items[0].value, `${kind}42`);
    assert.equal(result.items[0].label, 'Unrelated title');
    assert.equal(result.hasMore, false);
    assert.ok(calls.some(args => args[5] === `projects/team%2Fprivate/${kind === '#' ? 'issues' : 'merge_requests'}/42`));
    calls.length = 0;
    await prCompletions({ projectPath: '/repo', kind, query: '42', page: 2 });
    assert.equal(calls.some(args => args[5]?.endsWith('/42')), false);
  }
});

it('preserves a full search page beside an exact hit and tolerates unavailable exact references', async () => {
  let missing = false;
  setExecFile((bin, args, opts, cb) => {
    if (args[0] === 'remote') return cb(null, 'git@github.com:owner/private.git', '');
    if (args[1].endsWith('/issues/42')) return missing
      ? cb(new Error('missing'), '', '404 not found')
      : cb(null, JSON.stringify({ number: 42, title: 'Unrelated title' }), '');
    cb(null, JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ number: 420 + i, title: 'Matching 42' })) }), '');
  });
  const result = await prCompletions({ projectPath: '/repo', kind: '#', query: '42' });
  assert.equal(result.items.length, 21);
  assert.equal(result.hasMore, true);
  assert.equal(result.items.at(-1).value, '#439');
  missing = true;
  const fallback = await prCompletions({ projectPath: '/repo', kind: '#', query: '42' });
  assert.equal(fallback.items.length, 20);
  assert.equal(fallback.hasMore, true);
});

it('deduplicates an exact search hit and keeps exact lookup available when search fails', async () => {
  let searchFails = false;
  setExecFile((bin, args, opts, cb) => {
    if (args[0] === 'remote') return cb(null, 'git@github.com:owner/private.git', '');
    const issue = { number: 42, title: 'Unrelated title' };
    if (args[1].endsWith('/issues/42')) return cb(null, JSON.stringify(issue), '');
    if (searchFails) return cb(new Error('unavailable'), '', '503 search unavailable');
    cb(null, JSON.stringify({ items: [issue] }), '');
  });
  for (const fail of [false, true]) {
    searchFails = fail;
    const result = await prCompletions({ projectPath: '/repo', kind: '#', query: '42' });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].value, '#42');
    assert.equal(result.hasMore, false);
  }
});
