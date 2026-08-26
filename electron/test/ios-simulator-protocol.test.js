"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  limits,
  encodeControl,
  createControlDecoder,
  encodeVideoRecord,
  decodeVideoRecord,
  protocolError,
} = require("../ios-simulator-protocol.js");

describe("ios-simulator-protocol limits", () => {
  it("exposes protocol.json as the single source", () => {
    assert.equal(limits.version, 1);
    assert.equal(limits.maxControlBytes, 65536);
    assert.equal(limits.maxVideoBytes, 4194304);
    assert.equal(limits.dropViewerBytes, 8388608);
    assert.equal(limits.recoverViewerBytes, 2097152);
    assert.equal(limits.videoMagic, "SLV1");
  });
});

describe("control framing", () => {
  it("round-trips request/response IDs through encode/decode", () => {
    const values = [];
    const decode = createControlDecoder((v) => values.push(v));
    const req = { id: 7, method: "tap", x: 1.5, y: 2.5 };
    const res = { id: 7, ok: true, result: { accepted: true } };
    decode(encodeControl(req));
    decode(encodeControl(res));
    assert.deepEqual(values, [req, res]);
  });

  it("decodes fragmented frames across chunk boundaries", () => {
    const values = [];
    const decode = createControlDecoder((v) => values.push(v));
    const frame = encodeControl({ id: 1, method: "ping" });
    decode(frame.subarray(0, 2));
    decode(frame.subarray(2, 6));
    decode(frame.subarray(6));
    assert.deepEqual(values, [{ id: 1, method: "ping" }]);
  });

  it("decodes coalesced frames in one chunk", () => {
    const values = [];
    const decode = createControlDecoder((v) => values.push(v));
    const a = encodeControl({ id: 1 });
    const b = encodeControl({ id: 2 });
    decode(Buffer.concat([a, b]));
    assert.deepEqual(values, [{ id: 1 }, { id: 2 }]);
  });

  it("accepts an exact 64 KiB control body", () => {
    // Build a JSON body of length exactly maxControlBytes: {"d":"aaa..."}.
    const overhead = Buffer.byteLength('{"d":""}', "utf8");
    const exactValue = { d: "a".repeat(limits.maxControlBytes - overhead) };
    const encoded = encodeControl(exactValue);
    assert.equal(encoded.readUInt32BE(0), limits.maxControlBytes);

    const values = [];
    createControlDecoder((v) => values.push(v))(encoded);
    assert.deepEqual(values, [exactValue]);
  });

  it("rejects encode over the control limit", () => {
    const overhead = Buffer.byteLength('{"d":""}', "utf8");
    const value = { d: "a".repeat(limits.maxControlBytes - overhead + 1) };
    assert.throws(() => encodeControl(value), (err) => {
      assert.equal(err.name, "IOSSimulatorProtocolError");
      assert.equal(err.code, "control_too_large");
      return true;
    });
  });

  it("throws on over-limit length prefix before body arrives", () => {
    const decode = createControlDecoder(() => {
      assert.fail("should not emit");
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(limits.maxControlBytes + 1, 0);
    assert.throws(() => decode(header), (err) => {
      assert.equal(err.name, "IOSSimulatorProtocolError");
      assert.equal(err.code, "control_too_large");
      return true;
    });
  });

  it("rejects invalid JSON bodies", () => {
    const decode = createControlDecoder(() => {
      assert.fail("should not emit");
    });
    const body = Buffer.from("{not-json", "utf8");
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    assert.throws(() => decode(frame), SyntaxError);
  });

  it("protocolError builds IOSSimulatorProtocolError", () => {
    const err = protocolError("control_too_large");
    assert.equal(err.name, "IOSSimulatorProtocolError");
    assert.equal(err.code, "control_too_large");
    assert.equal(err.message, "control_too_large");
  });
});

describe("video envelope", () => {
  it("round-trips a keyframe record", () => {
    const record = encodeVideoRecord({
      type: "key",
      generation: 3,
      sequence: 9,
      timestampUs: 42n,
      width: 1179,
      height: 2556,
      payload: Buffer.from([1, 2, 3]),
    });
    assert.deepEqual(decodeVideoRecord(record), {
      type: "key",
      flags: 0,
      generation: 3,
      sequence: 9,
      timestampUs: 42n,
      width: 1179,
      height: 2556,
      payload: Buffer.from([1, 2, 3]),
    });
  });

  it("round-trips avcC, delta, and jpeg with flags", () => {
    for (const type of ["avcC", "delta", "jpeg"]) {
      const encoded = encodeVideoRecord({
        type,
        flags: type === "delta" ? 1 : 0,
        generation: 1,
        sequence: 2,
        timestampUs: 99n,
        width: type === "avcC" ? 0 : 100,
        height: type === "avcC" ? 0 : 200,
        payload: Buffer.from([9, 8, 7]),
      });
      const decoded = decodeVideoRecord(encoded);
      assert.equal(decoded.type, type);
      assert.equal(decoded.flags, type === "delta" ? 1 : 0);
      assert.deepEqual(decoded.payload, Buffer.from([9, 8, 7]));
    }
  });

  it("writes the SLV1 magic and 32-byte header layout", () => {
    const payload = Buffer.from([0xaa]);
    const record = encodeVideoRecord({
      type: "key",
      generation: 0x11223344,
      sequence: 0x55667788,
      timestampUs: 0x0102030405060708n,
      width: 1179,
      height: 2556,
      payload,
    });
    assert.equal(record.toString("ascii", 0, 4), "SLV1");
    assert.equal(record.readUInt8(4), 2); // keyframe
    assert.equal(record.readUInt8(5), 0);
    assert.equal(record.readUInt16BE(6), 0);
    assert.equal(record.readUInt32BE(8), 0x11223344);
    assert.equal(record.readUInt32BE(12), 0x55667788);
    assert.equal(record.readBigUInt64BE(16), 0x0102030405060708n);
    assert.equal(record.readUInt16BE(24), 1179);
    assert.equal(record.readUInt16BE(26), 2556);
    assert.equal(record.readUInt32BE(28), 1);
    assert.deepEqual(record.subarray(32), payload);
  });

  it("rejects bad magic", () => {
    const record = encodeVideoRecord({
      type: "key",
      generation: 1,
      sequence: 1,
      timestampUs: 1n,
      width: 10,
      height: 10,
      payload: Buffer.from([1]),
    });
    record.write("XXXX", 0, 4, "ascii");
    assert.throws(() => decodeVideoRecord(record), (err) => {
      assert.equal(err.code, "bad_magic");
      return true;
    });
  });

  it("rejects unknown type", () => {
    const record = encodeVideoRecord({
      type: "key",
      generation: 1,
      sequence: 1,
      timestampUs: 1n,
      width: 10,
      height: 10,
      payload: Buffer.from([1]),
    });
    record.writeUInt8(99, 4);
    assert.throws(() => decodeVideoRecord(record), (err) => {
      assert.equal(err.code, "unknown_type");
      return true;
    });
  });

  it("rejects nonzero reserved bytes", () => {
    const record = encodeVideoRecord({
      type: "key",
      generation: 1,
      sequence: 1,
      timestampUs: 1n,
      width: 10,
      height: 10,
      payload: Buffer.from([1]),
    });
    record.writeUInt8(1, 6);
    assert.throws(() => decodeVideoRecord(record), (err) => {
      assert.equal(err.code, "reserved_nonzero");
      return true;
    });
  });

  it("rejects length mismatch", () => {
    const record = encodeVideoRecord({
      type: "key",
      generation: 1,
      sequence: 1,
      timestampUs: 1n,
      width: 10,
      height: 10,
      payload: Buffer.from([1, 2, 3]),
    });
    assert.throws(() => decodeVideoRecord(record.subarray(0, record.length - 1)), (err) => {
      assert.equal(err.code, "length_mismatch");
      return true;
    });
  });

  it("rejects zero dimensions on frame records", () => {
    for (const type of ["key", "delta", "jpeg"]) {
      assert.throws(
        () =>
          encodeVideoRecord({
            type,
            generation: 1,
            sequence: 1,
            timestampUs: 1n,
            width: 0,
            height: 10,
            payload: Buffer.from([1]),
          }),
        (err) => {
          assert.equal(err.code, "zero_dimensions");
          return true;
        },
      );
    }
  });

  it("rejects uint16-overflow dimensions on keyframes", () => {
    assert.throws(
      () =>
        encodeVideoRecord({
          type: "key",
          generation: 1,
          sequence: 1,
          timestampUs: 1n,
          width: 65536,
          height: 2556,
          payload: Buffer.from([1]),
        }),
      (err) => {
        assert.equal(err.code, "zero_dimensions");
        return true;
      },
    );
  });

  it("rejects payload over 4 MiB", () => {
    const payload = Buffer.alloc(limits.maxVideoBytes + 1);
    assert.throws(
      () =>
        encodeVideoRecord({
          type: "key",
          generation: 1,
          sequence: 1,
          timestampUs: 1n,
          width: 10,
          height: 10,
          payload,
        }),
      (err) => {
        assert.equal(err.code, "video_too_large");
        return true;
      },
    );
  });

  it("accepts payload at exactly maxVideoBytes", () => {
    const payload = Buffer.alloc(limits.maxVideoBytes, 7);
    const record = encodeVideoRecord({
      type: "delta",
      generation: 1,
      sequence: 1,
      timestampUs: 1n,
      width: 10,
      height: 10,
      payload,
    });
    const decoded = decodeVideoRecord(record);
    assert.equal(decoded.payload.length, limits.maxVideoBytes);
  });
});
