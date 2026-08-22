"use strict";

/**
 * Boot-path JSON helpers for the one-file store (#639).
 *
 * JSON.parse of the whole coder-store blob is ~600 ms at ~180 MB, almost
 * entirely messagesByThread. The sidebar only needs the envelope
 * (threads, projects, settings, …). These helpers:
 *   - cut the envelope without skip-scanning the transcript blob
 *     (prefix walk + lastIndexOf a sibling key)
 *   - locate / peek one thread on demand
 *   - splice unhydrated raw ranges back in on stringify
 *
 * Skip-scan + index is only the fallback when the tail cut does not parse.
 * A thrown SyntaxError lets the caller JSON.parse the original (and
 * quarantine on failure).
 */

const MESSAGES_SENTINEL = "\u0001__lazy_messages__\u0001";

// Sibling keys that the current on-disk layout writes AFTER messagesByThread.
// Used to cut the envelope without skip-scanning the transcript blob.
const AFTER_MESSAGE_KEYS = [
  "workLogByThread",
  "usageByThread",
  "workflowTemplates",
  "spendByDay",
  "usageByDay",
  "usageThreadsByDay",
  "automations",
  "tasksByCrew",
  "digestSeenAt",
  "settings",
];

/**
 * @param {string} s
 * @param {number} i
 * @param {number} len
 * @returns {number}
 */
function skipWs(s, i, len) {
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) i += 1;
    else break;
  }
  return i;
}

/**
 * @param {string} s
 * @param {number} i opening quote
 * @param {number} len
 * @returns {number} index after the closing quote
 */
function skipString(s, i, len) {
  let pos = i + 1;
  while (pos < len) {
    const q = s.indexOf('"', pos);
    if (q < 0 || q >= len) {
      throw new SyntaxError("unterminated string");
    }
    let bs = 0;
    let k = q - 1;
    while (k >= pos && s.charCodeAt(k) === 92) {
      bs += 1;
      k -= 1;
    }
    if (bs % 2 === 0) return q + 1;
    pos = q + 1;
  }
  throw new SyntaxError("unterminated string");
}

/**
 * @param {string} s
 * @param {number} i
 * @param {number} len
 * @param {string} word
 * @returns {boolean}
 */
function atWord(s, i, len, word) {
  if (i + word.length > len) return false;
  if (!s.startsWith(word, i)) return false;
  const next = i + word.length;
  if (next >= len) return true;
  const c = s.charCodeAt(next);
  // JSON literals cannot be followed by identifier-like chars.
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) return false;
  return true;
}

/**
 * @param {string} s
 * @param {number} i
 * @param {number} len
 * @returns {number}
 */
function skipNumber(s, i, len) {
  const start = i;
  if (s.charCodeAt(i) === 45) i += 1; // minus
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) i += 1;
    else break;
  }
  if (i < len && s.charCodeAt(i) === 46) {
    i += 1;
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) i += 1;
      else break;
    }
  }
  if (i < len && (s.charCodeAt(i) === 101 || s.charCodeAt(i) === 69)) {
    i += 1;
    if (i < len && (s.charCodeAt(i) === 43 || s.charCodeAt(i) === 45)) i += 1;
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) i += 1;
      else break;
    }
  }
  if (i === start || (s.charCodeAt(start) === 45 && i === start + 1)) {
    throw new SyntaxError("invalid number");
  }
  return i;
}

/**
 * @param {string} s
 * @param {number} i
 * @param {number} len
 * @returns {number}
 */
function skipValue(s, i, len) {
  i = skipWs(s, i, len);
  if (i >= len) throw new SyntaxError("unexpected end of JSON");
  const c = s.charCodeAt(i);
  if (c === 34) return skipString(s, i, len);
  if (c === 123) return skipObject(s, i, len);
  if (c === 91) return skipArray(s, i, len);
  if (c === 116 && atWord(s, i, len, "true")) return i + 4;
  if (c === 102 && atWord(s, i, len, "false")) return i + 5;
  if (c === 110 && atWord(s, i, len, "null")) return i + 4;
  if (c === 45 || (c >= 48 && c <= 57)) return skipNumber(s, i, len);
  throw new SyntaxError(`unexpected token at ${i}`);
}

/**
 * @param {string} s
 * @param {number} i opening [
 * @param {number} len
 * @returns {number}
 */
