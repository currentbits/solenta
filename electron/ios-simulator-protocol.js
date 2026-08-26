"use strict";

/**
 * Bounded control + video codecs for the iOS simulator helper (#248).
 * Limits come from native/ios-simulator-helper/protocol.json.
 */

const limits = require("../native/ios-simulator-helper/protocol.json");

const HEADER_SIZE = 32;
const VIDEO_MAGIC = Buffer.from(limits.videoMagic, "ascii");

const TYPE_TO_WIRE = Object.freeze({
  avcC: 1,
  key: 2,
  delta: 3,
  jpeg: 4,
});

const WIRE_TO_TYPE = Object.freeze({
  1: "avcC",
  2: "key",
  3: "delta",
  4: "jpeg",
});

/**
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function protocolError(code) {
  const error = new Error(code);
  error.name = "IOSSimulatorProtocolError";
  error.code = code;
  return error;
}

/**
 * @param {unknown} value
 * @returns {Buffer}
 */
function encodeControl(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > limits.maxControlBytes) throw protocolError("control_too_large");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/**
 * @param {(value: unknown) => void} onValue
 * @returns {(chunk: Buffer) => void}
 */
function createControlDecoder(onValue) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length > limits.maxControlBytes) throw protocolError("control_too_large");
      if (buffered.length < length + 4) return;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      onValue(JSON.parse(body.toString("utf8")));
    }
  };
}

/**
 * @param {{
 *   type: "avcC" | "key" | "delta" | "jpeg",
 *   flags?: number,
 *   generation: number,
 *   sequence: number,
 *   timestampUs: bigint,
 *   width: number,
 *   height: number,
 *   payload: Buffer,
 * }} record
 * @returns {Buffer}
 */
function encodeVideoRecord(record) {
  const wireType = TYPE_TO_WIRE[record.type];
  if (wireType == null) throw protocolError("unknown_type");

  const payload = record.payload;
  if (!Buffer.isBuffer(payload)) throw protocolError("length_mismatch");
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
  const out = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  VIDEO_MAGIC.copy(out, 0);
  out.writeUInt8(wireType, 4);
  out.writeUInt8(flags, 5);
  out.writeUInt16BE(0, 6);
  out.writeUInt32BE(record.generation >>> 0, 8);
  out.writeUInt32BE(record.sequence >>> 0, 12);
  out.writeBigUInt64BE(BigInt(record.timestampUs), 16);
  out.writeUInt16BE(width, 24);
  out.writeUInt16BE(height, 26);
  out.writeUInt32BE(payload.length >>> 0, 28);
  payload.copy(out, HEADER_SIZE);
  return out;
}

/**
 * @param {Buffer} buffer
 * @returns {{
 *   type: "avcC" | "key" | "delta" | "jpeg",
 *   flags: number,
 *   generation: number,
 *   sequence: number,
 *   timestampUs: bigint,
 *   width: number,
 *   height: number,
 *   payload: Buffer,
 * }}
 */
function decodeVideoRecord(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_SIZE) {
    throw protocolError("length_mismatch");
  }
  if (
    buffer[0] !== VIDEO_MAGIC[0] ||
    buffer[1] !== VIDEO_MAGIC[1] ||
    buffer[2] !== VIDEO_MAGIC[2] ||
    buffer[3] !== VIDEO_MAGIC[3]
  ) {
    throw protocolError("bad_magic");
  }

  const wireType = buffer.readUInt8(4);
  const type = WIRE_TO_TYPE[wireType];
  if (type == null) throw protocolError("unknown_type");

  const flags = buffer.readUInt8(5);
  if (buffer.readUInt16BE(6) !== 0) throw protocolError("reserved_nonzero");

  const generation = buffer.readUInt32BE(8);
  const sequence = buffer.readUInt32BE(12);
  const timestampUs = buffer.readBigUInt64BE(16);
  const width = buffer.readUInt16BE(24);
  const height = buffer.readUInt16BE(26);
  const payloadLength = buffer.readUInt32BE(28);

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
    payload: Buffer.from(buffer.subarray(HEADER_SIZE)),
  };
}

module.exports = {
  limits,
  protocolError,
  encodeControl,
  createControlDecoder,
  encodeVideoRecord,
  decodeVideoRecord,
};
