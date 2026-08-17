/**
 * Fail-open loader for electron/guardrails.js (CJS) from this ESM package.
 *
 * Same relative layout in the repo and the packaged app:
 *   memory-server/src/  →  ../../electron/guardrails.js
 * createRequire (not a static import) so a missing file cannot take down
 * the memory server. Logs once on load failure.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** @type {(text: string) => { hits: { rule: string, match: string }[], clean: boolean }} */
let scanInjectionImpl = () => ({ hits: [], clean: true })
let loadLogged = false

try {
  // CJS module.exports is the ESM default: `import guardrails from '…'`
  const guardrails = require('../../electron/guardrails.js')
  if (typeof guardrails?.scanInjection === 'function') {
    scanInjectionImpl = guardrails.scanInjection
  } else if (!loadLogged) {
    loadLogged = true
    console.error('guardrails loaded without scanInjection; memory writes will not be scanned')
  }
} catch (err) {
  if (!loadLogged) {
    loadLogged = true
    console.error(
      'guardrails unavailable; memory writes will not be scanned:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * @param {string} text
 * @returns {{ hits: { rule: string, match: string }[], clean: boolean }}
 */
export function scanInjection(text) {
  try {
    const result = scanInjectionImpl(text)
    if (result && Array.isArray(result.hits)) return result
    return { hits: [], clean: true }
  } catch (err) {
    console.error(
      'scanInjection failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
    return { hits: [], clean: true }
  }
}

/**
 * Reject an agent-written (MCP) memory entry that matches injection patterns.
 * @param {string} title
 * @param {string} body
 */
export function rejectInjectedMemory(title, body) {
  const result = scanInjection(`${title || ''}\n${body || ''}`)
  if (result.clean || result.hits.length === 0) return
  const details = result.hits.map((h) => `${h.rule}: "${h.match}"`).join(', ')
  throw new Error(
    `Rejected by Solenta guardrails: this entry matches prompt-injection patterns (${details}). Memory is shared across agents; rephrase as a description rather than an instruction, or store it via the app.`,
  )
}