function skipArray(s, i, len) {
  i += 1;
  i = skipWs(s, i, len);
  if (i < len && s.charCodeAt(i) === 93) return i + 1;
  while (i < len) {
    i = skipValue(s, i, len);
    i = skipWs(s, i, len);
    if (i >= len) break;
    const c = s.charCodeAt(i);
    if (c === 44) {
      i += 1;
      continue;
    }
    if (c === 93) return i + 1;
    throw new SyntaxError("expected comma or ]");
  }
  throw new SyntaxError("unterminated array");
}

/**
 * @param {string} s
 * @param {number} i opening {
 * @param {number} len
 * @returns {number}
 */
function skipObject(s, i, len) {
  i += 1;
  i = skipWs(s, i, len);
  if (i < len && s.charCodeAt(i) === 125) return i + 1;
  while (i < len) {
    i = skipWs(s, i, len);
    if (s.charCodeAt(i) !== 34) throw new SyntaxError("expected object key");
    i = skipString(s, i, len);
    i = skipWs(s, i, len);
    if (i >= len || s.charCodeAt(i) !== 58) throw new SyntaxError("expected colon");
    i = skipValue(s, i + 1, len);
    i = skipWs(s, i, len);
    if (i >= len) break;
    const c = s.charCodeAt(i);
    if (c === 44) {
      i += 1;
      continue;
    }
    if (c === 125) return i + 1;
    throw new SyntaxError("expected comma or }");
  }
  throw new SyntaxError("unterminated object");
}

/**
 * Walk a message array once, parsing only from the tail until an assistant
 * with non-empty text is found. Element ranges are discarded afterwards.
 * @param {string} s
 * @param {number} i opening [
 * @param {number} len
 * @returns {{ end: number, lastAssistant: object | null }}
 */
function skipMessageArray(s, i, len) {
  const starts = [];
  const ends = [];
  i += 1;
  i = skipWs(s, i, len);
  if (i < len && s.charCodeAt(i) === 93) {
    return { end: i + 1, lastAssistant: null };
  }
  while (i < len) {
    i = skipWs(s, i, len);
    const vs = i;
    i = skipValue(s, i, len);
    starts.push(vs);
    ends.push(i);
    i = skipWs(s, i, len);
    if (i >= len) break;
    const c = s.charCodeAt(i);
    if (c === 44) {
      i += 1;
      continue;
    }
    if (c === 93) {
      return {
        end: i + 1,
        lastAssistant: peekLastAssistant(s, starts, ends),
      };
    }
    throw new SyntaxError("expected comma or ]");
  }
  throw new SyntaxError("unterminated array");
}

/**
 * @param {string} s
 * @param {number[]} starts
 * @param {number[]} ends
 * @returns {object | null}
 */
function peekLastAssistant(s, starts, ends) {
  for (let n = starts.length - 1; n >= 0; n -= 1) {
    let obj;
    try {
      obj = JSON.parse(s.slice(starts[n], ends[n]));
    } catch {
      continue;
    }
    if (
      obj &&
      obj.role === "assistant" &&
      typeof obj.text === "string" &&
      obj.text.trim() !== ""
    ) {
      return obj;
    }
  }
  return null;
}

/**
 * Index a JSON object: each own key → value [start, end) in `s`.
 * Message arrays also yield a last-assistant peek.
 * @param {string} s
 * @param {number} i opening {
 * @param {number} len
 * @returns {{ end: number, ranges: Map<string, {start:number, end:number}>, lastAssistants: Map<string, object | null> }}
 */
function indexJsonObject(s, i, len) {
  /** @type {Map<string, { start: number, end: number }>} */
  const ranges = new Map();
  /** @type {Map<string, object | null>} */
  const lastAssistants = new Map();
  i += 1;
  i = skipWs(s, i, len);
  if (i < len && s.charCodeAt(i) === 125) {
    return { end: i + 1, ranges, lastAssistants };
  }
  while (i < len) {
    i = skipWs(s, i, len);
    if (s.charCodeAt(i) !== 34) throw new SyntaxError("expected object key");
    const keyStart = i;
    i = skipString(s, i, len);
    const key = JSON.parse(s.slice(keyStart, i));
    i = skipWs(s, i, len);
    if (i >= len || s.charCodeAt(i) !== 58) throw new SyntaxError("expected colon");
    i = skipWs(s, i + 1, len);
    const vs = i;
    let ve;
    if (s.charCodeAt(i) === 91) {
      const arr = skipMessageArray(s, i, len);
      ve = arr.end;
      lastAssistants.set(key, arr.lastAssistant);
    } else {
      ve = skipValue(s, i, len);
    }
    ranges.set(key, { start: vs, end: ve });
    i = skipWs(s, ve, len);
    if (i >= len) break;
    const c = s.charCodeAt(i);
    if (c === 44) {
      i += 1;
      continue;
    }
    if (c === 125) return { end: i + 1, ranges, lastAssistants };
    throw new SyntaxError("expected comma or }");
  }
  throw new SyntaxError("unterminated object");
}

