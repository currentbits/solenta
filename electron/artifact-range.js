"use strict";

/**
 * Single-byte-range parser for artifact streaming (issue #248).
 * Accepts only `bytes=<one-range>`; rejects multiples and malformed input.
 */

/**
 * @param {string | undefined | null} header
 * @param {number} size
 * @returns {{ status: 200 | 206, start: number, end: number, length: number } | { status: 416 }}
 */
function resolveByteRange(header, size) {
  if (!Number.isFinite(size) || size < 0) {
    return { status: 416 };
  }

  if (header == null || header === "") {
    if (size === 0) {
      return { status: 200, start: 0, end: -1, length: 0 };
    }
    return { status: 200, start: 0, end: size - 1, length: size };
  }

  const h = String(header).trim();
  if (!h.startsWith("bytes=")) {
    return { status: 416 };
  }

  const spec = h.slice(6);
  if (!spec || spec.includes(",")) {
    return { status: 416 };
  }

  const dash = spec.indexOf("-");
  if (dash < 0) {
    return { status: 416 };
  }

  const left = spec.slice(0, dash);
  const right = spec.slice(dash + 1);
  if (left === "" && right === "") {
    return { status: 416 };
  }

  let start;
  let end;

  if (left === "") {
    const suffixLen = Number(right);
    if (!Number.isInteger(suffixLen) || suffixLen < 0 || right !== String(suffixLen)) {
      return { status: 416 };
    }
    if (suffixLen === 0 || size === 0) {
      return { status: 416 };
    }
    const actualLen = Math.min(suffixLen, size);
    start = size - actualLen;
    end = size - 1;
  } else if (right === "") {
    start = Number(left);
    if (!Number.isInteger(start) || start < 0 || left !== String(start)) {
      return { status: 416 };
    }
    if (start >= size) {
      return { status: 416 };
    }
    end = size - 1;
  } else {
    start = Number(left);
    end = Number(right);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < 0 ||
      left !== String(start) ||
      right !== String(end)
    ) {
      return { status: 416 };
    }
    if (start > end || start >= size) {
      return { status: 416 };
    }
    end = Math.min(end, size - 1);
  }

  const length = end - start + 1;
  if (length <= 0) {
    return { status: 416 };
  }

  return { status: 206, start, end, length };
}

module.exports = {
  resolveByteRange,
};
