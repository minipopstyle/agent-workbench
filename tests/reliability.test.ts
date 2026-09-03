import assert from 'node:assert/strict'
import test from 'node:test'
import { reliabilityMetrics } from '../server/reliability.ts'

test('reliability exposes pass@k and pass^k only for available k', () => {
  const result = reliabilityMetrics([100, 40, 90])
  assert.equal(result.successes, 2)
  assert.ok(Math.abs((result.passAt[0].passAt || 0) - 2 / 3) < 1e-12)
  assert.equal(result.passAt[1].passAt, 1)
  assert.equal(result.passAt[2].passAt, 1)
  assert.equal(result.passAt[1].passPower, 4 / 9)
})

test('reliability marks k above observed runs unavailable', () => {
  const result = reliabilityMetrics([100])
  assert.equal(result.passAt[1].passAt, null)
  assert.equal(result.passAt[2].passPower, null)
})
