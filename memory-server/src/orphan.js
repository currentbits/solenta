/**
 * Windows does not update `process.ppid` after the parent exits, so a
 * ppid compare never fires there. `kill(pid, 0)` is an existence check.
 * EPERM means the pid is alive and owned by someone else.
 * @param {number} parent
 * @returns {boolean}
 */
function parentStillAlive(parent) {
  try {
    process.kill(parent, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

/**
 * Exit once our parent is gone. macOS reparents an orphan to launchd instead
 * of killing it, so a crashed or force-quit app would otherwise leak this
 * server (port + memory) until reboot. Compares against the starting ppid
 * rather than 1, so a Linux subreaper counts as death too. On Windows the
 * ppid stays stale, so a dead parent pid is also death.
 * @param {number} [intervalMs]
 * @returns {NodeJS.Timeout | null} null when there is no parent to watch
 */
export function exitWhenOrphaned(intervalMs = 5000) {
  const parent = process.ppid
  if (parent <= 1) return null // launched by init/launchd: already parentless
  const timer = setInterval(() => {
    if (process.ppid !== parent || !parentStillAlive(parent)) process.exit(0)
  }, intervalMs)
  timer.unref()
  return timer
}
