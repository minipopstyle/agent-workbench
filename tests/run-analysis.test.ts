import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeRun, currentSessionStatus, suggestedTaskSimilarity, turnsFor } from '../server/run-analysis.ts'
import { compareRuns } from '../server/compare.ts'
import { buildTaskDiagnostics } from '../server/diagnostics.ts'
import type { SessionDescriptor } from '../server/types.ts'

const descriptor: SessionDescriptor = { id: '11111111-1111-4111-8111-111111111111', source: 'codex', parentId: null, projectPath: '/tmp/demo', model: 'gpt-test', startedAt: '2026-08-20T10:00:00.000Z', updatedAt: '2026-08-20T10:01:00.000Z', status: 'live', childCount: 0 }
const event = (at: number, type: string, payload: Record<string, unknown>) => ({ timestamp: `2026-08-20T10:00:${String(at).padStart(2, '0')}.000Z`, type, payload })
const events = [
  event(0, 'session_meta', { id: descriptor.id, model: 'gpt-test' }),
  event(1, 'event_msg', { type: 'user_message', message: 'First task' }),
  event(2, 'event_msg', { type: 'task_started', turn_id: 'one' }),
  event(3, 'turn_context', { turn_id: 'one', model: 'gpt-one', effort: 'low' }),
  event(4, 'response_item', { type: 'custom_tool_call', call_id: 'tool-1', name: 'exec', input: '{"command":"npm test"}' }),
  event(5, 'response_item', { type: 'custom_tool_call_output', call_id: 'tool-1', output: 'ok' }),
  event(5, 'response_item', { type: 'message', content: [{ type: 'output_text', text: 'First completed output' }] }),
  event(6, 'event_msg', { type: 'task_complete', turn_id: 'one', time_to_first_token_ms: 20 }),
  event(30, 'event_msg', { type: 'user_message', message: 'Second task' }),
  event(31, 'event_msg', { type: 'task_started', turn_id: 'two' }),
  event(32, 'turn_context', { turn_id: 'two', model: 'gpt-two', effort: 'high' }),
  event(33, 'response_item', { type: 'custom_tool_call', call_id: 'tool-2', name: 'exec', input: '{"command":"rg TODO"}' }),
  event(34, 'response_item', { type: 'custom_tool_call_output', call_id: 'tool-2', output: 'ok' }),
]

test('segments independent turns and leaves only the latest unfinished turn live', () => {
  const turns = turnsFor(events, 'codex', descriptor.id)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].status, 'complete')
  assert.equal(turns[0].model, 'gpt-one')
  assert.equal(turns[1].status, 'live')
  assert.equal(turns[1].model, 'gpt-two')
  assert.equal(turns[1].durationMs, 3000)
  assert.equal(currentSessionStatus(events), 'live')
})

test('modern UserMessage recorded after task_started still names the run', () => {
  const modern = [event(0, 'session_meta', { id: descriptor.id }), event(1, 'event_msg', { type: 'task_started', turn_id: 'modern' }), event(2, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: 'Modern task' } }), event(3, 'event_msg', { type: 'task_complete', turn_id: 'modern' })]
  assert.equal(turnsFor(modern, 'codex', descriptor.id)[0].title, 'Modern task')
})

test('run analysis is turn-local and does not include inter-turn idle time', () => {
  const analysis = analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'two' })
  assert.equal(analysis.identity.title, 'Second task')
  assert.equal(analysis.identity.status, 'live')
  assert.equal(analysis.observable.durationMs, 3000)
  assert.equal(analysis.observable.tools.length, 1)
  assert.equal(analysis.observable.tools[0].name, 'exec')
  assert.equal(analysis.coverage.tokenUsageKnown, false)
})

test('controlled comparison attributes an isolated harness change without a composite score', () => {
  const baseline = analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'one' })
  const candidate = { ...baseline, identity: { ...baseline.identity, harness: { ...baseline.identity.harness, version: '0.150' } } }
  const comparison = compareRuns(baseline, candidate, true, 'First task')
  assert.equal(comparison.mode, 'controlled')
  assert.equal(comparison.attribution.type, 'harness')
  assert.equal('score' in comparison, false)
})