/**
 * Last occurrence of `"key":` after `after` that is an object key (comma or
 * `{` before it). Returns the index of the comma (or -1). lastIndexOf so we
 * hit the top-level sibling, not a nested key inside the transcript blob.
 * @param {string} s
 * @param {string} key
 * @param {number} after
 * @returns {number}
 */
function lastKeyComma(s, key, after) {
  const quoted = JSON.stringify(key);
  let from = s.length;
  while (from > after) {
    const at = s.lastIndexOf(quoted, from - 1);
    if (at < 0 || at < after) return -1;
    let i = skipWs(s, at + quoted.length, s.length);
    if (s.charCodeAt(i) === 58) {
      let j = at - 1;
      while (j >= after && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 10 || s.charCodeAt(j) === 13 || s.charCodeAt(j) === 9)) {
        j -= 1;
      }
      if (j >= after && s.charCodeAt(j) === 44) return j;
    }
    from = at;
  }
  return -1;
}

/**
 * Comma that starts the first top-level key after messagesByThread, or -1
 * when messagesByThread is the last key.
 * @param {string} s
 * @param {number} valueStart
 * @returns {number}
 */
function findTailComma(s, valueStart) {
  let leftmost = -1;
  for (const key of AFTER_MESSAGE_KEYS) {
    const comma = lastKeyComma(s, key, valueStart);
    if (comma < 0) continue;
    if (leftmost < 0 || comma < leftmost) leftmost = comma;
  }
  return leftmost;
}

/**
 * Locate `"messagesByThread"` at depth 1 by walking only the prefix (the
 * envelope keys before it). Does not skip the value.
 * @param {string} json
 * @returns {{ keyStart: number, valueStart: number } | null}
 */
function findMessagesKey(json) {
  const len = json.length;
  let i = skipWs(json, 0, len);
  if (i >= len || json.charCodeAt(i) !== 123) {
    throw new SyntaxError("store root must be an object");
  }
  i += 1;
  i = skipWs(json, i, len);
  if (i < len && json.charCodeAt(i) === 125) return null;
  while (i < len) {
    i = skipWs(json, i, len);
    if (json.charCodeAt(i) !== 34) throw new SyntaxError("expected object key");
    const keyStart = i;
    i = skipString(json, i, len);
    const key = JSON.parse(json.slice(keyStart, i));
    i = skipWs(json, i, len);
    if (i >= len || json.charCodeAt(i) !== 58) throw new SyntaxError("expected colon");
    i = skipWs(json, i + 1, len);
    if (key === "messagesByThread") {
      return { keyStart, valueStart: i };
    }
    i = skipValue(json, i, len);
    i = skipWs(json, i, len);
    if (i >= len) break;
    const c = json.charCodeAt(i);
    if (c === 44) {
      i += 1;
      continue;
    }
    if (c === 125) break;
    throw new SyntaxError("expected comma or }");
  }
  return null;
}

/**
 * Split a store JSON document: parse-ready envelope with messagesByThread
 * replaced by `{}`, plus the original value as a raw slice.
 *
 * Fast path: walk the prefix until the key, then lastIndexOf a sibling key
 * to find the tail — never skip-scans the transcript blob. Slow path (skip
 * + index) is only the fallback when the tail cut does not parse.
 *
 * @param {string} json
 * @returns {{
 *   envelopeJson: string,
 *   raw: string | null,
 *   ranges: Map<string, {start:number, end:number}>,
 *   lastAssistants: Map<string, object | null>,
 *   indexed: boolean,
 * }}
 */
