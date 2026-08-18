import fs from 'node:fs'
import path from 'node:path'

const MAX_CITATIONS = 8
const EXCERPT_MAX = 400
const SHA_RE = /^[0-9a-f]{7,40}$/i
const SEARCH_WINDOW = 25

// Citation verification reads whole files synchronously, and one search or
// bootstrap request can cite the same file many times. Cache file text keyed
// on path, invalidated by mtimeMs+size (a stat per verify is cheap compared
// to the read + excerpt scan). Entries hold full file text, so cap the map.
const FILE_TEXT_CACHE_MAX = 64
/** @type {Map<string, { mtimeMs: number, size: number, text: string }>} */
const fileTextCache = new Map()

/**
 * Read a file as utf8, cached on mtimeMs+size. null when unreadable —
 * callers treat that as "citation file gone".
 * @param {string} abs
 * @returns {string|null}
 */
function readFileTextCached(abs) {
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    return null
  }
  const hit = fileTextCache.get(abs)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  if (fileTextCache.size >= FILE_TEXT_CACHE_MAX) fileTextCache.clear()
  fileTextCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, text })
  return text
}

/**
 * @typedef {{ kind: 'file', path: string, line?: number, endLine?: number, excerpt?: string }} FileCitation
 * @typedef {{ kind: 'thread', id: string }} ThreadCitation
 * @typedef {{ kind: 'commit', sha: string }} CommitCitation
 * @typedef {FileCitation | ThreadCitation | CommitCitation} Citation
 */

function asInt(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

function cleanPath(value) {
  let p = String(value ?? '').trim().replace(/\\/g, '/')
  if (!p) return null
  while (p.startsWith('./')) p = p.slice(2)
  if (!p || p === '.' || p.includes('\0')) return null
  return p
}

/**
 * @param {unknown} input
 * @returns {Citation[]}
 */
export function normalizeCitations(input) {
  if (!Array.isArray(input)) return []
  /** @type {Citation[]} */
  const out = []
  for (const raw of input) {
    if (out.length >= MAX_CITATIONS) break
    if (!raw || typeof raw !== 'object') continue
    const kind = String(/** @type {{kind?: unknown}} */ (raw).kind ?? '').trim()
    if (kind === 'file') {
      const filePath = cleanPath(/** @type {{path?: unknown}} */ (raw).path)
      if (!filePath) continue
      /** @type {FileCitation} */
      const cite = { kind: 'file', path: filePath }
      const line = asInt(/** @type {{line?: unknown}} */ (raw).line)
      if (line) cite.line = line
      const endLine = asInt(/** @type {{endLine?: unknown}} */ (raw).endLine)
      if (endLine && (!line || endLine >= line)) cite.endLine = endLine
      const excerpt = String(/** @type {{excerpt?: unknown}} */ (raw).excerpt ?? '').trim()
      if (excerpt) cite.excerpt = excerpt.slice(0, EXCERPT_MAX)
      out.push(cite)
      continue
    }
    if (kind === 'thread') {
      const id = String(/** @type {{id?: unknown}} */ (raw).id ?? '').trim()
      if (id) out.push({ kind: 'thread', id })
      continue
    }
    if (kind === 'commit') {
      const sha = String(/** @type {{sha?: unknown}} */ (raw).sha ?? '').trim()
      if (SHA_RE.test(sha)) out.push({ kind: 'commit', sha: sha.toLowerCase() })
    }
  }
  return out
}

/**
 * @param {unknown} raw
 * @returns {Citation[]}
 */
export function parseCitations(raw) {
  if (Array.isArray(raw)) return normalizeCitations(raw)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    return normalizeCitations(JSON.parse(raw))
  } catch {
    return []
  }
}

/**
 * @param {Citation[]} citations
 * @returns {string|null}
 */
export function serializeCitations(citations) {
  const clean = normalizeCitations(citations)
  return clean.length ? JSON.stringify(clean) : null
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
export function resolveVerifyRoot(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const resolved = path.resolve(raw)
    if (!fs.statSync(resolved).isDirectory()) return null
    return resolved
  } catch {
    return null
  }
}

/**
 * Resolve a citation path inside root. Null when it escapes or does not exist
 * as a constructible in-tree path.
 * @param {string} root
 * @param {string} rel
 * @returns {string|null}
 */
export function resolveSafePath(root, rel) {
  const cleaned = cleanPath(rel)
  if (!cleaned) return null
  if (path.isAbsolute(cleaned)) {
    const abs = path.resolve(cleaned)
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (abs !== root && !abs.startsWith(prefix)) return null
    return abs
  }
  const abs = path.resolve(root, cleaned)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (abs !== root && !abs.startsWith(prefix)) return null
  return abs
}

