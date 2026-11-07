const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getProvider, modelSupportsUltracode, cliSupportsUltracode } = require('../providers');
const { Store } = require('../store');
const services = require('../services');

describe('Ultracode independent session mode', () => {
  it('emits the native session setting at xhigh, retaining ordinary effort when off', () => {
    const claude = getProvider('claude');
    const base = { model: 'claude-opus-5', reasoningEffort: 'low', cliSupportsUltracode: true };
    const on = claude.buildArgs({ ...base, ultracode: true });
    assert.equal(on[on.indexOf('--effort') + 1], 'xhigh');
    assert.deepEqual(JSON.parse(on[on.indexOf('--settings') + 1]), { ultracode: true });
    const off = claude.buildArgs({ ...base, ultracode: false });
    assert.equal(off[off.indexOf('--effort') + 1], 'low');
    assert.ok(!off.includes('--settings'));
    for (const model of ['claude-haiku-4-5', 'unknown', null]) {
      assert.equal(modelSupportsUltracode(claude, model), false);
      assert.ok(!claude.buildArgs({ ...base, model, ultracode: true }).includes('--settings'));
    }
    assert.ok(!claude.buildArgs({ ...base, cliSupportsUltracode: false, ultracode: true }).includes('--settings'));
    for (const effort of ['xhigh', 'max']) {
      const args = claude.buildArgs({ ...base, reasoningEffort: effort });
      assert.equal(args[args.indexOf('--effort') + 1], effort);
    }
  });

  it('gates actual binary versions without starting an agent', { skip: process.platform === 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultracode-version-'));
    try {
      for (const [version, expected] of [['2.1.218', false], ['2.1.219', true], ['2.2.0', true], ['unknown', false]]) {
        const bin = path.join(dir, version);
        fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = "--version" ] || exit 12\nprintf '%s\\n' '${version} (Claude Code)'\n`, { mode: 0o755 });
        assert.equal(cliSupportsUltracode(bin), expected, version);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('migrates legacy rows safely and persists independent effort through toggles and reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultracode-store-'));
    try {
      const file = path.join(dir, 'store.json');
      const rows = [
        { id: 'opus', provider: 'claude', model: 'claude-opus-5' },
        { id: 'haiku', provider: 'claude', model: 'claude-haiku-4-5' },
        { id: 'codex', provider: 'codex', model: 'gpt-6-astra' },
      ].map((t) => ({ ...t, projectId: 'p', title: t.id, status: 'idle', reasoningEffort: 'ultracode' }));
      fs.writeFileSync(file, JSON.stringify({ projects: [], threads: rows, messagesByThread: {} }));
      const store = new Store(file);
      assert.equal(store.getThread('opus').ultracode, true);
      assert.equal(store.getThread('opus').reasoningEffort, 'xhigh');
      assert.equal(store.getThread('haiku').ultracode, false);
      assert.equal(store.getThread('codex').ultracode, false);
      services.setReasoningEffort(store, { threadId: 'opus', effort: 'max' });
      services.setUltracode(store, { threadId: 'opus', ultracode: false });
      assert.equal(store.getThread('opus').reasoningEffort, 'max');
      services.setUltracode(store, { threadId: 'opus', ultracode: true });
      assert.equal(store.getThread('opus').reasoningEffort, 'max');
      services.setProvider(store, { threadId: 'opus', model: 'claude-haiku-4-5' });
      assert.equal(store.getThread('opus').ultracode, false);
      assert.throws(() => services.setUltracode(store, { threadId: 'haiku', ultracode: true }), /xhigh-capable/);
      assert.throws(() => services.setUltracode(store, { threadId: 'codex', ultracode: true }), /Claude/);
      store.saveNow();
      assert.equal(new Store(file).getThread('opus').ultracode, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Ultracode saved configurations', () => {
  it('applies independent profile effort and carries mode only to eligible forks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultracode-profile-'));
    try {
      require('node:child_process').execFileSync('git', ['init', dir], { stdio: 'ignore' });
      const store = new Store(path.join(dir, 'store.json'));
      const project = await services.addProject(store, dir);
      const thread = services.createThread(store, { projectId: project.id });
      services.setSettings(store, { agentProfiles: [{ id: 'mode', name: 'Mode', provider: 'claude', model: 'claude-opus-5', reasoningEffort: 'max', ultracode: true, permissionMode: 'default' }] });
      services.applyAgentProfile(store, { threadId: thread.id, profileId: 'mode' });
      assert.equal(store.getThread(thread.id).ultracode, true);
      assert.equal(store.getThread(thread.id).reasoningEffort, 'max');
      const fork = services.forkThread(store, { threadId: thread.id });
      assert.equal(fork.ultracode, true);
      assert.equal(fork.reasoningEffort, 'max');
      const other = services.forkThread(store, { threadId: thread.id, provider: 'codex', model: 'gpt-6-astra' });
      assert.equal(other.ultracode, false);
      services.setProvider(store, { threadId: thread.id, provider: 'codex', model: 'gpt-6-astra' });
      assert.equal(store.getThread(thread.id).ultracode, false);
      store.saveNow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
