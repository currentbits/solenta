/** Pluggable text embedding: fake (tests) + transformers.js (production). */

export const EMBED_MAX_CHARS = 1200
export const DEFAULT_FAKE_DIM = 8
export const REAL_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
export const REAL_DIM = 384

/**
 * @param {Float32Array} v
 * @returns {Float32Array}
 */
export function l2normalize(v) {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (norm === 0) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/**
 * Cosine similarity. Assumes L2-normalized inputs (dot product). Length mismatch → 0.
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/**
 * @param {Float32Array} v
 * @returns {Buffer}
 */
export function floatToBlob(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

/**
 * Copy so the Float32Array owns aligned memory independent of the sqlite Buffer.
 * @param {Buffer|Uint8Array} buf
 * @returns {Float32Array}
 */
export function blobToFloat(buf) {
  const copy = Buffer.from(buf)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

/**
 * Deterministic hash-based embedder for tests.
 * Shared tokens → closer vectors. Never throws.
 * @param {number} [dim=8]
 * @returns {{ model: string, dim: number, embed: (text: string) => Float32Array|null }}
 */
export function fakeEmbedder(dim = DEFAULT_FAKE_DIM) {
  const d = Math.max(1, Math.trunc(dim) || DEFAULT_FAKE_DIM)
  return {
    model: 'fake',
    dim: d,
    /**
     * @param {string} text
     * @returns {Float32Array|null}
     */
    embed(text) {
      try {
        const raw = String(text ?? '').slice(0, EMBED_MAX_CHARS)
        const v = new Float32Array(d)
        const tokens = raw.toLowerCase().match(/[a-z0-9]+/g) ?? []
        for (const tok of tokens) {
          let h = 2166136261
          for (let i = 0; i < tok.length; i++) {
            h ^= tok.charCodeAt(i)
            h = Math.imul(h, 16777619)
          }
          for (let k = 0; k < 4; k++) {
            h = Math.imul(h ^ (h >>> 13), 16777619)
            v[(h >>> 0) % d] += 1
          }
        }
        return l2normalize(v)
      } catch {
        return null
      }
    },
  }
}

/**
 * Real MiniLM embedder via @huggingface/transformers. Lazy single-load.
 * Concurrent callers share one load promise; a load failure clears the cache so
 * the next call retries. embed() failures return null (never throw).
 * @returns {{ model: string, dim: number, embed: (text: string) => Promise<Float32Array|null> }}
 */
export function createRealEmbedder() {
  /** @type {Promise<any>|null} */
  let pipePromise = null

  function load() {
    if (pipePromise) return pipePromise
    // Assign before awaiting so concurrent callers share one load.
    pipePromise = (async () => {
      const t = await import('@huggingface/transformers')
      return t.pipeline('feature-extraction', REAL_MODEL_ID, {
        device: 'cpu',
        dtype: 'q8',
      })
    })()
    // Load failure must not disable semantic recall forever.
    pipePromise.catch(() => {
      pipePromise = null
    })
    return pipePromise
  }

  return {
    model: REAL_MODEL_ID,
    dim: REAL_DIM,
    /**
     * @param {string} text
     * @returns {Promise<Float32Array|null>}
     */
    async embed(text) {
      try {
        const pipe = await load()
        const input = String(text ?? '').slice(0, EMBED_MAX_CHARS)
        // mean pooling; we L2-normalize ourselves for a stable unit vector.
        const res = await pipe(input, { pooling: 'mean', normalize: false })
        const data = res?.data ?? res
        return l2normalize(Float32Array.from(data))
      } catch {
        return null
      }
    },
  }
}

/**
 * Whether the real semantic embedder should be wired (CODER_MEMORY_SEMANTIC=0 disables).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function semanticEnabled(env = process.env) {
  const raw = env.CODER_MEMORY_SEMANTIC
  if (raw === '0' || raw === 'false') return false
  return true
}
