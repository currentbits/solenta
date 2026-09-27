import path from 'node:path'
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
/** Resolved-path -> canonical key cache: the git fork is the only expensive
 *  step here and repo roots do not move during a server's lifetime. */
const pathCache = new Map()

export function canonicalProject(value) {
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
    const cached = pathCache.get(abs)
    if (cached !== undefined) return cached
    try {
      const commonDir = execFileSync(
        'git',
        ['-C', abs, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
      ).trim()
      if (commonDir) {
        // <main repo>/.git -> <main repo>
        const root = api.dirname(commonDir)
        const base = api.basename(root)
        if (base) {
          pathCache.set(abs, base)
          return base
        }
      }
    } catch {
      // not a repo, git missing, or timeout: fall through to basename
    }
    const base = api.basename(abs) || null
    pathCache.set(abs, base)
    return base
  }

  // Display slug like "owner/repo": keep the repo half.
  if (raw.includes('/')) {
    const tail = raw.split('/').filter(Boolean).pop()
    return tail || null
  }
  return raw
}
