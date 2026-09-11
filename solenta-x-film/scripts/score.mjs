// Original 100 BPM score. Synthesized here, with no sampled or stock audio.
import { mkdirSync, writeFileSync } from 'node:fs';
const rate = 48000, duration = 48, length = rate * duration;
const left = new Float32Array(length), right = new Float32Array(length);
let seed = 19;
const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2147483648 - 1);
const hz = n => 440 * 2 ** ((n - 69) / 12);
function add(at, seconds, sample, volume, pan = 0) {
  const start = Math.round(at * rate), count = Math.min(Math.round(seconds * rate), length - start);
  for (let i = 0; i < count; i++) {
    const t = i / rate, x = sample(t, seconds) * volume;
    left[start + i] += x * Math.sqrt((1 - pan) / 2);
    right[start + i] += x * Math.sqrt((1 + pan) / 2);
  }
}
const pluck = f => t => Math.sin(2 * Math.PI * f * t + .35 * Math.sin(2 * Math.PI * 2 * f * t) * Math.exp(-t * 9)) * (1 - Math.exp(-t * 140)) * Math.exp(-t * 4.8);
const bass = f => (t, d) => (Math.sin(2 * Math.PI * f * t) + .18 * Math.sin(4 * Math.PI * f * t)) * Math.min(1, t / .012, (d - t) / .08) * Math.exp(-t * 2);
const chords = [[50,57,60,64,69], [46,53,57,60,65], [53,60,64,67,72], [48,55,59,62,67]];
for (let bar = 0; bar < 20; bar++) {
  const at = bar * 2.4, chord = chords[Math.floor(bar / 2) % 4];
  for (const [i,n] of chord.entries()) add(at, 3.3, (t,d) => {
    const f = hz(n + 12), env = Math.min(1, t / .4, (d - t) / 1.1);
    return env * (Math.sin(2*Math.PI*f*t) + .35*Math.sin(2*Math.PI*f*1.002*t));
  }, .022, (i - 2) * .3);
  if (bar < 18) {
    for (let beat = 0; beat < 4; beat++) {
      const t = at + beat * .6;
      add(t, .5, bass(hz(chord[0] - 12)), .18);
      if (bar >= 3) {
        add(t, .24, s => Math.sin(2*Math.PI*(48*s + 7*(1-Math.exp(-s*33)))) * Math.exp(-s*21), .29);
        if (beat % 2) add(t, .16, s => (noise()*.8 + Math.sin(2*Math.PI*180*s)*.2) * Math.exp(-s*36) * Math.min(1,s/.002), .08, .08);
      }
      if (bar >= 5) for(let h=0;h<2;h++) add(t+h*.3, .06, s => noise() * Math.exp(-s*95), .024, h ? .4 : -.3);
    }
  }
  const motif = [0,2,1,3,2,4,3,1];
  for (let step = 0; step < 8; step++) {
    if (bar < 3 && step % 2) continue;
    const atNote = at + step * .3, n = chord[motif[step]] + 12;
    const level = bar >= 18 ? .045 : .065;
    add(atNote, 1.4, pluck(hz(n)), level, step % 2 ? .35 : -.35);
    if (atNote + .45 < duration) add(atNote+.45, 1.4, pluck(hz(n)), level*.23, step % 2 ? -.6 : .6);
  }
}
for(const at of [3.6,7.2,12,18,25.2,32.4,39.6,43.2]) {
  add(at-.15,.26,(t,d)=>noise()*Math.sin(Math.PI*t/d)**2,.023,-.15);
  add(at,.18,pluck(hz(74)),.04,.3);
}
const peak = Math.max(...[left,right].map(a=>a.reduce((m,v)=>Math.max(m,Math.abs(v)),0)));
const out = Buffer.alloc(44 + length * 4);
out.write('RIFF'); out.writeUInt32LE(out.length-8,4); out.write('WAVEfmt ',8);
out.writeUInt32LE(16,16); out.writeUInt16LE(1,20); out.writeUInt16LE(2,22);
out.writeUInt32LE(rate,24); out.writeUInt32LE(rate*4,28); out.writeUInt16LE(4,32); out.writeUInt16LE(16,34);
out.write('data',36); out.writeUInt32LE(length*4,40);
for(let i=0;i<length;i++) {
  const t=i/rate, fade=Math.min(1,t/.08,(duration-t)/1.6);
  out.writeInt16LE(Math.round(left[i]/peak*.76*fade*32767),44+i*4);
  out.writeInt16LE(Math.round(right[i]/peak*.76*fade*32767),46+i*4);
}
mkdirSync('public',{recursive:true});
writeFileSync('public/score.wav',out);
console.log(`Original stereo score: ${duration}s, ${rate} Hz, peak -2.4 dBFS`);
