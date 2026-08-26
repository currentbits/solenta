/**
 * WebCodecs SLV1 viewer for the iOS Simulator pane.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorStream.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { encodeVideoRecord } from "../src/simulatorProtocol.ts";
import { connectSimulatorStream } from "../src/simulatorStream.ts";
import type { SimulatorStreamInfo } from "../src/shared/ipc";

const INFO: SimulatorStreamInfo = {
  url: "ws://127.0.0.1:9/sim",
  token: "viewer-token",
  generation: 3,
  protocolVersion: 1,
  maxMessageBytes: 4194304,
};

type FakeFrame = {
  displayWidth: number;
  displayHeight: number;
  close: () => void;
  closed: number;
};

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  output: (frame: FakeFrame) => void;
  error: (err: Error) => void;
  configureCalls: unknown[] = [];
  decodeCalls: unknown[] = [];
  closeCalls = 0;
  constructor(init: {
    output: (frame: FakeFrame) => void;
    error: (err: Error) => void;
  }) {
    this.output = init.output;
    this.error = init.error;
    FakeVideoDecoder.instances.push(this);
  }
  configure(config: unknown) {
    this.configureCalls.push(config);
  }
  decode(chunk: unknown) {
    this.decodeCalls.push(chunk);
  }
  close() {
    this.closeCalls += 1;
  }
}

class FakeEncodedVideoChunk {
  type: string;
  timestamp: number;
  data: BufferSource;
  constructor(init: { type: string; timestamp: number; data: BufferSource }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  binaryType = "blob";
  sent: unknown[] = [];
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  emitBinary(bytes: Uint8Array) {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }
}

function fakeCanvas() {
  const calls: unknown[][] = [];
  const ctx = {
    drawImage: (...args: unknown[]) => {
      calls.push(args);
    },
    calls,
  };
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    ctx,
  };
}

function record(
  type: "avcC" | "key" | "delta" | "jpeg",
  over: {
    generation?: number;
    sequence?: number;
    timestampUs?: bigint;
    width?: number;
    height?: number;
    payload?: Uint8Array;
  } = {},
) {
  return encodeVideoRecord({
    type,
    generation: over.generation ?? 3,
    sequence: over.sequence ?? 1,
    timestampUs: over.timestampUs ?? 42n,
    width: over.width ?? (type === "avcC" ? 0 : 1179),
    height: over.height ?? (type === "avcC" ? 0 : 2556),
    payload: over.payload ?? new Uint8Array([1, 2, 3, 4]),
  });
}

afterEach(() => {
  FakeVideoDecoder.instances = [];
  FakeSocket.instances = [];
});

describe("connectSimulatorStream", () => {
  it("authenticates with the first text { token, generation } then decodes SLV1", async () => {
    const canvas = fakeCanvas();
    const sizes: Array<{ width: number; height: number }> = [];
    connectSimulatorStream({
      info: INFO,
      canvas: canvas as unknown as HTMLCanvasElement,
      onDimensions: (size) => sizes.push(size),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      VideoDecoder: FakeVideoDecoder as unknown as typeof VideoDecoder,
      EncodedVideoChunk: FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
    });
    const ws = FakeSocket.instances[0]!;
    assert.equal(ws.url, INFO.url);
    ws.emitOpen();
    assert.deepEqual(ws.sent, [
      JSON.stringify({ token: "viewer-token", generation: 3 }),
    ]);
    assert.equal(ws.binaryType, "arraybuffer");

    const avcC = new Uint8Array([1, 0x64, 0x00, 0x28, 9, 10]);
    ws.emitBinary(record("avcC", { payload: avcC }));
    const decoder = FakeVideoDecoder.instances[0]!;
    assert.equal(FakeVideoDecoder.instances.length, 1);
    assert.equal(decoder.configureCalls.length, 1);
    const config = decoder.configureCalls[0] as {
      codec: string;
      description: Uint8Array;
    };
    assert.equal(config.codec, "avc1.640028");
    assert.deepEqual(Array.from(config.description), Array.from(avcC));

    ws.emitBinary(record("key", { timestampUs: 100n, sequence: 2 }));
    ws.emitBinary(record("delta", { timestampUs: 200n, sequence: 3 }));
    assert.equal(decoder.decodeCalls.length, 2);
    const key = decoder.decodeCalls[0] as FakeEncodedVideoChunk;
    const delta = decoder.decodeCalls[1] as FakeEncodedVideoChunk;
    assert.equal(key.type, "key");
    assert.equal(key.timestamp, 100);
    assert.equal(delta.type, "delta");
    assert.equal(delta.timestamp, 200);

    const frame: FakeFrame = {
      displayWidth: 1179,
      displayHeight: 2556,
      closed: 0,
      close() {
        this.closed += 1;
      },
    };
    decoder.output(frame);
    assert.equal(canvas.width, 1179);
    assert.equal(canvas.height, 2556);
    assert.equal(canvas.ctx.calls.length, 1);
    assert.deepEqual(sizes, [{ width: 1179, height: 2556 }]);
    assert.equal(frame.closed, 1);
  });

  it("closes the VideoFrame in finally when drawImage throws", () => {
    const canvas = fakeCanvas();
    canvas.ctx.drawImage = () => {
      throw new Error("draw failed");
    };
    connectSimulatorStream({
      info: INFO,
      canvas: canvas as unknown as HTMLCanvasElement,
      onDimensions: () => {},
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      VideoDecoder: FakeVideoDecoder as unknown as typeof VideoDecoder,
      EncodedVideoChunk: FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
    });
    FakeSocket.instances[0]!.emitOpen();
    FakeSocket.instances[0]!.emitBinary(record("avcC"));
    const frame: FakeFrame = {
      displayWidth: 10,
      displayHeight: 20,
      closed: 0,
      close() {
        this.closed += 1;
      },
    };
    assert.throws(() => FakeVideoDecoder.instances[0]!.output(frame));
    assert.equal(frame.closed, 1);
  });

  it("recreates the decoder on a later avcC", () => {
    const canvas = fakeCanvas();
    connectSimulatorStream({
      info: INFO,
      canvas: canvas as unknown as HTMLCanvasElement,
      onDimensions: () => {},
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      VideoDecoder: FakeVideoDecoder as unknown as typeof VideoDecoder,
      EncodedVideoChunk: FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
    });
    const ws = FakeSocket.instances[0]!;
    ws.emitOpen();
    ws.emitBinary(record("avcC"));
    const first = FakeVideoDecoder.instances[0]!;
    ws.emitBinary(record("avcC", { sequence: 9 }));
    assert.equal(first.closeCalls, 1);
    assert.equal(FakeVideoDecoder.instances.length, 2);
    assert.equal(FakeVideoDecoder.instances[1]!.configureCalls.length, 1);
  });

  it("paints a JPEG seed via createImageBitmap", async () => {
    const canvas = fakeCanvas();
    const sizes: Array<{ width: number; height: number }> = [];
    const bitmaps: Array<{ closed: number }> = [];
    connectSimulatorStream({
      info: INFO,
      canvas: canvas as unknown as HTMLCanvasElement,
      onDimensions: (size) => sizes.push(size),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      VideoDecoder: FakeVideoDecoder as unknown as typeof VideoDecoder,
      EncodedVideoChunk: FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
      createImageBitmap: async () => {
        const bmp = {
          width: 80,
          height: 160,
          closed: 0,
          close() {
            this.closed += 1;
          },
        };
        bitmaps.push(bmp);
        return bmp as unknown as ImageBitmap;
      },
    });
    const ws = FakeSocket.instances[0]!;
    ws.emitOpen();
    ws.emitBinary(record("jpeg", { width: 80, height: 160 }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(canvas.width, 80);
    assert.equal(canvas.height, 160);
    assert.deepEqual(sizes, [{ width: 80, height: 160 }]);
    assert.equal(canvas.ctx.calls.length, 1);
    assert.equal(bitmaps[0]!.closed, 1);
  });

  it("resets the decoder on disconnect", () => {
    const canvas = fakeCanvas();
    const statuses: string[] = [];
    const handle = connectSimulatorStream({
      info: INFO,
      canvas: canvas as unknown as HTMLCanvasElement,
      onDimensions: () => {},
      onStatus: (status) => statuses.push(status),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      VideoDecoder: FakeVideoDecoder as unknown as typeof VideoDecoder,
      EncodedVideoChunk: FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
    });
    const ws = FakeSocket.instances[0]!;
    ws.emitOpen();
    ws.emitBinary(record("avcC"));
    const decoder = FakeVideoDecoder.instances[0]!;
    handle.disconnect();
    assert.equal(decoder.closeCalls, 1);
    ws.emitBinary(record("key"));
    assert.equal(decoder.decodeCalls.length, 0);
    assert.ok(statuses.includes("disconnected"));
  });
});
