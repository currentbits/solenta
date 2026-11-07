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
