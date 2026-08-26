/**
 * Renderer codec for the bounded simulator helper protocol.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorProtocol.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  limits,
  encodeControl,
  createControlDecoder,
  encodeVideoRecord,
  decodeVideoRecord,
  protocolError,
} from "../src/simulatorProtocol.ts";

describe("simulatorProtocol limits", () => {
  it("imports protocol.json as the single source", () => {
    assert.equal(limits.version, 1);
    assert.equal(limits.maxControlBytes, 65536);
    assert.equal(limits.maxVideoBytes, 4194304);
    assert.equal(limits.dropViewerBytes, 8388608);
    assert.equal(limits.recoverViewerBytes, 2097152);
    assert.equal(limits.videoMagic, "SLV1");
  });
});

describe("control framing (renderer)", () => {
  it("round-trips request/response IDs", () => {
    const values: unknown[] = [];
    const decode = createControlDecoder((v) => values.push(v));
    const req = { id: 3, method: "pressButton", button: "home" };
    const res = { id: 3, ok: true };
    decode(encodeControl(req));
    decode(encodeControl(res));
    assert.deepEqual(values, [req, res]);
  });

  it("decodes fragmented and coalesced frames", () => {
    const values: unknown[] = [];
    const decode = createControlDecoder((v) => values.push(v));
    const a = encodeControl({ id: 1 });
    const b = encodeControl({ id: 2 });
    decode(a.subarray(0, 3));
    decode(a.subarray(3));
    decode(b);
    assert.deepEqual(values, [{ id: 1 }, { id: 2 }]);
  });

  it("accepts exact 64 KiB bodies and rejects over-limit", () => {
    const overhead = new TextEncoder().encode('{"d":""}').byteLength;
    const exact = { d: "a".repeat(limits.maxControlBytes - overhead) };
    const encoded = encodeControl(exact);
    assert.equal(new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0), limits.maxControlBytes);

    const values: unknown[] = [];
    createControlDecoder((v) => values.push(v))(encoded);
    assert.deepEqual(values, [exact]);

    const over = { d: "a".repeat(limits.maxControlBytes - overhead + 1) };
    assert.throws(() => encodeControl(over), (err: Error & { code?: string }) => {
      assert.equal(err.name, "IOSSimulatorProtocolError");
      assert.equal(err.code, "control_too_large");
      return true;
    });
  });

  it("throws on over-limit length prefix", () => {
    const decode = createControlDecoder(() => {
      assert.fail("should not emit");
    });
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, limits.maxControlBytes + 1);
    assert.throws(() => decode(header), (err: Error & { code?: string }) => {
      assert.equal(err.code, "control_too_large");
      return true;
    });
  });

  it("rejects invalid JSON", () => {
    const decode = createControlDecoder(() => {
      assert.fail("should not emit");
    });
    const body = new TextEncoder().encode("{bad");
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length);
    frame.set(body, 4);
    assert.throws(() => decode(frame), SyntaxError);
  });
});

describe("video envelope (renderer)", () => {
  it("round-trips a keyframe via DataView", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const record = encodeVideoRecord({
      type: "key",
      generation: 3,
      sequence: 9,
      timestampUs: 42n,
      width: 1179,
      height: 2556,
      payload,
    });
    assert.deepEqual(decodeVideoRecord(record), {
      type: "key",
      flags: 0,
      generation: 3,
      sequence: 9,
      timestampUs: 42n,
      width: 1179,
      height: 2556,
      payload,
    });
  });

  it("returns avcC description bytes and AVCC samples unchanged", () => {
    const description = new Uint8Array([0x01, 0x64, 0x00, 0x1e]);
    const avcC = decodeVideoRecord(
      encodeVideoRecord({
        type: "avcC",
        generation: 1,
        sequence: 0,
        timestampUs: 0n,
        width: 0,
        height: 0,
        payload: description,
      }),
    );
    assert.equal(avcC.type, "avcC");
    assert.deepEqual(avcC.payload, description);

    const sample = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
    const key = decodeVideoRecord(
      encodeVideoRecord({
        type: "key",
        generation: 1,
        sequence: 1,
        timestampUs: 1000n,
        width: 100,
        height: 200,
        payload: sample,
      }),
    );
    assert.equal(key.type, "key");
    assert.deepEqual(key.payload, sample);
  });

  it("rejects bad magic, unknown type, reserved, length mismatch, zero dims, oversized", () => {
    const base = encodeVideoRecord({
      type: "key",
      generation: 1,
      sequence: 1,
      timestampUs: 1n,
      width: 10,
      height: 10,
      payload: new Uint8Array([1]),
    });

    const badMagic = new Uint8Array(base);
    badMagic[0] = 0x00;
    assert.throws(() => decodeVideoRecord(badMagic), (err: Error & { code?: string }) => {
      assert.equal(err.code, "bad_magic");
      return true;
    });

    const unknown = new Uint8Array(base);
    unknown[4] = 50;
    assert.throws(() => decodeVideoRecord(unknown), (err: Error & { code?: string }) => {
      assert.equal(err.code, "unknown_type");
      return true;
    });

    const reserved = new Uint8Array(base);
    reserved[7] = 1;
    assert.throws(() => decodeVideoRecord(reserved), (err: Error & { code?: string }) => {
      assert.equal(err.code, "reserved_nonzero");
      return true;
    });

    assert.throws(() => decodeVideoRecord(base.subarray(0, base.length - 1)), (err: Error & { code?: string }) => {
      assert.equal(err.code, "length_mismatch");
      return true;
    });

    assert.throws(
      () =>
        encodeVideoRecord({
          type: "jpeg",
          generation: 1,
          sequence: 1,
          timestampUs: 1n,
          width: 0,
          height: 0,
          payload: new Uint8Array([1]),
        }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "zero_dimensions");
        return true;
      },
    );

    assert.throws(
      () =>
        encodeVideoRecord({
          type: "key",
          generation: 1,
          sequence: 1,
          timestampUs: 1n,
          width: 65536,
          height: 2556,
          payload: new Uint8Array([1]),
        }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "zero_dimensions");
        return true;
      },
    );

    assert.throws(
      () =>
        encodeVideoRecord({
          type: "key",
          generation: 1,
          sequence: 1,
          timestampUs: 1n,
          width: 10,
          height: 10,
          payload: new Uint8Array(limits.maxVideoBytes + 1),
        }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "video_too_large");
        return true;
      },
    );
  });

  it("protocolError builds IOSSimulatorProtocolError", () => {
    const err = protocolError("bad_magic");
    assert.equal(err.name, "IOSSimulatorProtocolError");
    assert.equal(err.code, "bad_magic");
  });
});
