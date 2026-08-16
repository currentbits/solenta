import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const orphanPath = fileURLToPath(new URL('../src/orphan.js', import.meta.url))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('exitWhenOrphaned', () => {
  it('exits the server when its parent dies ungracefully', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-'))
    // Stands in for the memory server: guarded, and otherwise kept alive
    // forever (a listening socket in production). Prints once it is really up,
    // so a child that dies on startup can't pass this test by accident.
    const server = path.join(dir, 'server.mjs')
    fs.writeFileSync(
      server,
      `import { exitWhenOrphaned } from ${JSON.stringify(orphanPath)}\n` +
        `if (!exitWhenOrphaned(100)) throw new Error('guard not armed')\n` +
        `setInterval(() => {}, 1000)\n` +
        `console.log('up')\n`,
    )
    // Spawned exactly as the supervisor spawns it: not detached.
    const parent = path.join(dir, 'parent.mjs')
    fs.writeFileSync(
      parent,
      `import { spawn } from 'node:child_process'\n` +
        `const c = spawn(process.execPath, [${JSON.stringify(server)}], { stdio: ['ignore', 'inherit', 'inherit'] })\n` +
        `console.log(c.pid)\n` +
        `setInterval(() => {}, 1000)\n`,
    )

    const proc = spawn(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (c) => {
      out += c
    })
    const pid = () => Number(out.split('\n')[0])

    try {
      assert.ok(await waitFor(() => out.includes('up\n'), 10000), 'server never came up')
      assert.ok(alive(pid()), 'server not running')

      process.kill(proc.pid, 'SIGKILL')

      assert.ok(await waitFor(() => !alive(pid()), 10000), 'server survived its parent')
    } finally {
      for (const p of [proc.pid, pid()]) {
        try {
          if (p) process.kill(p, 'SIGKILL')
        } catch {
          // already dead
        }
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
