/**
 * Exit once our parent is gone. macOS reparents an orphan to launchd instead
 * of killing it, so a crashed or force-quit app would otherwise leak this
 * server (port + memory) until reboot. Compares against the starting ppid
 * rather than 1, so a Linux subreaper counts as death too.
 * @param {number} [intervalMs]
 * @returns {NodeJS.Timeout | null} null when there is no parent to watch
 */
export function exitWhenOrphaned(intervalMs = 5000) {
  const parent = process.ppid
  if (parent <= 1) return null // launched by init/launchd: already parentless
  const timer = setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, intervalMs)
  timer.unref()
  return timer
}
