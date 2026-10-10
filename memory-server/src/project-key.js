import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

/**
 * Canonical project identity for shared memory.
 *
 * Agents follow the handshake instruction "project set to your working
 * directory", so they send absolute paths, and those paths are often git
 * WORKTREES rather than the repo root. The app used to send its display slug
 * (which may be "owner/repo"). Three key shapes in one column meant
 * project-scoped retrieval matched nothing and everything degraded to global.
 *
 * Rule: the canonical key is the BASENAME OF THE MAIN REPO ROOT.
 *   /Users/me/code/coder                          -> "coder"
 *   C:\Users\me\code\coder                        -> "coder"
 *   /…/AgentMux/worktrees/coder-174dfbde (linked) -> "coder"   (via git-common-dir)
 *   "owner/coder"                                 -> "coder"   (display slug)
 *   "coder"                                       -> "coder"
 *   null / "" / "global"                          -> null      (global scope)
 *
 * Non-path values never touch the filesystem, so this stays cheap for the
 * common case. Git failures degrade to the path basename rather than throwing.
 *
 * Same-named repos (#179): with a db, a path's root is registered in
 * project_roots. The first root to claim a basename keeps the bare key (so
 * existing scopes never move); any other root with that basename gets
 * "<base>-<6 hex of sha1(root)>". Slugs carry no root and stay bare.
 */

/**
 * Absolute filesystem path, POSIX or Windows. Display slugs ("owner/repo")
 * are not absolute.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAbsoluteProjectPath(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  if (raw.startsWith('/') || raw.startsWith('\\\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(raw)
}

/**
 * Drive letters, UNC, and backslashes are Windows paths. `path.win32` is
 * required so a POSIX host still basenames `C:\repo` instead of treating the
 * whole string as one segment. POSIX inputs keep `path` so `/Users/...` is
 * unchanged on macOS and Linux.
 * @param {string} raw
 * @returns {path.PlatformPath}
 */
function pathApiFor(raw) {
  const windowsShaped =
    /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.includes('\\')
  return windowsShaped ? path.win32 : path
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isFilesystemPath(raw) {
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return true
  if (raw.startsWith('/') || raw.startsWith('\\\\')) return true
  if (raw.startsWith('.') && (raw.includes('/') || raw.includes('\\'))) return true
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return true
  // A backslash is never a display slug.
  if (raw.includes('\\')) return true
  return false
}
/** Resolved-path -> repo root cache: the git fork is the only expensive
 *  step here and repo roots do not move during a server's lifetime. */
const pathCache = new Map()

/**
 * @param {string} abs
 * @param {path.PlatformPath} api
 * @returns {string} main repo root, or abs itself outside a repo
 */
function repoRoot(abs, api) {
  const cached = pathCache.get(abs)
  if (cached !== undefined) return cached
  let root = abs
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', abs, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    ).trim()
    // <main repo>/.git -> <main repo>
    if (commonDir && api.basename(api.dirname(commonDir))) root = api.dirname(commonDir)
  } catch {
    // not a repo, git missing, or timeout: fall through to the path itself
  }
  pathCache.set(abs, root)
  return root
}

/**
 * Registered key for a repo root, claiming one on first sight.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} root
 * @param {string} base
 * @returns {string}
 */
export function rootKey(db, root, base) {
  const known = db.prepare(`SELECT key FROM project_roots WHERE root = ?`).get(root)
  if (known) return String(known.key)
  const taken = db.prepare(`SELECT 1 FROM project_roots WHERE key = ?`).get(base)
  const key = taken
    ? `${base}-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 6)}`
    : base
  db.prepare(
    `INSERT OR IGNORE INTO project_roots (root, key, created_at) VALUES (?, ?, ?)`,
  ).run(root, key, new Date().toISOString())
  // OR IGNORE: a concurrent claim won; re-read so both callers agree.
  const row = db.prepare(`SELECT key FROM project_roots WHERE root = ?`).get(root)
  return row ? String(row.key) : key
}

/**
 * @param {unknown} value
 * @param {import('node:sqlite').DatabaseSync} [db] registry; without it a
 *   path maps to its bare basename (pre-#179 behaviour).
 * @returns {string | null}
 */
export function canonicalProject(value, db) {
  if (value == null) return null
  const raw = String(value).trim()
  if (raw === '' || raw.toLowerCase() === 'global') return null

  // Path-like: resolve to the MAIN repo root so every worktree of a repo
  // shares one identity. Windows agents send `C:\...` and UNC paths, which
  // have no forward slash and must not be stored as the whole string.
  if (isFilesystemPath(raw)) {
    const api = pathApiFor(raw)
    const abs = raw.startsWith('~')
      ? api.join(process.env.HOME || process.env.USERPROFILE || '', raw.slice(1))
      : api.resolve(raw)
    const root = repoRoot(abs, api)
    const base = api.basename(root) || null
    if (!base || !db) return base
    return rootKey(db, root, base)
  }

  // Display slug like "owner/repo": keep the repo half.
  if (raw.includes('/')) {
    const tail = raw.split('/').filter(Boolean).pop()
    return tail || null
  }
  return raw
}
