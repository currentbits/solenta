import pcmWorkletUrl from "./pcmWorklet.js?url";

export type SpeechCapture = {
  flushAndStop(): Promise<void>;
  close(): void;
};

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already ended
    }
  }
}

/** Mic → 16 kHz PCM16 worklet. Always close tracks, nodes, and context. */
export async function startSpeechCapture(opts: {
  write: (pcm: ArrayBuffer, seq: number) => void | Promise<void>;
}): Promise<SpeechCapture> {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) {
    throw new Error("Microphone is not available.");
  }
  const stream = await devices.getUserMedia({ audio: true });
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) {
    stopTracks(stream);
    throw new Error("Audio capture is not available.");
  }
  const ctx = new AC();
  const workletUrl = pcmWorkletUrl;
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    stopTracks(stream);
    await ctx.close().catch(() => {});
    throw err;
  }
  const NodeCtor = window.AudioWorkletNode;
  if (!NodeCtor) {
    stopTracks(stream);
    await ctx.close().catch(() => {});
    throw new Error("Audio capture is not available.");
  }
  const node = new NodeCtor(ctx, "pcm-capture");
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(node);
  node.connect(gain);
  gain.connect(ctx.destination);

  let writeChain = Promise.resolve();
  let flushed: (() => void) | null = null;
  let closed = false;

  node.port.onmessage = (ev: MessageEvent) => {
    const data = ev.data as {
      pcm?: ArrayBuffer;
      seq?: number;
      type?: string;
    };
    if (data?.pcm != null && typeof data.seq === "number") {
      const pcm = data.pcm;
      const seq = data.seq;
      writeChain = writeChain.then(() =>
        Promise.resolve(opts.write(pcm, seq)),
      );
    }
    if (data?.type === "flushed") flushed?.();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    node.port.onmessage = null;
    try {
      node.disconnect();
    } catch {
      // already disconnected
    }
    try {
      source.disconnect();
    } catch {
      // already disconnected
    }
    try {
      gain.disconnect();
    } catch {
      // already disconnected
    }
    stopTracks(stream);
    void ctx.close().catch(() => {});
  };

  return {
    async flushAndStop() {
      if (closed) return;
      const done = new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 250);
        flushed = () => {
          window.clearTimeout(timer);
          resolve();
        };
      });
      node.port.postMessage({ type: "flush" });
      await done;
      await writeChain.catch(() => {});
      close();
    },
    close,
  };
}

export function speechCaptureError(err: unknown): string {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  if (name === "NotAllowedError") return "Microphone permission denied.";
  if (name === "NotFoundError") return "No input device.";
  if (err instanceof Error && err.message) return err.message;
  return "Could not start dictation.";
}
