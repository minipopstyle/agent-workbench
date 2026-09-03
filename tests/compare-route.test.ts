import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComparePath } from '../src/features/compare/compare-route.ts'

test('Sessions comparison link preserves WorkBuddy and Claude sources', () => {
  const params = new URL(buildComparePath(
    { id: 'workbuddy/session-a', source: 'workbuddy' },
    { id: 'claude:session-b', source: 'claude' },
  ), 'http://localhost').searchParams

  assert.deepEqual(Object.fromEntries(params), {
    baselineSource: 'workbuddy',
    baselineSession: 'workbuddy/session-a',
    candidateSource: 'claude',
    candidateSession: 'claude:session-b',
  })
})