function splitMessagesByThread(json) {
  const found = findMessagesKey(json);
  if (!found) {
    return {
      envelopeJson: json,
      raw: null,
      ranges: new Map(),
      lastAssistants: new Map(),
      indexed: false,
    };
  }
  if (json.charCodeAt(found.valueStart) !== 123) {
    const valueEnd = skipValue(json, found.valueStart, json.length);
    return {
      envelopeJson:
        json.slice(0, found.valueStart) + "{}" + json.slice(valueEnd),
      raw: null,
      ranges: new Map(),
      lastAssistants: new Map(),
      indexed: false,
    };
  }

  const empty = () => ({
    ranges: new Map(),
    lastAssistants: new Map(),
    indexed: false,
  });

  const tailComma = findTailComma(json, found.valueStart);
  let valueEnd;
  let envelopeJson;
  if (tailComma >= 0) {
    valueEnd = tailComma;
    envelopeJson =
      json.slice(0, found.valueStart) + "{}" + json.slice(valueEnd);
  } else {
    // Last top-level key: close the root after an empty object.
    envelopeJson = json.slice(0, found.valueStart) + "{}}";
    let end = json.length - 1;
    while (
      end > found.valueStart &&
      (json.charCodeAt(end) === 32 ||
        json.charCodeAt(end) === 10 ||
        json.charCodeAt(end) === 13 ||
        json.charCodeAt(end) === 9)
    ) {
      end -= 1;
    }
    valueEnd = end; // the root closing brace
  }

  try {
    JSON.parse(envelopeJson);
    const raw = json.slice(found.valueStart, valueEnd);
    return { envelopeJson, raw, ...empty() };
  } catch {
    // Tail cut was wrong (nested lookalike key). Skip-scan the value.
    const indexed = indexJsonObject(json, found.valueStart, json.length);
    envelopeJson =
      json.slice(0, found.valueStart) + "{}" + json.slice(indexed.end);
    const raw = json.slice(found.valueStart, indexed.end);
    const offset = found.valueStart;
    const ranges = new Map();
    for (const [id, r] of indexed.ranges) {
      ranges.set(id, { start: r.start - offset, end: r.end - offset });
    }
    return {
      envelopeJson,
      raw,
      ranges,
      lastAssistants: indexed.lastAssistants,
      indexed: true,
    };
  }
}

/**
 * Index a messagesByThread object string. Called on first mutating save,
 * not at boot.
 * @param {string} raw
 * @returns {{ ranges: Map<string, {start:number, end:number}>, lastAssistants: Map<string, object | null> }}
 */
function indexMessagesObject(raw) {
  const len = raw.length;
  const i = skipWs(raw, 0, len);
  if (i >= len || raw.charCodeAt(i) !== 123) {
    return { ranges: new Map(), lastAssistants: new Map() };
  }
  const indexed = indexJsonObject(raw, i, len);
  return { ranges: indexed.ranges, lastAssistants: indexed.lastAssistants };
}

/**
 * Find one thread's value range inside a messagesByThread object string.
 * @param {string} raw
 * @param {string} threadId
 * @returns {{ start: number, end: number } | null}
 */
function findThreadValue(raw, threadId) {
  if (!raw) return null;
  const quoted = JSON.stringify(String(threadId));
  const len = raw.length;
  let at = 0;
  while (at < len) {
    at = raw.indexOf(quoted, at);
    if (at < 0) return null;
    let i = skipWs(raw, at + quoted.length, len);
    if (raw.charCodeAt(i) === 58) {
      let j = at - 1;
      while (
        j >= 0 &&
        (raw.charCodeAt(j) === 32 ||
          raw.charCodeAt(j) === 10 ||
          raw.charCodeAt(j) === 13 ||
          raw.charCodeAt(j) === 9)
      ) {
        j -= 1;
      }
      if (j >= 0 && (raw.charCodeAt(j) === 44 || raw.charCodeAt(j) === 123)) {
        i = skipWs(raw, i + 1, len);
        const start = i;
        const end = skipValue(raw, i, len);
        return { start, end };
      }
    }
    at += 1;
  }
  return null;
}

/**
 * Last non-empty assistant message in a raw JSON array (or null).
 * @param {string} raw
 * @param {number} start
 * @param {number} [end]
 * @returns {object | null}
 */
