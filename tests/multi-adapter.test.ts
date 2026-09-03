import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AdapterRegistry } from '../server/adapters/registry.js'
import { WorkBuddyAdapter } from '../server/adapters/workbuddy.js'
import { ClaudeAdapter } from '../server/adapters/claude.js'
import { CodexAdapter } from '../server/adapters/codex.js'

test('AdapterRegistry registers all agent adapters and aggregates sources', async () => {
  const registry = new AdapterRegistry()
  const sources = registry.all().map(a => a.source)
  assert.ok(sources.includes('codex'), 'should include codex')
  assert.ok(sources.includes('workbuddy'), 'should include workbuddy')
  assert.ok(sources.includes('claude'), 'should include claude')

  const detected = await registry.detectAll()
  assert.equal(detected.length, 3, 'should detect all 3 adapters')

  const wb = detected.find(d => d.id === 'workbuddy')
  assert.ok(wb, 'workbuddy detection should exist')
})

test('WorkBuddyAdapter handles discovery and snapshot generation', async () => {
  const adapter = new WorkBuddyAdapter()
  const detected = await adapter.detect()
  const sessions = await adapter.discover(true)
  assert.ok(detected.status === 'ready' || detected.status === 'not_found')
  if (sessions.length > 0) {
    const s0 = sessions[0]
    const snap = await adapter.snapshot(s0.id)
    assert.ok(snap.descriptor.id === s0.id)
    assert.ok(snap.runs && snap.runs.length > 0)
    const turn0 = snap.runs[0]
    const analysis = await adapter.run(s0.id, turn0.ref.turnId)
    assert.ok(analysis.observable.durationMs >= 0)
    assert.ok(analysis.identity.model)
    assert.ok(analysis.v2)
  }
})

test('WorkBuddyAdapter preserves turns, tool categories, and deduplicated usage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-adapter-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'projects', 'fixture')
  await fs.mkdir(project, { recursive: true })
  const usage = (requestId: string, inputTokens: number, outputTokens: number) => ({ model: 'kimi-k2.7', conversationRequestId: requestId, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, inputTokensDetails: [{ cached_tokens: 20 }], outputTokensDetails: [{ reasoning_tokens: 5 }] } })
  const events = [
    { id: 'turn-1', sessionId: 'session-1', type: 'message', role: 'user', content: 'first', timestamp: '2026-01-01T00:00:00.000Z' },
    { id: 'call-1', callId: 'call-1', sessionId: 'session-1', type: 'function_call', name: 'Read', arguments: { path: 'a.ts' }, providerData: usage('request-1', 80, 10), timestamp: '2026-01-01T00:00:01.000Z' },
    { id: 'result-1', callId: 'call-1', sessionId: 'session-1', type: 'function_call_result', output: 'ok', timestamp: '2026-01-01T00:00:02.000Z' },
    { id: 'answer-1', sessionId: 'session-1', type: 'message', role: 'assistant', content: 'done', providerData: usage('request-1', 80, 10), timestamp: '2026-01-01T00:00:03.000Z' },
    { id: 'turn-2', sessionId: 'session-1', type: 'message', role: 'user', content: 'second', timestamp: '2026-01-01T00:00:04.000Z' },
    { id: 'call-2', callId: 'call-2', sessionId: 'session-1', type: 'function_call', name: 'Bash', arguments: { command: 'npm test' }, providerData: usage('request-2', 100, 20), timestamp: '2026-01-01T00:00:05.000Z' },
    { id: 'result-2', callId: 'call-2', sessionId: 'session-1', type: 'function_call_result', output: 'ok', timestamp: '2026-01-01T00:00:06.000Z' },
    { id: 'answer-2', sessionId: 'session-1', type: 'message', role: 'assistant', content: 'done', providerData: usage('request-2', 100, 20), timestamp: '2026-01-01T00:00:07.000Z' },
  ]
  await fs.writeFile(path.join(project, 'session-1.jsonl'), events.map(event => JSON.stringify(event)).join('\n'))

  const adapter = new WorkBuddyAdapter(root)
  const session = (await adapter.discover(true))[0]
  const turns = await adapter.turns(session.id)
  assert.equal(turns[0].status, 'complete')
  const analysis = await adapter.run(session.id, 'turn-2')
  assert.deepEqual(analysis.observable.tokens, { input: 100, cachedInput: 20, uncachedInput: 80, output: 20, reasoning: 5, total: 120 })
  assert.equal(analysis.v2.modelCalls.length, 1)
  assert.equal(analysis.observable.tools[0].category, 'Shell')
  assert.ok(analysis.v2.steps.length > 0)
})

