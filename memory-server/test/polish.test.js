import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Memory } from '../src/memory.js'
import { fakeEmbedder } from '../src/embedder.js'
import { runJanitor } from '../src/janitor.js'

const BODY =
  'shared duplicate corpus alpha beta gamma delta epsilon zeta eta theta iota kappa'

describe('round-22 polish', () => {
  let dir
  let memory

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-mem-polish-'))
    memory = new Memory(path.join(dir, 'mem.db'), { embedder: fakeEmbedder(8) })
  })

  afterEach(() => {
    memory.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('cross-scope dedup rule', () => {
    it('same-project duplicate still BLOCKS', () => {
      memory.store({ type: 'knowledge', title: 'Dup base', body: BODY, project: 'p1' })
      assert.throws(
        () =>
          memory.store({ type: 'knowledge', title: 'Dup base', body: BODY, project: 'p1' }),
        /near-duplicate/,
      )
    })

    it('both-global duplicate still BLOCKS', () => {
      memory.store({ type: 'knowledge', title: 'Dup base', body: BODY })
      assert.throws(
        () => memory.store({ type: 'knowledge', title: 'Dup base', body: BODY }),
        /near-duplicate/,
      )
    })

    it('cross-scope entries are not compared at all (no block, no queue)', () => {
      // Memory is project-scoped: a GLOBAL entry and a PROJECT entry never
      // interact, so an identical body is neither refused nor flagged.
      const g = memory.store({ type: 'convention', title: 'Dup base', body: BODY })
      const p = memory.store({
        type: 'knowledge',
        title: 'Dup base',
        body: BODY,
        project: 'p1',
      })
      assert.ok(p.id, 'a project write must not be blocked by a global entry')
      const open = memory.db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_queue
           WHERE resolved_at IS NULL
             AND ((entry_a = ? AND entry_b = ?) OR (entry_a = ? AND entry_b = ?))`,
        )
        .get(p.id, g.id, g.id, p.id).n
      assert.equal(open, 0, 'cross-scope pairs must not enter the review queue')
    })

    it('same-scope blockable candidate is not shadowed by a stronger cross-scope one', () => {
      // Global entry: very strong overlap with the incoming write.
      memory.store({ type: 'knowledge', title: 'Dup base', body: BODY })
      // Same-project entry: also above block threshold.
      memory.store({
        type: 'knowledge',
        title: 'Dup base variant',
        body: BODY + ' small tail difference here',
        project: 'p1',
      })
      assert.throws(
        () =>
          memory.store({
            type: 'knowledge',
            title: 'Dup base variant',
            body: BODY + ' small tail difference here',
            project: 'p1',
          }),
        /near-duplicate/,
      )
    })
  })

  describe('maintenance nearDupes ranking', () => {
    it('returns the strongest overlaps from the full window, not first-found', () => {
      // Two weaker duplicate pairs stored FIRST (more recent iteration order
      // would have found them first under the old first-N behavior). Distinct
      // vocab per pair so pairs do not overlap each other.
      memory.store({
        type: 'knowledge',
        title: 'weak pair apple a',
        body: 'apple orchard harvest cider press autumn basket ladder crate barn',
        force: true,
      })
      memory.store({
        type: 'knowledge',
        title: 'weak pair apple b',
        body: 'apple orchard harvest cider press winter jacket snowfall mitten scarf',
        force: true,
      })
      memory.store({
        type: 'knowledge',
        title: 'weak pair river a',
        body: 'river delta current salmon paddle canoe gravel eddy rapids portage',
        force: true,
      })
      memory.store({
        type: 'knowledge',
        title: 'weak pair river b',
        body: 'river delta current salmon paddle lantern compass tent firewood marshmallow',
        force: true,
      })
      // ...then one very strong pair stored last (oldest in recency-DESC scans
      // it is actually newest; either way it must surface at rank 1).
      memory.store({ type: 'knowledge', title: 'strong twin a', body: BODY, force: true })
      memory.store({ type: 'knowledge', title: 'strong twin b', body: BODY, force: true })

      const report = memory.maintenance({})
      assert.ok(report.nearDupes.length >= 1)
      const top = report.nearDupes[0]
      assert.ok(
        [top.a.title, top.b.title].every((t) => t.startsWith('strong twin')),
        `strongest pair must rank first, got ${JSON.stringify(report.nearDupes[0])}`,
      )
      for (let i = 1; i < report.nearDupes.length; i++) {
        assert.ok(report.nearDupes[i - 1].overlap >= report.nearDupes[i].overlap)
      }
    })
  })

  describe('janitor lastError', () => {
    it('is null on a clean run', () => {
      const snap = runJanitor(memory.db)
      assert.equal(snap.lastError, null)
    })

    it('captures a failing step and still completes the run', () => {
      // Break a table used by both the orphan sweep and the scan; the FIRST
      // failing step is recorded and the janitor still finishes.
      memory.db.exec('DROP TABLE mentions')
      const snap = runJanitor(memory.db)
      assert.ok(snap.lastError, 'expected lastError to be set')
      assert.ok(['orphans', 'contradictions'].includes(snap.lastError.step))
      assert.equal(typeof snap.lastError.message, 'string')
      assert.ok(snap.lastError.at)
      assert.ok(snap.lastRun, 'janitor must still complete the run')
    })
  })

  describe('deleteEntry groundwork', () => {
    it('removes the entry and every dependent row transactionally', async () => {
      const { id } = memory.store({
        type: 'knowledge',
        title: 'Deletable [[Widget]] fact',
        body: 'references src/widget.ts and the WidgetFactory module for delete tests',
      })
      memory.feedback({ id, verdict: 'helpful' })
      const other = memory.store({
        type: 'knowledge',
        title: 'Unrelated survivor',
        body: 'completely different content that stays alive',
        force: true,
      })

      assert.equal(memory.deleteEntry(id), true)

      assert.equal(memory.get(id), null)
      for (const [table, col] of [
        ['entry_vectors', 'entry_id'],
        ['mentions', 'entry_id'],
        ['edges', 'entry_id'],
        ['feedback_log', 'entry_id'],
      ]) {
        const n = memory.db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
          .get(id).n
        assert.equal(n, 0, `${table} must be clean`)
      }
      // FTS shadow gone. Checking search by id is NOT enough: with the row gone
      // from entries the join drops it either way. entries_fts is external-content
      // keyed by rowid and SQLite REUSES rowids, so an orphan shadow row makes the
      // next entry to take that rowid answer the deleted entry's words.
      const ftsLeft = memory.db
        .prepare('SELECT COUNT(*) AS n FROM entries_fts WHERE entries_fts MATCH ?')
        .get('Deletable').n
      assert.equal(ftsLeft, 0, 'entries_fts shadow row must be deleted')
      const hits = await memory.search({ query: 'Deletable Widget fact' })
      assert.ok(!hits.some((h) => h.id === id))
      // Unrelated entry untouched.
      assert.ok(memory.get(other.id))
    })

    it('returns false for unknown ids and refuses supersession targets', () => {
      assert.equal(memory.deleteEntry('nope'), false)
      const a = memory.store({
        type: 'knowledge',
        title: 'Old fact to supersede',
        body: 'original body of the soon superseded entry with words',
      })
      const b = memory.supersede(a.id, {
        title: 'New fact',
        body: 'corrected body of the successor entry with words',
      })
      assert.throws(() => memory.deleteEntry(b.id), /superseded_by/)
    })
  })
})