function collapseWs(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * Find a 1-based line whose collapsed text contains the excerpt.
 * Prefers `hintLine`, then a window around it, then the whole file.
 * @param {string[]} lines
 * @param {string} excerpt
 * @param {number|null} hintLine
 * @returns {{ line: number, healed: boolean }|null}
 */
function findExcerpt(lines, excerpt, hintLine) {
  const needle = collapseWs(excerpt)
  if (!needle) return null

  const at = (idx) => {
    if (idx < 0 || idx >= lines.length) return false
    return collapseWs(lines[idx]).includes(needle)
  }

  if (hintLine) {
    const idx = hintLine - 1
    if (at(idx)) return { line: hintLine, healed: false }
    const lo = Math.max(0, idx - SEARCH_WINDOW)
    const hi = Math.min(lines.length - 1, idx + SEARCH_WINDOW)
    for (let i = lo; i <= hi; i++) {
      if (i === idx) continue
      if (at(i)) return { line: i + 1, healed: true }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (at(i)) return { line: i + 1, healed: i + 1 !== hintLine }
  }

  // Multi-line excerpt: join the whole file and accept the first line of a match.
  const joined = collapseWs(lines.join('\n'))
  if (joined.includes(needle) && hintLine && at(hintLine - 1)) {
    return { line: hintLine, healed: false }
  }
  if (joined.includes(needle)) {
    // Fall back: first line that shares a leading token with the excerpt.
    const firstTok = needle.split(' ')[0]
    if (firstTok) {
      for (let i = 0; i < lines.length; i++) {
        if (collapseWs(lines[i]).includes(firstTok)) {
          return { line: i + 1, healed: i + 1 !== hintLine }
        }
      }
    }
    return { line: hintLine || 1, healed: Boolean(hintLine) }
  }
  return null
}

/**
 * @param {string} root
 * @param {Citation} citation
 * @returns {{ ok: boolean, verifiable?: boolean, line?: number, healed?: boolean, reason?: string }}
 */
export function verifyFileCitation(root, citation) {
  if (!citation || citation.kind !== 'file') {
    return { ok: true, verifiable: false }
  }
  const abs = resolveSafePath(root, citation.path)
  if (!abs) {
    // Outside the tree is a bad citation, not proof the fact is false.
    return { ok: true, verifiable: false }
  }
  const text = readFileTextCached(abs)
  if (text == null) {
    return { ok: false, reason: `citation file gone: ${citation.path}` }
  }
  const excerpt = citation.excerpt ? String(citation.excerpt).trim() : ''
  if (!excerpt) {
    // Provenance-only: file exists, we cannot prove the fact is still true.
    return { ok: true, verifiable: false }
  }
  const lines = text.split(/\r?\n/)
  const found = findExcerpt(lines, excerpt, citation.line ?? null)
  if (!found) {
    const where = citation.line ? `${citation.path}:${citation.line}` : citation.path
    return { ok: false, reason: `citation stale: ${where} excerpt no longer matches` }
  }
  return { ok: true, verifiable: true, line: found.line, healed: found.healed }
}

/**
 * @param {string} root
 * @param {Citation[]} citations
 * @returns {{ ok: boolean, healed: boolean, citations: Citation[], reason?: string }}
 */
export function verifyFileCitations(root, citations) {
  const list = normalizeCitations(citations)
  let healed = false
  /** @type {Citation[]} */
  const next = []
  for (const cite of list) {
    if (cite.kind !== 'file') {
      next.push(cite)
      continue
    }
    const result = verifyFileCitation(root, cite)
    if (!result.ok) {
      return { ok: false, healed: false, citations: list, reason: result.reason }
    }
    if (result.verifiable && result.healed && result.line) {
      healed = true
      next.push({ ...cite, line: result.line })
    } else {
      next.push(cite)
    }
  }
  return { ok: true, healed, citations: next }
}

/**
 * @param {Citation} citation
 * @returns {string}
 */
export function formatCitation(citation) {
  if (!citation || typeof citation !== 'object') return ''
  if (citation.kind === 'file') {
    return citation.line ? `${citation.path}:${citation.line}` : citation.path
  }
  if (citation.kind === 'thread') {
    return `thread ${citation.id.slice(0, 8)}`
  }
  if (citation.kind === 'commit') {
    return citation.sha.slice(0, 7)
  }
  return ''
}
