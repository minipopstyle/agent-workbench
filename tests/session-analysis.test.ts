import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeRun } from '../server/run-analysis.ts'
import { buildSessionAnalysis } from '../src/features/runs/session-analysis.ts'

const descriptor: any = { id: 'analysis-test', source: 'codex', parentId: null, projectPath: '/tmp', model: 'test', startedAt: '', updatedAt: '', status: 'complete', childCount: 0 }
const event = (at: number, type: string, payload: Record<string, unknown>) => ({ timestamp: `2026-08-20T10:00:${String(at).padStart(2, '0')}.000Z`, type, payload })

test('normalizes failure, waste, runtime rate and partial outcome', () => {
  const events = [
    event(0, 'session_meta', { id: descriptor.id }), event(1, 'event_msg', { type: 'task_started', turn_id: 'one' }),
    event(2, 'response_item', { type: 'custom_tool_call', call_id: 'a', name: 'exec', input: '{"command":"npm test"}' }),
    event(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'a', output: 'failed', exit_code: 1 }),
    event(4, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: 'npm test', exit_code: 1, aggregated_output: 'failed' } }),
    event(5, 'event_msg', { type: 'task_complete', turn_id: 'one' }),
  ]
  const analysis = buildSessionAnalysis(analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'one' }))
  assert.equal(analysis.outcome, 'partial')
  assert.equal(analysis.failedToolCalls, 1)
  assert.equal(analysis.runtime[0].failureRate, 1)
})

test('maps observed tool events onto real model-call token points', () => {
  const events = [
    event(0, 'session_meta', { id: descriptor.id }), event(1, 'event_msg', { type: 'task_started', turn_id: 'markers' }),
    event(2, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 80 } } }),
    event(3, 'response_item', { type: 'custom_tool_call', call_id: 'read', name: 'exec', input: '{"command":"cat src/app.ts"}' }),
    event(4, 'response_item', { type: 'custom_tool_call_output', call_id: 'read', output: 'ok' }),
    event(5, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 120 } } }), event(6, 'event_msg', { type: 'task_complete', turn_id: 'markers' }),
  ]
  const analysis = buildSessionAnalysis(analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'markers' }))
  assert.equal(analysis.tokenPoints.length, 2)
  assert.ok(analysis.tokenMarkers.some(marker => marker.kind === 'read'))
})
