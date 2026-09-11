import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const file='out/solenta-x-trailer.mp4';
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
const video=probe.streams.find(s=>s.codec_type==='video');
const audio=probe.streams.find(s=>s.codec_type==='audio');
assert.equal(video.codec_name,'h264');
assert.equal(video.pix_fmt,'yuv420p');
assert.equal(video.color_space,'bt709');
assert.equal(video.color_range,'tv');
assert.equal(video.width,1600); assert.equal(video.height,1000);
assert.equal(video.r_frame_rate,'30/1');
assert.equal(Number(video.nb_frames),1440);
assert.ok(Math.abs(Number(probe.format.duration)-48)<.1);
assert.equal(audio.codec_name,'aac'); assert.equal(audio.channels,2);
assert.ok(statSync(file).size<512*1024*1024);
const source=readFileSync('src/Composition.tsx','utf8');
assert.ok(!source.includes('\u2014'),'Visible copy must be em-dash free');
assert.deepEqual(readFileSync('public/solenta-logo.svg'),readFileSync('../assets/icon.svg'),'Use the official Solenta logo unchanged');
const provenance=JSON.parse(readFileSync('public/captures/provenance.json','utf8'));
const installed=process.env.SOLENTA_FILM_APP || '../out/Solenta Nightly.app/Contents/Resources/app';
assert.equal(provenance.buildSha,JSON.parse(readFileSync(path.join(installed,'package.json'),'utf8')).buildSha,'Captures must match the installed build');
const hash=data=>createHash('sha256').update(data).digest('hex');
for(const asset of provenance.assets) assert.equal(hash(readFileSync(path.join(installed,'dist',asset.file))),asset.sha256,'Use the unmodified installed renderer and CSS');
assert.equal(provenance.scenes.overview.crop,null,'Keep the whole app visible in the opening');
for(const scene of ['overview','composer','providers','memory','workers','git']) {
  const png=readFileSync(`public/captures/${scene}.png`);
  assert.equal(png.toString('ascii',1,4),'PNG');
  assert.ok(png.readUInt32BE(16)>=760,'UI plates must be captured at 2x');
  assert.equal(provenance.scenes[scene].width,2880);
  assert.equal(provenance.scenes[scene].height,1600);
  assert.equal(hash(png),provenance.scenes[scene].sha256,'Do not mix capture revisions');
}
// Decode every frame: metadata alone cannot detect a corrupt media stream.
execFileSync('ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-'],{stdio:'pipe'});
const corners=execFileSync('ffmpeg',['-v','error','-i',file,'-vf','crop=2:2:0:0,scale=1:1,format=rgb24','-an','-f','rawvideo','-']);
assert.equal(corners.length,1440*3);
assert.ok(corners.every(value=>value<64),'Keep the backdrop dark throughout, including transitions');
const summary={file,duration:48,width:video.width,height:video.height,fps:30,frames:Number(video.nb_frames),video:video.codec_name,audio:audio.codec_name,channels:audio.channels,sizeMB:+(statSync(file).size/1e6).toFixed(1),decode:'passed',uiPlates:'6 fresh 2x Electron captures of the installed distribution',uiBuild:provenance.buildSha};
writeFileSync('out/validation.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
