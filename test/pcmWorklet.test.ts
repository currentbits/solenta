/**
 * AudioWorklet downsample + PCM16 batching (#845).
 * Run: node --experimental-strip-types --test test/pcmWorklet.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FRAME_BYTES,
  TARGET_RATE,
  downsampleMono,
  floatToPcm16,
} from "../src/pcmWorklet.js";

describe("pcm worklet helpers", () => {
  it("downsamples 48 kHz mono to 16 kHz", () => {
    const src = new Float32Array(4800);
    for (let i = 0; i < src.length; i++) src[i] = i % 2 === 0 ? 0.5 : -0.5;
    const { samples, carry } = downsampleMono(src, 48000, TARGET_RATE, 0);
    assert.equal(samples.length, 1600);
    assert.ok(carry >= 0);
  });

  it("encodes little-endian PCM16 in 100 ms frames", () => {
    const samples = new Float32Array(1600);
    samples[0] = 1;
    samples[1] = -1;
    const pcm = floatToPcm16(samples);
    assert.equal(pcm.byteLength, FRAME_BYTES);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    assert.equal(view.getInt16(0, true), 0x7fff);
    assert.equal(view.getInt16(2, true), -0x8000);
  });
});
