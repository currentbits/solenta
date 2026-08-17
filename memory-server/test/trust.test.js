import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trustFactor, TRUST_MIN, TRUST_MAX } from '../src/trust.js'

test('trustFactor is neutral without evidence', () => {
  assert.equal(trustFactor(), 1)
  assert.equal(trustFactor({ helpful: 0, harmful: 0, invalidated: 0 }), 1)
})

test('trustFactor rewards helpful and punishes harmful/invalidated', () => {
  assert.ok(trustFactor({ helpful: 4 }) > 1)
  assert.ok(trustFactor({ harmful: 2 }) < 1)
  assert.ok(trustFactor({ invalidated: 2 }) < 1)
  // A wrong memory costs more than a right one earns.
  assert.ok(trustFactor({ helpful: 2, harmful: 2 }) < 1)
})

test('trustFactor clamps at both ends', () => {
  assert.equal(trustFactor({ helpful: 1000 }), TRUST_MAX)
  assert.equal(trustFactor({ harmful: 1000, invalidated: 1000 }), TRUST_MIN)
})
