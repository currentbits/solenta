// Read-only production calls; synthetic registry lives in a disposable directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { listSkills } = require('../../electron/skills.js');
const { listCatalog } = require('../../electron/skillCatalog.js');
const { registryPath } = require('../../electron/skillRegistry.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solenta-skills-perf-'));
const output = [];
try {
 for (const n of [100, 300, 600]) {
  const home = path.join(tmp, String(n)), ud = path.join(home, 'userdata');
  const installs = {};
  for (let i = 0; i < n; i++) {
   const name = `skill-${i}`, id = i.toString(16).padStart(32, '0');
   installs[id] = {name, provenance:'added', sourceLabel:'Synthetic audit fixture'};
   for (const provider of ['.agents', '.claude', '.codex']) {
    const dir = path.join(home, provider, 'skills', name);
    fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(dir,'SKILL.md'), `---\nname: ${name}\ndescription: Audit fixture\n---\nInstructions\n`);
    fs.writeFileSync(path.join(dir,'.solenta-skill.json'), JSON.stringify({installId:id}));
   }
  }
  fs.mkdirSync(path.dirname(registryPath(ud)),{recursive:true});
  fs.writeFileSync(registryPath(ud),JSON.stringify({version:1,installs}));
  let registryReads=0, skillReads=0;
  const original=fs.readFileSync;
  fs.readFileSync=function(file,...args){if(String(file)===registryPath(ud))registryReads++;if(String(file).endsWith('/SKILL.md'))skillReads++;return original.call(this,file,...args)};
  const env={HOME:home,XDG_CONFIG_HOME:path.join(home,'.config')};
  const start=performance.now();
  try {
   const rows=listSkills(null,env,ud);
   listCatalog({env,userDataPath:ud});
   assert.equal(rows.length,n);
   assert.equal(registryReads,6*n);
   assert.equal(skillReads,6*n);
  } finally {fs.readFileSync=original;}
  output.push({skills:n,providerCopies:3,registryReads,skillReads,mainThreadBlockedMs:Math.round(performance.now()-start)});
 }
 const start=performance.now();
 const rows=listSkills(process.cwd(),process.env);
 listCatalog({env:process.env});
 output.push({realHomeReadOnly:true,rows:rows.length,pairedScanMs:Math.round(performance.now()-start)});
 console.log(JSON.stringify(output,null,2));
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
