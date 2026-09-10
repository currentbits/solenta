"use strict";

/**
 * BLAKE3 hash (regular, 32-byte output). Port of the official reference
 * implementation so Grok long-cwd session groups can be named without a
 * native blake3 crate.
 */

const OUT_LEN = 32;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;
const CHUNK_START = 1 << 0;
const CHUNK_END = 1 << 1;
const PARENT = 1 << 2;
const ROOT = 1 << 3;

const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function g(state, a, b, c, d, mx, my) {
  state[a] = (state[a] + state[b] + mx) >>> 0;
  state[d] = rotr32(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr32(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b] + my) >>> 0;
  state[d] = rotr32(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr32(state[b] ^ state[c], 7);
}

function round(state, m) {
  g(state, 0, 4, 8, 12, m[0], m[1]);
  g(state, 1, 5, 9, 13, m[2], m[3]);
  g(state, 2, 6, 10, 14, m[4], m[5]);
  g(state, 3, 7, 11, 15, m[6], m[7]);
  g(state, 0, 5, 10, 15, m[8], m[9]);
  g(state, 1, 6, 11, 12, m[10], m[11]);
  g(state, 2, 7, 8, 13, m[12], m[13]);
  g(state, 3, 4, 9, 14, m[14], m[15]);
}

function permute(m) {
  const permuted = new Uint32Array(16);
  for (let i = 0; i < 16; i++) permuted[i] = m[MSG_PERMUTATION[i]];
  m.set(permuted);
}

function compress(chainingValue, blockWords, counter, blockLen, flags) {
  const state = new Uint32Array(16);
  state.set(chainingValue, 0);
  state[8] = IV[0];
  state[9] = IV[1];
  state[10] = IV[2];
  state[11] = IV[3];
  state[12] = counter >>> 0;
  state[13] = Math.floor(counter / 0x100000000) >>> 0;
  state[14] = blockLen >>> 0;
  state[15] = flags >>> 0;
  const block = new Uint32Array(blockWords);
  for (let i = 0; i < 6; i++) {
    round(state, block);
    permute(block);
  }
  round(state, block);
  for (let i = 0; i < 8; i++) {
    state[i] = (state[i] ^ state[i + 8]) >>> 0;
    state[i + 8] = (state[i + 8] ^ chainingValue[i]) >>> 0;
  }
  return state;
}

function wordsFromBytes(bytes) {
  const words = new Uint32Array(Math.ceil(bytes.length / 4) || 0);
  for (let i = 0; i < bytes.length; i += 4) {
    words[i / 4] =
      bytes[i] |
      ((bytes[i + 1] || 0) << 8) |
      ((bytes[i + 2] || 0) << 16) |
      ((bytes[i + 3] || 0) << 24);
  }
  return words;
}

function first8(compressionOutput) {
  return compressionOutput.slice(0, 8);
}

class Output {
  constructor(inputChainingValue, blockWords, counter, blockLen, flags) {
    this.inputChainingValue = inputChainingValue;
    this.blockWords = blockWords;
    this.counter = counter;
    this.blockLen = blockLen;
    this.flags = flags;
  }

  chainingValue() {
    return first8(
      compress(
        this.inputChainingValue,
        this.blockWords,
        this.counter,
        this.blockLen,
        this.flags,
      ),
    );
  }

  rootBytes() {
    const words = compress(
      this.inputChainingValue,
      this.blockWords,
      0,
      this.blockLen,
      this.flags | ROOT,
    );
    const out = Buffer.alloc(OUT_LEN);
    for (let i = 0; i < 8; i++) {
      out.writeUInt32LE(words[i] >>> 0, i * 4);
    }
    return out;
  }
}

class ChunkState {
  constructor(keyWords, chunkCounter, flags) {
    this.chainingValue = new Uint32Array(keyWords);
    this.chunkCounter = chunkCounter;
    this.block = Buffer.alloc(BLOCK_LEN);
    this.blockLen = 0;
    this.blocksCompressed = 0;
    this.flags = flags;
  }

  len() {
    return BLOCK_LEN * this.blocksCompressed + this.blockLen;
  }

  startFlag() {
    return this.blocksCompressed === 0 ? CHUNK_START : 0;
  }

  update(input) {
    let offset = 0;
    while (offset < input.length) {
      if (this.blockLen === BLOCK_LEN) {
        const blockWords = wordsFromBytes(this.block);
        this.chainingValue = first8(
          compress(
            this.chainingValue,
            blockWords,
            this.chunkCounter,
            BLOCK_LEN,
            this.flags | this.startFlag(),
          ),
        );
        this.blocksCompressed += 1;
        this.block.fill(0);
        this.blockLen = 0;
      }
      const take = Math.min(BLOCK_LEN - this.blockLen, input.length - offset);
      input.copy(this.block, this.blockLen, offset, offset + take);
      this.blockLen += take;
      offset += take;
    }
  }

  output() {
    const blockWords = new Uint32Array(16);
    blockWords.set(wordsFromBytes(this.block.subarray(0, this.blockLen)));
    return new Output(
      this.chainingValue,
      blockWords,
      this.chunkCounter,
      this.blockLen,
      this.flags | this.startFlag() | CHUNK_END,
    );
  }
}

function parentOutput(leftCv, rightCv, keyWords, flags) {
  const blockWords = new Uint32Array(16);
  blockWords.set(leftCv, 0);
  blockWords.set(rightCv, 8);
  return new Output(keyWords, blockWords, 0, BLOCK_LEN, PARENT | flags);
}

function parentCv(leftCv, rightCv, keyWords, flags) {
  return parentOutput(leftCv, rightCv, keyWords, flags).chainingValue();
}

class Hasher {
  constructor() {
    this.keyWords = new Uint32Array(IV);
    this.flags = 0;
    this.chunkState = new ChunkState(this.keyWords, 0, this.flags);
    this.cvStack = [];
  }

  addChunkChainingValue(newCv, totalChunks) {
    while ((totalChunks & 1) === 0) {
      newCv = parentCv(this.cvStack.pop(), newCv, this.keyWords, this.flags);
      totalChunks >>= 1;
    }
    this.cvStack.push(newCv);
  }

  update(input) {
    let offset = 0;
    while (offset < input.length) {
      if (this.chunkState.len() === CHUNK_LEN) {
        const chunkCv = this.chunkState.output().chainingValue();
        const totalChunks = this.chunkState.chunkCounter + 1;
        this.addChunkChainingValue(chunkCv, totalChunks);
        this.chunkState = new ChunkState(this.keyWords, totalChunks, this.flags);
      }
      const take = Math.min(CHUNK_LEN - this.chunkState.len(), input.length - offset);
      this.chunkState.update(input.subarray(offset, offset + take));
      offset += take;
    }
  }

  finalize() {
    let output = this.chunkState.output();
    for (let i = this.cvStack.length - 1; i >= 0; i--) {
      output = parentOutput(
        this.cvStack[i],
        output.chainingValue(),
        this.keyWords,
        this.flags,
      );
    }
    return output.rootBytes();
  }
}

/**
 * @param {string | Buffer | Uint8Array} input
 * @returns {string} 64-char lowercase hex
 */
function blake3Hex(input) {
  const hasher = new Hasher();
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input instanceof Uint8Array ? input : String(input));
  hasher.update(buf);
  return hasher.finalize().toString("hex");
}

module.exports = { blake3Hex };
