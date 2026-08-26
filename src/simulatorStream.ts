/**
 * Loopback WebSocket viewer: authenticate, decode SLV1, paint WebCodecs frames.
 */

import { decodeVideoRecord, type VideoRecord } from "./simulatorProtocol";
import type { SimulatorStreamInfo } from "./shared/ipc";

export type SimulatorStreamStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type SimulatorStreamHandle = {
  disconnect: () => void;
};

export type SimulatorStreamOptions = {
  info: SimulatorStreamInfo;
  canvas: HTMLCanvasElement;
  onDimensions: (size: { width: number; height: number }) => void;
  onStatus?: (status: SimulatorStreamStatus) => void;
  onError?: (err: Error) => void;
  WebSocket?: typeof WebSocket;
  VideoDecoder?: typeof VideoDecoder;
  EncodedVideoChunk?: typeof EncodedVideoChunk;
  createImageBitmap?: typeof createImageBitmap;
};

type SocketLike = {
  binaryType: string;
  send: (data: string) => void;
  close: () => void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
};

export function connectSimulatorStream(
  opts: SimulatorStreamOptions,
): SimulatorStreamHandle {
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  const VD = opts.VideoDecoder ?? globalThis.VideoDecoder;
  const Chunk = opts.EncodedVideoChunk ?? globalThis.EncodedVideoChunk;
  const makeBitmap = opts.createImageBitmap ?? globalThis.createImageBitmap;

  let closed = false;
  let decoder: VideoDecoder | null = null;
  const ws = new WS(opts.info.url) as unknown as SocketLike;
  ws.binaryType = "arraybuffer";
  opts.onStatus?.("connecting");

  const resetDecoder = () => {
    if (!decoder) return;
    try {
      decoder.close();
    } catch {
      // already closed
    }
    decoder = null;
  };

  const disconnect = () => {
    if (closed) return;
    closed = true;
    resetDecoder();
    try {
      ws.close();
    } catch {
      // ignore
    }
    opts.onStatus?.("disconnected");
  };

  const handleAvcC = (record: VideoRecord) => {
    if (!VD) {
      opts.onError?.(new Error("WebCodecs VideoDecoder is unavailable"));
      return;
    }
    resetDecoder();
    decoder = new VD({
      output: (frame) => {
        try {
          const context = opts.canvas.getContext("2d");
          if (!context) return;
          opts.canvas.width = frame.displayWidth;
          opts.canvas.height = frame.displayHeight;
          context.drawImage(frame, 0, 0);
          opts.onDimensions({
            width: frame.displayWidth,
            height: frame.displayHeight,
          });
        } finally {
          frame.close();
        }
      },
      error: (err) => {
        opts.onError?.(err);
      },
    });
    decoder.configure({
      codec: codecFromAvcC(record.payload),
      description: record.payload,
      optimizeForLatency: true,
    });
  };

  const handleSample = (record: VideoRecord) => {
    if (!decoder || !Chunk) return;
    decoder.decode(
      new Chunk({
        type: record.type === "key" ? "key" : "delta",
        timestamp: Number(record.timestampUs),
        data: record.payload,
      }),
    );
  };

  const handleJpeg = async (record: VideoRecord) => {
    if (!makeBitmap) return;
    const blob = new Blob([record.payload as BlobPart], { type: "image/jpeg" });
    const image = await makeBitmap(blob);
    if (closed) {
      image.close();
      return;
    }
    const context = opts.canvas.getContext("2d");
    if (!context) {
      image.close();
      return;
    }
    opts.canvas.width = image.width;
    opts.canvas.height = image.height;
    context.drawImage(image, 0, 0);
    opts.onDimensions({ width: image.width, height: image.height });
    image.close();
  };

  const onOpen = () => {
    if (closed) return;
    ws.send(
      JSON.stringify({
        token: opts.info.token,
        generation: opts.info.generation,
      }),
    );
    opts.onStatus?.("connected");
  };

  const onMessage = (ev: { data: unknown }) => {
    if (closed) return;
    const data = ev.data;
    if (typeof data === "string") return;
    let record: VideoRecord;
    try {
      record = decodeVideoRecord(toUint8Array(data));
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (record.generation !== opts.info.generation) return;
    if (record.type === "avcC") {
      handleAvcC(record);
      return;
    }
    if (record.type === "jpeg") {
      void handleJpeg(record).catch((err) => {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
      return;
    }
    handleSample(record);
  };

  const onClose = () => {
    resetDecoder();
    if (!closed) opts.onStatus?.("disconnected");
  };

  ws.onopen = onOpen;
  ws.onmessage = onMessage;
  ws.onclose = onClose;
  ws.onerror = () => {
    if (!closed) opts.onError?.(new Error("Simulator stream error"));
  };

  return { disconnect };
}

export function codecFromAvcC(description: Uint8Array): string {
  if (description.length < 4) return "avc1.640028";
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(description[1]!)}${hex(description[2]!)}${hex(description[3]!)}`;
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("unsupported_stream_payload");
}
