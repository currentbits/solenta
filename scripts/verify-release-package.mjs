#!/usr/bin/env node
// Native Windows/Linux counterpart to verify-package.sh. Requires gh, tar,
// Node 22 and a display (xvfb on Linux). Downloads the published payload;
// never substitutes source dependencies or disables Chromium's sandbox.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { signalGroup } from '../electron/proc.js';

assert(['linux', 'win32'].includes(process.platform) && process.arch === 'x64',
  'Run this check on native Linux/Windows x64');
const repo = 'currentbits/solenta';
const api = (route) => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${route}`], { encoding: 'utf8' }));
const requested = process.argv[2] || 'latest-nightly';
const release = requested === 'latest-nightly'
  ? api('releases?per_page=100').find((r) => !r.draft && r.prerelease && r.tag_name.startsWith('nightly-'))
  : api(`releases/tags/${encodeURIComponent(requested)}`);
assert(release && !release.draft, 'Published release not found');
const tag = release.tag_name;
const sha = api(`commits/${encodeURIComponent(tag)}`).sha;
const platform = `${process.platform}-x64`;
const suffix = process.platform === 'win32' ? `${platform}.zip` : `${platform}.tar.gz`;
const assets = release.assets.filter((a) => a.name.endsWith(`-${suffix}`));
assert.equal(assets.length, 1, 'Expected exactly one platform asset');
const asset = assets[0];
assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/, 'Release asset must have a SHA-256 digest');
assert.equal(path.basename(asset.name), asset.name, 'Invalid asset filename');

const temp = process.env.RUNNER_TEMP || os.tmpdir();
const root = fs.mkdtempSync(path.join(temp, 'solenta-package-'));
const reports = path.join(temp, 'solenta-package-verification');
fs.mkdirSync(reports, { recursive: true });
const logPath = path.join(reports, 'boot.log');
const report = { tag, sha, platform, asset: asset.name, digest: asset.digest, passed: false };
let child;
let childError;
let closed;
const token = crypto.randomBytes(32).toString('hex');
try {
  console.log(`Verifying ${tag} (${sha}) on ${platform}`);
  execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', root], { stdio: 'inherit' });
  const archive = path.join(root, asset.name);
  assert.equal(fs.statSync(archive).size, asset.size, 'Asset size mismatch');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  assert.equal(`sha256:${hash.digest('hex')}`, asset.digest, 'Asset checksum mismatch');
  execFileSync('tar', ['-xf', archive, '-C', root], { stdio: 'inherit' });
  const nightly = tag.startsWith('nightly-');
  const slug = nightly ? 'solenta-nightly' : 'solenta';
  const app = path.join(root, slug);
  const metadata = JSON.parse(fs.readFileSync(path.join(app, 'resources/app/package.json'), 'utf8'));
  assert.equal(metadata.releaseTag, tag);
  assert.equal(metadata.channel, nightly ? 'nightly' : 'prod');
  assert.match(metadata.buildSha, /^[a-f0-9]{7,40}$/);
  assert(sha.startsWith(metadata.buildSha), 'Packaged source commit differs from release tag');
  report.metadata = metadata;

  if (process.platform === 'linux') {
    // Install the shipped SUID helper on the disposable runner. This enables
    // Chromium's sandbox on Ubuntu's restricted-user-namespace configuration.
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Linux sandbox installation is restricted to disposable CI runners');
    const sandbox = path.join(app, 'chrome-sandbox');
    execFileSync('sudo', ['chown', 'root:root', sandbox]);
    execFileSync('sudo', ['chmod', '4755', sandbox]);
    report.sandbox = 'packaged SUID helper, root:root 4755';
  }
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(userData);
  const dbPath = path.join(userData, 'memory.db');
  const config = path.join(userData, 'memory-server.json');
  fs.writeFileSync(config, JSON.stringify({ port, token, dbPath }), { mode: 0o600 });
  const env = { ...process.env, CODER_MEMORY_CONFIG: config, SOLENTA_SKIP_USERDATA_MIGRATION: '1', ELECTRON_ENABLE_LOGGING: '1' };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const log = fs.openSync(logPath, 'w');
  try {
    child = spawn(path.join(app, slug + (process.platform === 'win32' ? '.exe' : '')),
      [`--user-data-dir=${userData}`], { cwd: app, env, detached: process.platform !== 'win32', stdio: ['ignore', log, log] });
  } finally { fs.closeSync(log); }
  child.on('error', (error) => { childError = error; });
  closed = new Promise((resolve) => child.once('close', resolve));
  const base = `http://127.0.0.1:${port}`;
  async function healthUntil(predicate, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      assert(child.exitCode === null && child.signalCode === null, `Packaged app exited: ${child.exitCode ?? child.signalCode}`);
      let health;
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) health = await response.json();
      } catch { /* The supervisor may still be starting. */ }
      if (health?.ok === true && predicate(health)) return health;
      await delay(500);
    }
    throw new Error(`Package health/embedding timed out after ${timeout}ms; see boot.log`);
  }
  const before = await healthUntil(() => true, 30_000);
  assert.equal(before.entryCount, 0, 'Probe must use an empty isolated database');
  const marker = `package-probe-${crypto.randomUUID()}`;
  const response = await fetch(`${base}/api/store`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'knowledge', title: 'Package verification', body: marker, force: true }),
  });
  assert(response.ok, `Memory store returned HTTP ${response.status}`);
  const { id } = await response.json();
  assert.equal(typeof id, 'string');
  const after = await healthUntil((h) => h.vectors?.count > (before.vectors?.count || 0), 180_000);
  // Read the configured DB itself: a health response from a different service
  // must not pass isolation, and an unrelated vector must not pass inference.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT body FROM entries WHERE id = ?').get(id)?.body, marker);
    const vector = db.prepare('SELECT dim, length(vec) AS bytes FROM entry_vectors WHERE entry_id = ?').get(id);
    assert(vector?.dim > 0 && vector.bytes > 0, 'Stored entry has no real embedding');
    report.embeddingDimensions = vector.dim;
  } finally { db.close(); }
  report.health = after;
  report.passed = true;
  console.log('PASS: published metadata, checksum, isolated startup, memory storage and embedding');
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (child?.pid) {
    const killed = signalGroup(child, 'SIGKILL');
    if (!killed && child.exitCode === null && child.signalCode === null) {
      report.passed = false;
      report.cleanupError = 'Could not terminate packaged process tree';
      process.exitCode = 1;
    }
    await Promise.race([closed, delay(6000)]);
  }
  if (fs.existsSync(logPath)) fs.writeFileSync(logPath, fs.readFileSync(logPath, 'utf8').replaceAll(token, '[redacted]'));
  fs.writeFileSync(path.join(reports, 'result.json'), JSON.stringify(report, null, 2));
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
