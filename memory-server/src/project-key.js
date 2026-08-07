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
 *   /…/AgentMux/worktrees/coder-174dfbde (linked) -> "coder"   (via git-common-dir)
 *   "owner/coder"                                 -> "coder"   (display slug)
 *   "coder"                                       -> "coder"
 *   null / "" / "global"                          -> null      (global scope)
 *
 * Non-path values never touch the filesystem, so this stays cheap for the
 * common case. Git failures degrade to the path basename rather than throwing.
 */
/** Resolved-path -> canonical key cache: the git fork is the only expensive
 *  step here and repo roots do not move during a server's lifetime. */
const pathCache = new Map()

export function canonicalProject(value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (raw === '' || raw.toLowerCase() === 'global') return null

  // Path-like: resolve to the MAIN repo root so every worktree of a repo
  // shares one identity.
  if (raw.includes('/') && (raw.startsWith('/') || raw.startsWith('~') || raw.startsWith('.'))) {
    const abs = raw.startsWith('~')
      ? path.join(process.env.HOME || '', raw.slice(1))
      : path.resolve(raw)
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
        const root = path.dirname(commonDir)
        const base = path.basename(root)
        if (base) {
          pathCache.set(abs, base)
          return base
        }
      }
    } catch {
      // not a repo, git missing, or timeout: fall through to basename
    }
    const base = path.basename(abs) || null
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
