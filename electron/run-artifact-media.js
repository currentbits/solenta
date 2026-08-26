"use strict";

const fs = require("node:fs");

const DEFAULT_LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxVideoBytes: 250 * 1024 * 1024,
  maxVideoDurationMs: 5 * 60 * 1000,
  maxThreadBytes: 500 * 1024 * 1024,
  maxGlobalBytes: 1024 * 1024 * 1024,
};

const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

function artifactError(code, message) {
  const error = new Error(message);
  error.name = "RunArtifactError";
  error.code = code;
  return error;
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} size
 */
function readUInt32BE(buf, offset, size) {
  if (offset + 4 > size) {
    throw artifactError("invalid_artifact", "Invalid PNG");
  }
  return buf.readUInt32BE(offset);
}

/**
 * @param {string} file
 * @param {number} size
 */
async function probePng(file, size) {
  const head = Buffer.alloc(33);
  const fh = await fs.promises.open(file, "r");
  let bytesRead = 0;
  try {
    ({ bytesRead } = await fh.read(head, 0, 33, 0));
    if (bytesRead < 33) {
      throw artifactError("invalid_artifact", "Invalid PNG");
    }
  } finally {
    await fh.close();
  }
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw artifactError("invalid_artifact", "Invalid PNG signature");
  }
  if (head.toString("ascii", 12, 16) !== "IHDR") {
    throw artifactError("invalid_artifact", "Missing PNG IHDR");
  }
  const width = readUInt32BE(head, 16, bytesRead);
  const height = readUInt32BE(head, 20, bytesRead);
  if (width <= 0 || height <= 0) {
    throw artifactError("invalid_artifact", "Invalid PNG dimensions");
  }
  return {
    mimeType: "image/png",
    size,
    width,
    height,
  };
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} end
 * @param {string} type
 */
function boxType(buf, offset, end, type) {
  if (offset + 4 > end) return false;
  return buf.toString("ascii", offset, offset + 4) === type;
}

/**
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} containerEnd
 */
function readBoxBounds(buf, offset, containerEnd) {
  if (offset + 8 > containerEnd) {
    throw artifactError("invalid_artifact", "Invalid MP4");
  }
  const size = buf.readUInt32BE(offset);
  let headerSize = 8;
  let end;
  if (size === 0) {
    end = containerEnd;
  } else if (size === 1) {
    if (offset + 16 > containerEnd) {
      throw artifactError("invalid_artifact", "Invalid MP4 extended box");
    }
    headerSize = 16;
    const hi = buf.readUInt32BE(offset + 8);
    const lo = buf.readUInt32BE(offset + 12);
    const extSize = hi * 0x100000000 + lo;
    if (!Number.isFinite(extSize) || extSize < 16) {
      throw artifactError("invalid_artifact", "Invalid MP4 extended box");
    }
    end = offset + extSize;
  } else if (size < 8) {
    throw artifactError("invalid_artifact", "Invalid MP4 box");
  } else {
    end = offset + size;
  }
  if (end > containerEnd || end < offset + headerSize) {
    throw artifactError("invalid_artifact", "MP4 box exceeds file size");
  }
  return { end, bodyStart: offset + headerSize };
}

/**
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @param {number} maxVideoDurationMs
 */
function readMvhdDuration(buf, start, end, maxVideoDurationMs) {
  if (end - start < 24) {
    throw artifactError("invalid_artifact", "Invalid MP4 mvhd");
  }
  const version = buf[start];
  let timescale;
  let duration;
  if (version === 0) {
    timescale = buf.readUInt32BE(start + 12);
    duration = buf.readUInt32BE(start + 16);
  } else if (version === 1) {
    if (end - start < 32) {
      throw artifactError("invalid_artifact", "Invalid MP4 mvhd");
    }
    timescale = buf.readUInt32BE(start + 20);
    const hi = buf.readUInt32BE(start + 24);
    const lo = buf.readUInt32BE(start + 28);
    duration = hi * 0x100000000 + lo;
  } else {
    throw artifactError("invalid_artifact", "Invalid MP4 mvhd version");
  }
  if (!timescale || !duration) {
    throw artifactError("invalid_artifact", "Invalid MP4 duration");
  }
  const durationMs = Math.round((duration * 1000) / timescale);
  if (durationMs <= 0 || durationMs > maxVideoDurationMs) {
    throw artifactError("artifact_limit", "Video duration exceeds limit");
  }
  return durationMs;
}

/**
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @param {number} maxVideoDurationMs
 */
function findMvhdDuration(buf, start, end, maxVideoDurationMs) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxBounds(buf, offset, end);
    if (boxType(buf, offset + 4, box.end, "mvhd")) {
      return readMvhdDuration(buf, box.bodyStart, box.end, maxVideoDurationMs);
    }
    offset = box.end;
  }
  throw artifactError("invalid_artifact", "Missing MP4 mvhd");
}

/**
 * @param {string} file
 * @param {number} size
 * @param {number} maxVideoDurationMs
 */
async function probeMp4(file, size, maxVideoDurationMs) {
  const buf = await fs.promises.readFile(file);
  if (buf.length !== size) {
    throw artifactError("invalid_artifact", "Invalid MP4");
  }
  let offset = 0;
  let sawFtyp = false;
  let durationMs = null;
  while (offset + 8 <= size) {
    const box = readBoxBounds(buf, offset, size);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "ftyp") {
      sawFtyp = true;
    } else if (type === "moov") {
      durationMs = findMvhdDuration(
        buf,
        box.bodyStart,
        box.end,
        maxVideoDurationMs,
      );
    }
    offset = box.end;
  }
  if (!sawFtyp) {
    throw artifactError("invalid_artifact", "Missing MP4 ftyp");
  }
  if (durationMs == null) {
    throw artifactError("invalid_artifact", "Missing MP4 moov");
  }
  return {
    mimeType: "video/mp4",
    size,
    durationMs,
  };
}

async function probeRunArtifact(file, expected, limits = DEFAULT_LIMITS) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw artifactError("invalid_artifact", "Artifact must be a regular file");
  }
  const max =
    expected.kind === "image" ? limits.maxImageBytes : limits.maxVideoBytes;
  if (stat.size <= 0 || stat.size > max) {
    throw artifactError("artifact_limit", "Artifact exceeds its size limit");
  }
  return expected.kind === "image"
    ? probePng(file, stat.size)
    : probeMp4(file, stat.size, limits.maxVideoDurationMs);
}

module.exports = {
  DEFAULT_LIMITS,
  artifactError,
  probeRunArtifact,
};