function peekLastAssistantValue(raw, start, end) {
  if (!raw || start == null || raw.charCodeAt(start) !== 91) return null;
  const len = end == null ? raw.length : end;
  try {
    return skipMessageArray(raw, start, len).lastAssistant;
  } catch {
    return null;
  }
}

/**
 * Insert `item` as the last element of a JSON array slice in `raw`.
 * Does not JSON.parse the array. Mutates `range.end` by the inserted length.
 * Returns null if the slice is not an array.
 *
 * @param {string} raw
 * @param {{ start: number, end: number }} range
 * @param {unknown} item
 * @returns {{ raw: string, at: number, delta: number } | null}
 */
function appendJsonArrayItem(raw, range, item) {
  if (!raw || !range) return null;
  const start = range.start;
  const end = range.end;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > raw.length ||
    start >= end
  ) {
    return null;
  }
  if (raw.charCodeAt(start) !== 91) return null;
  let close = end - 1;
  while (close >= start) {
    const c = raw.charCodeAt(close);
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      close -= 1;
      continue;
    }
    break;
  }
  if (close < start || raw.charCodeAt(close) !== 93) return null;
  let inner = close - 1;
  while (inner >= start) {
    const c = raw.charCodeAt(inner);
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      inner -= 1;
      continue;
    }
    break;
  }
  const empty = inner >= start && raw.charCodeAt(inner) === 91;
  const insert = empty ? JSON.stringify(item) : "," + JSON.stringify(item);
  range.end += insert.length;
  return {
    raw: raw.slice(0, close) + insert + raw.slice(close),
    at: close,
    delta: insert.length,
  };
}

/**
 * Rebuild the messagesByThread JSON object from hydrated arrays plus
 * still-raw ranges. When nothing has been touched, returns the original
 * slice (no copy of per-thread values).
 *
 * @param {Record<string, unknown>} hydrated
 * @param {{ raw: string, ranges: Map<string, {start:number, end:number}>, intact?: boolean } | null | undefined} lazy
 * @returns {string}
 */
function serializeMessages(hydrated, lazy) {
  if (lazy && lazy.intact) {
    return lazy.raw;
  }
  const parts = ["{"];
  let first = true;
  const seen = new Set();
  const emit = (id, valueJson) => {
    if (first) first = false;
    else parts.push(",");
    parts.push(JSON.stringify(id), ":", valueJson);
  };
  if (lazy && lazy.raw && lazy.ranges) {
    for (const [id, r] of lazy.ranges) {
      seen.add(id);
      if (hydrated && Object.prototype.hasOwnProperty.call(hydrated, id)) {
        emit(id, JSON.stringify(hydrated[id]));
      } else {
        emit(id, lazy.raw.slice(r.start, r.end));
      }
    }
  }
  if (hydrated) {
    for (const id of Object.keys(hydrated)) {
      if (seen.has(id)) continue;
      emit(id, JSON.stringify(hydrated[id]));
    }
  }
  parts.push("}");
  return parts.join("");
}

/**
 * JSON.stringify a store data object without hydrating lazy messages.
 *
 * @param {object} data
 * @param {Record<string, unknown>} hydrated
 * @param {{ raw: string, ranges: Map<string, {start:number, end:number}>, intact?: boolean } | null | undefined} lazy
 * @returns {string}
 */
function stringifyStore(data, hydrated, lazy) {
  const payload = {};
  for (const key of Object.keys(data)) {
    if (key === "messagesByThread") continue;
    payload[key] = data[key];
  }
  if (!lazy || !lazy.raw) {
    payload.messagesByThread = hydrated || {};
    return JSON.stringify(payload);
  }
  payload.messagesByThread = MESSAGES_SENTINEL;
  const json = JSON.stringify(payload);
  const token = JSON.stringify(MESSAGES_SENTINEL);
  const at = json.indexOf(token);
  if (at < 0) {
    payload.messagesByThread = hydrated || {};
    return JSON.stringify(payload);
  }
  return (
    json.slice(0, at) +
    serializeMessages(hydrated || {}, lazy) +
    json.slice(at + token.length)
  );
}

module.exports = {
  splitMessagesByThread,
  serializeMessages,
  stringifyStore,
  indexMessagesObject,
  findThreadValue,
  peekLastAssistantValue,
  appendJsonArrayItem,
  MESSAGES_SENTINEL,
};
