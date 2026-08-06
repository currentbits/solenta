/** Conservative entity extraction for memory entries and search queries. */

const CODE_EXTS = new Set([
  'js',
  'ts',
  'tsx',
  'jsx',
  'css',
  'html',
  'json',
  'md',
  'yml',
  'yaml',
  'toml',
  'sql',
  'py',
  'rs',
  'go',
  'java',
  'rb',
  'sh',
])

const MIN_NAME = 3
const MAX_NAME = 80
const MAX_ENTITIES = 15

/**
 * @typedef {{ name: string, kind: 'concept' | 'file' | 'module' }} ExtractedEntity
 */

/**
 * @param {string} name
 * @returns {boolean}
 */
function validLength(name) {
  const n = name.length
  return n >= MIN_NAME && n <= MAX_NAME
}

/**
 * PascalCase with at least two humps: Upper+lower then another Upper+lower…
 * Skips single Capitalized words, camelCase, and ALLCAPS.
 * @param {string} token
 */
function isTwoHumpPascal(token) {
  return /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(token)
}

/**
 * Extract up to 15 entities from free text.
 * @param {string} text
 * @returns {ExtractedEntity[]}
 */
export function extractEntities(text) {
  const input = String(text ?? '')
  /** @type {Map<string, ExtractedEntity>} */
  const seen = new Map()

  /**
   * @param {string} name
   * @param {ExtractedEntity['kind']} kind
   */
  function add(name, kind) {
    if (seen.size >= MAX_ENTITIES) return
    const clean = name.trim()
    if (!validLength(clean)) return
    const key = `${kind}\0${clean}`
    if (seen.has(key)) return
    seen.set(key, { name: clean, kind })
  }

  // 1) Wikilinks → concept. Strip |alias and #anchor from the target.
  const wikiRe = /\[\[([^\]]+)\]\]/g
  let m
  while ((m = wikiRe.exec(input)) !== null) {
    let target = m[1].trim()
    // Drop display alias after |
    const pipe = target.indexOf('|')
    if (pipe !== -1) target = target.slice(0, pipe)
    // Drop #anchor
    const hash = target.indexOf('#')
    if (hash !== -1) target = target.slice(0, hash)
    target = target.trim()
    if (target) add(target, 'concept')
  }

  // 2) File tokens with allow-listed extensions (reject e.g., 3.4s, etc.)
  // Match path-ish tokens ending in .ext
  const fileRe = /(?<![A-Za-z0-9_])([A-Za-z0-9_./-]+\.([A-Za-z0-9]+))(?![A-Za-z0-9_])/g
  while ((m = fileRe.exec(input)) !== null) {
    const full = m[1]
    const ext = m[2].toLowerCase()
    if (!CODE_EXTS.has(ext)) continue
    // Prefer basename for short paths; keep path if it looks intentional
    add(full, 'file')
  }

  // 3) PascalCase modules with ≥2 humps
  const wordRe = /\b([A-Za-z][A-Za-z0-9]*)\b/g
  while ((m = wordRe.exec(input)) !== null) {
    const token = m[1]
    if (isTwoHumpPascal(token)) add(token, 'module')
  }

  return [...seen.values()].slice(0, MAX_ENTITIES)
}
