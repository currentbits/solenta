import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const root = path.resolve('..');
const installed = path.resolve(process.env.SOLENTA_FILM_APP || '../out/Solenta Nightly.app/Contents/Resources/app');
const version = JSON.parse(readFileSync(path.join(installed,'package.json'),'utf8'));
if (!/^[a-f0-9]{7,40}$/.test(version.buildSha)) throw new Error('Installed build must identify its source revision');
const dir = path.resolve('out/installed-capture');
mkdirSync(dir,{recursive:true});
// Isolated storage and demo data. Never attach to the running app or its store.
app.setPath('userData',path.join(dir,'user-data'));
const archive = execFileSync('git',['archive',version.buildSha,'src'],{cwd:root,maxBuffer:20*1024*1024});
execFileSync('tar',['-xf','-','-C',dir],{input:archive});
if (!existsSync(path.join(dir,'assets'))) symlinkSync(path.join(installed,'dist/assets'),path.join(dir,'assets'));
const html = readFileSync(path.join(installed,'dist/index.html'),'utf8');
writeFileSync(path.join(dir,'index.html'),html.replace('<script type="module"','<script src="./fixture.js"></script>\n    <script type="module"'));
const { PROVIDERS, honouredPermissionModes } = require(path.join(installed,'electron/providers.js'));
writeFileSync('capture/providers.json',JSON.stringify(PROVIDERS.map(p=>({id:p.id,name:p.name,available:true,supportsResume:p.supportsResume,supportsSteer:!!p.supportsSteer,supportsSearch:!!p.supportsSearch,models:p.models,modelInfo:p.modelInfo,efforts:p.efforts||[],permissionModes:honouredPermissionModes(p)})),null,2));
const fingerprint = name => createHash('sha256').update(readFileSync(path.join(installed,'dist',name))).digest('hex');
const assets = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^\"]+)"/g)].map(m=>({file:m[1],sha256:fingerprint(m[1])}));
const manifest = {version:version.version,buildSha:version.buildSha,assets,method:'Installed distribution rendered by Electron; isolated demo data; no UI/CSS overrides',scenes:{}};
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
try {
  mkdirSync('public/captures',{recursive:true});
  const requested = process.argv.slice(2);
  for (const scene of requested.length ? requested : ['overview','composer','providers','memory','workers','git']) {
    await build({entryPoints:['capture/fixture.js'],bundle:true,format:'iife',platform:'browser',define:{'import.meta.env':'{}'},outfile:path.join(dir,'fixture.js'),
      banner:{js:`globalThis.__SOLENTA_FILM_SCENE__=${JSON.stringify(scene)};globalThis.__SOLENTA_FILM_BUILD__=${JSON.stringify({version:version.version,sha:version.buildSha,time:version.buildTime,channel:version.channel})};`},
      plugins:[{name:'matching-app-revision',setup(b){b.onResolve({filter:/^\.\.\/\.\.\/src\//},args=>({path:path.join(dir,'src',args.path.split('/src/')[1])}));}}],
    });
    const win = new BrowserWindow({width:2880,height:1600,show:false,backgroundColor:'#0a0d13',webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,partition:`film-${scene}`}});
    const errors=[];
    win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)errors.push(message);});
    await win.loadFile(path.join(dir,'index.html'));
    win.webContents.setZoomFactor(2);
    await pause(1800);
    const boxes = await win.webContents.executeJavaScript(`(async()=>{
      const pause=ms=>new Promise(r=>setTimeout(r,ms));
      const click=s=>{const e=document.querySelector(s);if(!e)throw new Error('Missing control: '+s);e.click();};
      const scene=${JSON.stringify(scene)};
      if(innerWidth!==1440||innerHeight!==800)throw new Error('Unexpected capture viewport: '+innerWidth+'x'+innerHeight);
      if(scene==='memory'||scene==='workers'){
        click('[aria-label="Show agents panel"]'); await pause(350);
        const name=scene==='memory'?'Memory':'Agents';
        const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()===name);
        if(!b)throw new Error('Missing tab: '+name);b.click();await pause(350);
        if(scene==='memory')click('[data-memory-toggle]');
      }
      if(scene==='composer'||scene==='providers'){
        const input=document.querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Add fast project search. Keep the existing design, support the keyboard, and test the important paths.');
        input.dispatchEvent(new Event('input',{bubbles:true}));
      }
      if(scene==='providers')click('[aria-label^="Model:"]');
      await pause(700);await document.fonts.ready;
      return [...document.querySelectorAll('aside,[role="dialog"],textarea,[aria-label="Git"],[aria-label^="Model:"]')].map(e=>({tag:e.tagName,label:e.getAttribute('aria-label'),box:e.getBoundingClientRect().toJSON()}));
    })()`);
    await pause(400);
    const png = await win.webContents.capturePage();
    const buffer = png.toPNG({scaleFactor:2});
    writeFileSync(`public/captures/raw-${scene}.png`,buffer);
    writeFileSync(`out/capture-${scene}.log`,JSON.stringify({errors,boxes},null,2));
    if(errors.some(e=>/TypeError|ReferenceError|Uncaught|component crashed/i.test(e)))throw new Error(errors.join('\n'));
    // Product crops keep native proportions; the opening uses the whole window.
    const crops={overview:null,composer:null,providers:'420:280:415:414',memory:'380:475:1060:0',workers:'380:285:1060:258',git:'1108:510:300:0'};
    const size={width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}, ratio=size.width/1440;
    console.log(`Capture resolution: ${size.width}×${size.height}; representations: ${png.getScaleFactors()}`);
    const crop=crops[scene]?.split(':').map(v=>Math.round(Number(v)*ratio)).join(':');
    execFileSync('ffmpeg',['-y','-v','error','-i',`public/captures/raw-${scene}.png`,...(crop?['-vf',`crop=${crop}`]:[]),'-frames:v','1',`public/captures/${scene}.png`]);
    manifest.scenes[scene]={...size,crop:crops[scene],sha256:createHash('sha256').update(readFileSync(`public/captures/${scene}.png`)).digest('hex')};
    win.destroy();
    console.log(`Captured installed Solenta ${version.version} (${version.buildSha}): ${scene}`);
  }
  writeFileSync('public/captures/provenance.json',JSON.stringify(manifest,null,2)+'\n');
} catch(error) {
  console.error(error);
  process.exitCode=1;
} finally { app.quit(); }
});