test('WorkBuddyAdapter derives GLM-5.2 context pressure from its known window', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-context-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'projects', 'fixture')
  await fs.mkdir(project, { recursive: true })
  const providerData = { model: 'glm-5.2', conversationRequestId: 'request-1', usage: { inputTokens: 44568, outputTokens: 355, totalTokens: 44923 } }
  const events = [
    { id: 'turn-1', sessionId: 'session-1', type: 'message', role: 'user', content: 'first', timestamp: '2026-01-01T00:00:00.000Z' },
    { id: 'answer-1', sessionId: 'session-1', type: 'message', role: 'assistant', content: 'done', providerData, timestamp: '2026-01-01T00:00:01.000Z' },
  ]
  await fs.writeFile(path.join(project, 'session-1.jsonl'), events.map(event => JSON.stringify(event)).join('\n'))

  const adapter = new WorkBuddyAdapter(root)
  const session = (await adapter.discover(true))[0]
  const analysis = await adapter.run(session.id, 'turn-1')
  assert.equal(analysis.v2.modelCalls[0].contextRatio, 0.044568)
  assert.equal(analysis.observable.context.peakRatio, 0.044568)
})

test('WorkBuddyAdapter keeps progressive usage snapshots from one WorkBuddy request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-progressive-usage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'projects', 'fixture')
  await fs.mkdir(project, { recursive: true })
  const usage = (inputTokens: number, outputTokens: number) => ({ model: 'glm-5.2', conversationRequestId: 'conversation-1', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } })
  const events = [
    { id: 'turn-1', sessionId: 'session-1', type: 'message', role: 'user', content: 'first', timestamp: '2026-01-01T00:00:00.000Z' },
    { id: 'call-1', sessionId: 'session-1', type: 'function_call', name: 'Bash', providerData: usage(100, 10), timestamp: '2026-01-01T00:00:01.000Z' },
    { id: 'call-2', sessionId: 'session-1', type: 'function_call', name: 'Bash', providerData: usage(200, 20), timestamp: '2026-01-01T00:00:02.000Z' },
    { id: 'answer-1', sessionId: 'session-1', type: 'message', role: 'assistant', content: 'done', providerData: usage(200, 20), timestamp: '2026-01-01T00:00:03.000Z' },
  ]
  await fs.writeFile(path.join(project, 'session-1.jsonl'), events.map(event => JSON.stringify(event)).join('\n'))

  const adapter = new WorkBuddyAdapter(root)
  const session = (await adapter.discover(true))[0]
  const analysis = await adapter.run(session.id, 'turn-1')
  assert.equal(analysis.v2.modelCalls.length, 2)
  assert.deepEqual(analysis.v2.modelCalls.map(call => call.input), [100, 200])
  assert.equal(analysis.observable.context.points.length, 2)
})

test('ClaudeAdapter handles discovery', async () => {
  const adapter = new ClaudeAdapter()
  const detected = await adapter.detect()
  console.log('Claude detection:', detected)
  const sessions = await adapter.discover(true)
  console.log('Claude sessions found:', sessions.length)
})

test('ClaudeAdapter ignores non-session JSON and keeps tool results in the active turn', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-adapter-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'projects', 'fixture')
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(root, 'mcp-needs-auth-cache.json'), JSON.stringify({ plugin: 'cache' }))
  const events = [
    { type: 'user', uuid: 'turn-1', sessionId: 'session-1', userType: 'external', message: { role: 'user', content: 'first' }, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/project' },
    { type: 'assistant', uuid: 'assistant-1', sessionId: 'session-1', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'thinking', thinking: 'inspect project' }, { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 10 } }, timestamp: '2026-01-01T00:00:01.000Z' },
    { type: 'user', uuid: 'result-1', sessionId: 'session-1', userType: 'external', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] }, timestamp: '2026-01-01T00:00:02.000Z' },
    { type: 'assistant', uuid: 'assistant-2', sessionId: 'session-1', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-01-01T00:00:03.000Z' },
    { type: 'user', uuid: 'turn-2', sessionId: 'session-1', userType: 'external', message: { role: 'user', content: 'second' }, timestamp: '2026-01-01T00:00:04.000Z' },
    { type: 'assistant', uuid: 'assistant-3', sessionId: 'session-1', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'finished' }] }, timestamp: '2026-01-01T00:00:05.000Z' },
  ]
  await fs.writeFile(path.join(project, 'session-1.jsonl'), events.map(event => JSON.stringify(event)).join('\n'))

  const adapter = new ClaudeAdapter(root)
  const sessions = await adapter.discover(true)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, 'session-1')
  const turns = await adapter.turns('session-1')
  assert.equal(turns.length, 2)
  assert.equal(turns[0].ref.turnId, 'turn-1')
  const analysis = await adapter.run('session-1', 'turn-1')
  assert.equal(analysis.observable.tools.length, 1)
  assert.equal(analysis.observable.tools[0].status, 'success')
  assert.ok(analysis.v2.steps.length > 0)
  assert.equal(analysis.v2.steps[0].reasoningCount, 1)
  assert.deepEqual(analysis.observable.tokens, { input: 105, cachedInput: 20, uncachedInput: 80, output: 10, reasoning: 0, total: 115 })
  assert.equal(analysis.observable.promptFootprint.find(item => item.category === 'tools')?.known, true)
})

test('CodexAdapter handles discovery', async () => {
  const adapter = new CodexAdapter()
  console.log('Codex root:', adapter.root)
  const detected = await adapter.detect()
  console.log('Codex detection:', detected)
  const sessions = await adapter.discover(true)
  console.log('Codex sessions found:', sessions.length)
})