test('comparison attributes model changes and rejects mixed variables or unconfirmed tasks', () => {
  const baseline = analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'one' })
  const modelOnly = { ...baseline, identity: { ...baseline.identity, modelIdentity: { ...baseline.identity.modelIdentity, model: 'gpt-next' }, model: 'gpt-next' } }
  assert.equal(compareRuns(baseline, modelOnly, true, 'First task').attribution.type, 'model')
  const mixed = { ...modelOnly, identity: { ...modelOnly.identity, harness: { ...modelOnly.identity.harness, version: '0.150' } } }
  assert.equal(compareRuns(baseline, mixed, true, 'First task').attribution.type, 'inconclusive')
  assert.equal(compareRuns(baseline, modelOnly, false).attribution.validity, 'invalid')
  const environmentOnly = { ...baseline, identity: { ...baseline.identity, environment: { ...baseline.identity.environment, cwd: '/tmp/other' } } }
  assert.equal(compareRuns(baseline, environmentOnly, true, 'First task').attribution.type, 'environment')
  const unknownBaseline = { ...baseline, identity: { ...baseline.identity, environment: { ...baseline.identity.environment, cwd: null, os: null, sandbox: null } } }
  const unknownEnvironment = { ...unknownBaseline, identity: { ...unknownBaseline.identity, modelIdentity: { ...unknownBaseline.identity.modelIdentity, model: 'gpt-next' } } }
  assert.equal(compareRuns(unknownBaseline, unknownEnvironment, true, 'First task').attribution.validity, 'weak')
})

test('task diagnostics creates a baseline trend without serializing full traces', () => {
  const baseline = analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'one' })
  const current = { ...baseline, ref: { ...baseline.ref, turnId: 'current' }, identity: { ...baseline.identity, harness: { ...baseline.identity.harness, version: '0.150' } } }
  const diagnostics = buildTaskDiagnostics('First task', [baseline, current], baseline.ref)
  assert.equal(diagnostics.entries.length, 2)
  assert.equal(diagnostics.comparisons[0].attribution.type, 'harness')
  assert.equal('v2' in diagnostics.entries[0], false)
})

test('evaluation evidence prefers the actual assistant output over duplicate event messages', () => {
  const analysis = analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'one' })
  assert.equal(analysis.evidence.finalOutput, 'First completed output')
})

test('task completion alone is not a successful outcome, while observed test success is', () => {
  const completed = analyzeRun(events, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'one' })
  assert.equal(completed.outcome.status, 'unknown')
  const passing = analyzeRun([...events, event(7, 'response_item', { type: 'custom_tool_call', call_id: 'test', name: 'exec', input: '{"command":"npm test"}' }), event(8, 'response_item', { type: 'custom_tool_call_output', call_id: 'test', output: 'ok', exit_code: 0 })], descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'one' })
  assert.equal(passing.outcome.status, 'success')
  assert.ok(passing.outcome.evidence?.some(item => item.type === 'test' && item.status === 'passed'))
})

test('modern command evidence ignores outer patch text and uses the latest retry result', () => {
  const modern = [event(0, 'session_meta', { id: descriptor.id }), event(1, 'event_msg', { type: 'task_started', turn_id: 'commands' }), event(2, 'response_item', { type: 'custom_tool_call', call_id: 'outer', name: 'exec', input: 'tools.apply_patch("npm run build")' }), event(3, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'read', command: 'sed -n 1p tests/example.ts', exit_code: 0 } }), event(4, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'server', command: 'npm run server', exit_code: 0 } }), event(5, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'first', command: 'npm test', exit_code: 1, aggregated_output: 'failed' } }), event(6, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'second', command: ['/bin/zsh', '-lc', 'npm test'], exit_code: 0, aggregated_output: 'passed' } }), event(7, 'event_msg', { type: 'task_complete', turn_id: 'commands' })]
  const analysis = analyzeRun(modern, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'commands' })
  assert.equal(analysis.outcome.status, 'success')
  assert.equal(analysis.outcome.evidence?.some(item => item.type === 'build'), false)
  assert.equal(analysis.outcome.evidence?.filter(item => item.type === 'test').length, 1)
  assert.equal(analysis.outcome.evidence?.find(item => item.type === 'test')?.status, 'passed')
})

test('repeated calls and same-call failures become behavioral signals', () => {
  const signalEvents = [event(0, 'session_meta', { id: descriptor.id }), event(1, 'event_msg', { type: 'task_started', turn_id: 'signals' }), event(2, 'response_item', { type: 'custom_tool_call', call_id: 'a', name: 'exec', input: '{"command":"cat src/a.ts"}' }), event(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'a', output: 'error', exit_code: 1 }), event(4, 'response_item', { type: 'custom_tool_call', call_id: 'b', name: 'exec', input: '{"command":"cat src/a.ts"}' }), event(5, 'response_item', { type: 'custom_tool_call_output', call_id: 'b', output: 'ok', exit_code: 0 }), event(6, 'event_msg', { type: 'task_complete', turn_id: 'signals' })]
  const analysis = analyzeRun(signalEvents, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'signals' })
  assert.ok(analysis.behavioralSignals.some(signal => signal.type === 'repeated_read'))
  assert.ok(analysis.behavioralSignals.some(signal => signal.type === 'mechanical_retry'))
})

