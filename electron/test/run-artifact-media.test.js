"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { probeRunArtifact } = require("../run-artifact-media.js");

function box(type, body) {
  const buf = Buffer.alloc(8 + body.length);
  buf.writeUInt32BE(8 + body.length, 0);
  buf.write(type, 4, 4);
  body.copy(buf, 8);
  return buf;
}

function extendedBox(type, body) {
  const total = 16 + body.length;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(1, 0);
  buf.write(type, 4, 4);
  const hi = Math.floor(total / 0x100000000);
  const lo = total % 0x100000000;
  buf.writeUInt32BE(hi, 8);
  buf.writeUInt32BE(lo, 12);
  body.copy(buf, 16);
  return buf;
}

function terminalBox(type) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.write(type, 4, 4);
  return buf;
}

/** Minimal PNG: signature + IHDR with given dimensions. */
function pngFixture(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrType = Buffer.from("IHDR");
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
}

/** Minimal ISO-BMFF with ftyp + moov/mvhd (version 0). */
function mp4Fixture(durationMs = 2000, timescale = 1000, version = 0) {
  const ftypBody = Buffer.alloc(12);
  ftypBody.write("isom", 0, 4);
  ftypBody.writeUInt32BE(0, 4);
  ftypBody.write("isom", 8, 4);
  const ftyp = box("ftyp", ftypBody);

  const mvhdBody = Buffer.alloc(96);
  mvhdBody[0] = version;
  if (version === 0) {
    mvhdBody.writeUInt32BE(timescale, 12);
    mvhdBody.writeUInt32BE(durationMs, 16);
  } else {
    mvhdBody.writeUInt32BE(timescale, 20);
    mvhdBody.writeUInt32BE(0, 24);
    mvhdBody.writeUInt32BE(durationMs, 28);
  }
  mvhdBody.writeUInt32BE(0x00010000, version === 0 ? 20 : 32);
  mvhdBody.writeUInt16BE(0x0100, version === 0 ? 24 : 36);
  const mvhd = box("mvhd", mvhdBody);
  const moov = box("moov", mvhd);

  return Buffer.concat([ftyp, moov]);
}

/** simctl-style MP4: ftyp + moov + extended-size mdat tail. */
function simctlMp4Fixture(durationMs = 2000) {
  const ftyp = box("ftyp", Buffer.from("isom0000isom", "ascii"));
  const mvhdBody = Buffer.alloc(96);
  mvhdBody.writeUInt32BE(1000, 12);
  mvhdBody.writeUInt32BE(durationMs, 16);
  mvhdBody.writeUInt32BE(0x00010000, 20);
  mvhdBody.writeUInt16BE(0x0100, 24);
  const moov = box("moov", box("mvhd", mvhdBody));
  const mdatPayload = Buffer.from("simctl-video-bytes", "ascii");
  const mdat = extendedBox("mdat", mdatPayload);
  return Buffer.concat([ftyp, moov, mdat]);
}

describe("probeRunArtifact", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-artifact-media-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("probes valid PNG and MP4 fixtures", async () => {
    const png = pngFixture(2, 3);
    const pngPath = path.join(dir, "ok.png");
    await fs.promises.writeFile(pngPath, png);

    assert.deepEqual(
      await probeRunArtifact(pngPath, {
        kind: "image",
        mimeType: "image/png",
      }),
      { mimeType: "image/png", size: png.length, width: 2, height: 3 },
    );

    const fakePngPath = path.join(dir, "fake.png");
    await fs.promises.writeFile(fakePngPath, Buffer.from("not a png"));

    await assert.rejects(
      probeRunArtifact(fakePngPath, { kind: "image", mimeType: "image/png" }),
      (err) => err.code === "invalid_artifact",
    );

    const mp4Path = path.join(dir, "ok.mp4");
    await fs.promises.writeFile(mp4Path, mp4Fixture());
    const mp4 = await probeRunArtifact(mp4Path, {
      kind: "video",
      mimeType: "video/mp4",
    });
    assert.equal(mp4.durationMs, 2_000);
  });

  it("reads mvhd version 1 duration", async () => {
    const mp4Path = path.join(dir, "v1.mp4");
    await fs.promises.writeFile(mp4Path, mp4Fixture(3500, 1000, 1));
    const mp4 = await probeRunArtifact(mp4Path, {
      kind: "video",
      mimeType: "video/mp4",
    });
    assert.equal(mp4.durationMs, 3_500);
  });

  it("rejects over-five-minute duration", async () => {
    const mp4Path = path.join(dir, "long.mp4");
    await fs.promises.writeFile(
      mp4Path,
      mp4Fixture(5 * 60 * 1000 + 1, 1000),
    );
    await assert.rejects(
      probeRunArtifact(mp4Path, { kind: "video", mimeType: "video/mp4" }),
      (err) => err.code === "artifact_limit",
    );
  });

  it("rejects missing ftyp and box end past EOF", async () => {
    const noFtypPath = path.join(dir, "no-ftyp.mp4");
    const mvhdBody = Buffer.alloc(96);
    mvhdBody.writeUInt32BE(1000, 12);
    mvhdBody.writeUInt32BE(2000, 16);
    await fs.promises.writeFile(
      noFtypPath,
      box("moov", box("mvhd", mvhdBody)),
    );
    await assert.rejects(
      probeRunArtifact(noFtypPath, { kind: "video", mimeType: "video/mp4" }),
      (err) => err.code === "invalid_artifact",
    );

    const truncated = Buffer.alloc(40);
    truncated.writeUInt32BE(100, 0);
    truncated.write("ftyp", 4, 4);
    const truncatedPath = path.join(dir, "truncated.mp4");
    await fs.promises.writeFile(truncatedPath, truncated);
    await assert.rejects(
      probeRunArtifact(truncatedPath, { kind: "video", mimeType: "video/mp4" }),
      (err) =>
        err.code === "invalid_artifact" &&
        /exceeds file size/i.test(err.message),
    );
  });

  it("accepts extended-size and terminal mdat boxes", async () => {
    const mp4Path = path.join(dir, "simctl.mp4");
    const bytes = simctlMp4Fixture(1800);
    await fs.promises.writeFile(mp4Path, bytes);
    const mp4 = await probeRunArtifact(mp4Path, {
      kind: "video",
      mimeType: "video/mp4",
    });
    assert.equal(mp4.durationMs, 1_800);
    assert.equal(mp4.size, bytes.length);

    const terminalPath = path.join(dir, "terminal.mp4");
    const ftyp = box("ftyp", Buffer.from("isom0000isom", "ascii"));
    const mvhdBody = Buffer.alloc(96);
    mvhdBody.writeUInt32BE(1000, 12);
    mvhdBody.writeUInt32BE(900, 16);
    const moov = box("moov", box("mvhd", mvhdBody));
    const tail = Buffer.concat([ftyp, moov, terminalBox("mdat")]);
    await fs.promises.writeFile(terminalPath, tail);
    const terminal = await probeRunArtifact(terminalPath, {
      kind: "video",
      mimeType: "video/mp4",
    });
    assert.equal(terminal.durationMs, 900);
  });

  it("rejects staged-file symlink replacement", async () => {
    const real = path.join(dir, "real.png");
    const link = path.join(dir, "link.png");
    await fs.promises.writeFile(real, pngFixture(1, 1));
    await fs.promises.symlink(real, link);
    await assert.rejects(
      probeRunArtifact(link, { kind: "image", mimeType: "image/png" }),
      (err) => err.code === "invalid_artifact",
    );
  });
});
