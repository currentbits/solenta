/** 16 kHz mono PCM16 in ~100 ms batches. No model or network in this file. */

export const TARGET_RATE = 16000;
export const FRAME_SAMPLES = 1600;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

export function downsampleMono(input, srcRate, targetRate, pos) {
  if (srcRate === targetRate) {
    return { samples: Array.from(input), carry: 0 };
  }
  const ratio = srcRate / targetRate;
  const out = [];
  let p = pos;
  while (p < input.length) {
    const i = Math.floor(p);
    const frac = p - i;
    const a = input[i] ?? 0;
    const b = i + 1 < input.length ? input[i + 1] : a;
    out.push(a + (b - a) * frac);
    p += ratio;
  }
  return { samples: out, carry: p - input.length };
}

export function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

const ProcessorBase =
  typeof AudioWorkletProcessor !== "undefined"
    ? AudioWorkletProcessor
    : class {};

class PcmCaptureProcessor extends ProcessorBase {
  constructor() {
    super();
    this.pending = [];
    this.pos = 0;
    this.seq = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "flush") this.flush();
    };
  }

  process(inputs) {
    const ch0 = inputs[0] && inputs[0][0];
    if (ch0 && ch0.length) {
      const srcRate =
        typeof sampleRate === "number" ? sampleRate : TARGET_RATE;
      const { samples, carry } = downsampleMono(
        ch0,
        srcRate,
        TARGET_RATE,
        this.pos,
      );
      this.pos = carry;
      for (let i = 0; i < samples.length; i++) this.pending.push(samples[i]);
      while (this.pending.length >= FRAME_SAMPLES) {
        this.emit(this.pending.splice(0, FRAME_SAMPLES));
      }
    }
    return true;
  }

  emit(frame) {
    const pcm = floatToPcm16(frame);
    this.port.postMessage({ pcm: pcm.buffer, seq: this.seq++ }, [pcm.buffer]);
  }

  flush() {
    if (this.pending.length) {
      this.emit(this.pending);
      this.pending = [];
    }
    this.port.postMessage({ type: "flushed" });
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("pcm-capture", PcmCaptureProcessor);
}