test('prompt footprint measures logged sources without mislabeling cumulative model input', () => {
  const withTokens = [event(0, 'session_meta', { id: descriptor.id, base_instructions: { text: 'developer rules' } }), event(0, 'world_state', { state: { host_skills: { body: 'skill catalog' }, permissions: { sandbox: 'workspace' } } }), ...events.slice(1), event(35, 'event_msg', { type: 'token_count', info: { model_context_window: 1000, last_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 10, total_tokens: 130 } } })]
  const analysis = analyzeRun(withTokens, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'two' })
  assert.equal(analysis.observable.tokens.input, 120)
  assert.ok(analysis.observable.promptFootprint.find(item => item.category === 'developer')?.known)
  assert.ok(analysis.observable.promptFootprint.find(item => item.category === 'skills')?.known)
  assert.notEqual(analysis.observable.promptFootprint.reduce((sum, item) => sum + item.estimatedTokens, 0), 120)
})

test('harness activity records MCP, web discovery, and skill activation separately', () => {
  const observed = [event(0, 'session_meta', { id: descriptor.id }), event(1, 'event_msg', { type: 'task_started', turn_id: 'harness' }), event(2, 'response_item', { type: 'function_call', call_id: 'mcp-1', name: 'search', arguments: '{"path":"/tmp/skills/playwright/SKILL.md"}' }), event(3, 'response_item', { type: 'function_call_output', call_id: 'mcp-1', output: 'ok' }), event(3, 'event_msg', { type: 'mcp_tool_call_end', call_id: 'mcp-1', invocation: { server: 'codegraph', tool: 'search' } }), event(4, 'response_item', { type: 'tool_search_call', call_id: 'discover' }), event(5, 'response_item', { type: 'web_search_call', id: 'web-1' }), event(6, 'event_msg', { type: 'web_search_end', call_id: 'web-1' }), event(7, 'event_msg', { type: 'task_complete', turn_id: 'harness' })]
  const analysis = analyzeRun(observed, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'harness' })
  assert.equal(analysis.observable.harnessActivity.mcpCalls, 1)
  assert.equal(analysis.observable.harnessActivity.webSearches, 1)
  assert.equal(analysis.observable.harnessActivity.toolDiscoveries, 1)
  assert.deepEqual(analysis.observable.harnessActivity.skillsUsed, ['playwright'])
})

test('adaptive recovery requires a changed strategy on the same target', () => {
  const recoveryEvents = [
    event(0, 'session_meta', { id: descriptor.id }), event(1, 'event_msg', { type: 'task_started', turn_id: 'recover' }),
    event(2, 'response_item', { type: 'custom_tool_call', call_id: 'bad', name: 'exec', input: '{"command":"cat src/a.ts"}' }), event(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'bad', output: 'error: missing' }),
    event(4, 'response_item', { type: 'custom_tool_call', call_id: 'good', name: 'exec', input: '{"command":"sed -n 1p src/a.ts"}' }), event(5, 'response_item', { type: 'custom_tool_call_output', call_id: 'good', output: 'ok' }),
    event(6, 'response_item', { type: 'custom_tool_call', call_id: 'other', name: 'exec', input: '{"command":"sed -n 1p src/b.ts"}' }), event(7, 'response_item', { type: 'custom_tool_call_output', call_id: 'other', output: 'ok' }), event(8, 'event_msg', { type: 'task_complete', turn_id: 'recover' }),
  ]
  const analysis = analyzeRun(recoveryEvents, descriptor, { source: 'codex', sessionId: descriptor.id, turnId: 'recover' })
  assert.equal(analysis.observable.trajectory.adaptiveRecoveries, 1)
})

test('task suggestions use normalized trigram similarity', () => {
  assert.equal(suggestedTaskSimilarity('修复 登录 页面', '修复　登录 页面'), 1)
  assert.ok(suggestedTaskSimilarity('修复登录页面测试', '修复登录页面测试 ') >= 0.82)
  assert.ok(suggestedTaskSimilarity('修复登录页面', '翻译营销文案') < 0.82)
})
