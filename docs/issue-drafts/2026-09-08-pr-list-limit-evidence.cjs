// Run: node docs/issue-drafts/2026-09-08-pr-list-limit-evidence.cjs
// Real listPrs with fake git origin and fake gh; no network or repo mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listPrs, setExecFile } = require('../../electron/worktrees.js');
const { writeFakeBin } = require('../../electron/test/support/fakeBin.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solenta-pr-limit-'));
const prior = process.env.CODER_GH_BIN;
(async () => {
  try {
    setExecFile((_bin, args, _opts, callback) => {
      assert.deepEqual(args, ['remote', 'get-url', 'origin']);
      callback(null, 'https://github.com/audit/example.git', '');
    });
    process.env.CODER_GH_BIN = writeFakeBin(path.join(tmp, 'fake-gh'), `
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ['pr', 'list']);
const limit = Number(args[args.indexOf('--limit') + 1]);
assert.equal(limit, 50);
const all = Array.from({length:75}, (_, i) => ({number:i+1,title:'PR '+(i+1),url:'https://github.com/audit/example/pull/'+(i+1),state:'OPEN',headRefName:'fix/'+i}));
process.stdout.write(JSON.stringify(all.slice(0, limit)));
`);
    const result = await listPrs(tmp);
    assert.equal(result.ok, true);
    assert.equal(result.prs.length, 50);
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'prs']);
    console.log('CONFIRMED: listPrs requests only 50 of 75 fixture PRs, returns success without completeness/pagination metadata.');
  } finally {
    setExecFile(null);
    if (prior === undefined) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prior;
    fs.rmSync(tmp, {recursive:true, force:true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
