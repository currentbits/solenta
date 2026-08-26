/**
 * Renderer-side codecs for the bounded iOS simulator helper protocol (#248).
 * Limits come from native/ios-simulator-helper/protocol.json.
 */

import limitsJson from "../native/ios-simulator-helper/protocol.json" with { type: "json" };

export const limits = limitsJson;

export type VideoRecordType = "avcC" | "key" | "delta" | "jpeg";

export type VideoRecord = {
  type: VideoRecordType;
  flags: number;
  generation: number;
  sequence: number;
  timestampUs: bigint;
  width: number;
  height: number;
  payload: Uint8Array;
};

export type VideoRecordInput = {
  type: VideoRecordType;
  flags?: number;
  generation: number;
  sequence: number;
  timestampUs: bigint;
  width: number;
  height: number;
  payload: Uint8Array;
};

const HEADER_SIZE = 32;

const TYPE_TO_WIRE: Record<VideoRecordType, number> = {
  avcC: 1,
  key: 2,
  delta: 3,
  jpeg: 4,
};

const WIRE_TO_TYPE: Record<number, VideoRecordType> = {
  1: "avcC",
  2: "key",
  3: "delta",
  4: "jpeg",
};

const VIDEO_MAGIC = new TextEncoder().encode(limits.videoMagic);

export function protocolError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.name = "IOSSimulatorProtocolError";
  error.code = code;
  return error;
}

export function encodeControl(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.length > limits.maxControlBytes) throw protocolError("control_too_large");
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

export function createControlDecoder(
  onValue: (value: unknown) => void,
): (chunk: Uint8Array) => void {
  let buffered = new Uint8Array(0);
  return (chunk) => {
    const next = new Uint8Array(buffered.length + chunk.length);
    next.set(buffered, 0);
    next.set(chunk, buffered.length);
    buffered = next;

    while (buffered.length >= 4) {
      const length = new DataView(
        buffered.buffer,
        buffered.byteOffset,
        buffered.byteLength,
      ).getUint32(0);
      if (length > limits.maxControlBytes) throw protocolError("control_too_large");
      if (buffered.length < length + 4) return;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      onValue(JSON.parse(new TextDecoder().decode(body)));
    }
  };
}

export function encodeVideoRecord(record: VideoRecordInput): Uint8Array {
  const wireType = TYPE_TO_WIRE[record.type];
  if (wireType == null) throw protocolError("unknown_type");

  const payload = record.payload;
  if (payload.length > limits.maxVideoBytes) throw protocolError("video_too_large");

  const width = record.width >>> 0;
  const height = record.height >>> 0;
  if (width > 0xffff || height > 0xffff) {
    throw protocolError("zero_dimensions");
  }
  if (wireType !== 1 && (width === 0 || height === 0)) {
    throw protocolError("zero_dimensions");
  }

  const flags = (record.flags ?? 0) & 0xff;
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out.set(VIDEO_MAGIC, 0);
  view.setUint8(4, wireType);
  view.setUint8(5, flags);
  view.setUint16(6, 0);
  view.setUint32(8, record.generation >>> 0);
  view.setUint32(12, record.sequence >>> 0);
  view.setBigUint64(16, BigInt(record.timestampUs));
  view.setUint16(24, width);
  view.setUint16(26, height);
  view.setUint32(28, payload.length >>> 0);
  out.set(payload, HEADER_SIZE);
  return out;
}

export function decodeVideoRecord(buffer: Uint8Array): VideoRecord {
  if (buffer.length < HEADER_SIZE) throw protocolError("length_mismatch");

  if (
    buffer[0] !== VIDEO_MAGIC[0] ||
    buffer[1] !== VIDEO_MAGIC[1] ||
    buffer[2] !== VIDEO_MAGIC[2] ||
    buffer[3] !== VIDEO_MAGIC[3]
  ) {
    throw protocolError("bad_magic");
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const wireType = view.getUint8(4);
  const type = WIRE_TO_TYPE[wireType];
  if (type == null) throw protocolError("unknown_type");

  const flags = view.getUint8(5);
  if (view.getUint16(6) !== 0) throw protocolError("reserved_nonzero");

  const generation = view.getUint32(8);
  const sequence = view.getUint32(12);
  const timestampUs = view.getBigUint64(16);
  const width = view.getUint16(24);
  const height = view.getUint16(26);
  const payloadLength = view.getUint32(28);

  if (payloadLength > limits.maxVideoBytes) throw protocolError("video_too_large");
  if (buffer.length !== HEADER_SIZE + payloadLength) {
    throw protocolError("length_mismatch");
  }
  if (wireType !== 1 && (width === 0 || height === 0)) {
    throw protocolError("zero_dimensions");
  }

  return {
    type,
    flags,
    generation,
    sequence,
    timestampUs,
    width,
    height,
    payload: buffer.slice(HEADER_SIZE),
  };
}
