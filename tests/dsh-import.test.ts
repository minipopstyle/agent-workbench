import assert from 'node:assert/strict'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { detectSessionFormat, parseDshSession, parseJsonl, validateImportedSnapshot } from '../server/imports.ts'
import { CodexAdapter } from '../server/adapters/codex.ts'

const dshEvents = [
  { type: 'session', version: 0, id: 'session-1b082fde-84c9-4069-bc32-e647c079caa6', createdAt: 1787908440321, cwd: '/project', agentPreset: 'code' },
  { type: 'session/title', time: 1787908440421, data: { title: '临时标题' } },
  { type: 'session/title', time: 1787908440521, data: { title: '如何更新到最新版本' } },
  { type: 'request/context', time: 1787908440621, data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1_000_000 } },
  { type: 'turn/start', time: 1787908440721, data: { turn: 1 } },
  { type: 'user/message', time: 1787908440821, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '怎么更新？' }] } },
  { type: 'user/message', time: 1787908440921, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'runtime context' }] } },
  { type: 'step/start', time: 1787908441021, data: { turn: 1, step: 1 } },
  { type: 'tool/call', time: 1787908441121, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"echo ok"}' } },
  { type: 'tool/result', time: 1787908441221, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
  { type: 'step/end', time: 1787908441321, data: { turn: 1, step: 1 } },
  { type: 'assistant/chunk', time: 1787908441421, data: { text: '流式片段' } },
  { type: 'tool-call-chunks', time: 1787908441471, data: { callId: 'call-1', arguments: '{}' } },
  { type: 'assistant/message', time: 1787908441521, data: { message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: '请执行升级。' }] }, usage: { inputTokens: 10137, outputTokens: 299, cacheReadTokens: 0 } } },
  { type: 'turn/end', time: 1787908441621, data: { turn: 1, reason: { kind: 'interrupted' } } },
  { type: 'unknown/event', time: 1787908441721, data: {} },
]

test('detects and normalizes DeepSeek Harness JSONL without counting stream/plugin events', async () => {
  const parsed = parseJsonl(`${dshEvents.map(JSON.stringify).join('\n')}\nnot-json`)
  assert.equal(detectSessionFormat(parsed.events), 'deepseek-harness')
  assert.equal(parsed.malformedLines, 1)

  const result = parseDshSession(parsed.events, { importId: 'import-test', fileName: 'session.jsonl', malformedLines: parsed.malformedLines })
  assert.equal(result.trace.source.format, 'deepseek-harness')
  assert.equal(result.trace.id, 'session-1b082fde-84c9-4069-bc32-e647c079caa6')
  assert.equal(result.trace.source.sessionId, 'session-1b082fde-84c9-4069-bc32-e647c079caa6')
  assert.equal(result.trace.title, '如何更新到最新版本')
  assert.equal(result.trace.source.provider, 'deepseek-official')
  assert.equal(result.trace.source.model, 'deepseek-v4-flash')
  assert.equal(result.trace.status, 'interrupted')
  assert.equal(result.trace.stats.userMessages, 1)
  assert.equal(result.trace.stats.assistantMessages, 1)
  assert.equal(result.trace.stats.toolCalls, 1)
  assert.equal(result.trace.stats.toolResults, 1)
  assert.equal(result.trace.stats.inputTokens, 10137)
  assert.equal(result.diagnostics.ignoredEvents, 3)
  assert.equal(result.diagnostics.malformedLines, 1)

  const imported = await new CodexAdapter().importWithRuns('session.jsonl', Buffer.from(dshEvents.map(JSON.stringify).join('\n')).toString('base64'))
  assert.equal(imported.snapshot.normalized?.source.format, 'deepseek-harness')
  assert.equal(imported.snapshot.descriptor.nativeSessionId, 'session-1b082fde-84c9-4069-bc32-e647c079caa6')
  assert.equal(imported.snapshot.runs?.[0]?.status, 'aborted')
  const analysis = [...imported.analyses.values()][0]
  assert.ok(analysis)
  assert.equal(analysis.observable.tools.length, 1)
  assert.equal(analysis.observable.harnessActivity.assistantMessages, 1)
  assert.equal(analysis.identity.harness.family, 'deepseek-harness')
  assert.equal(analysis.identity.modelIdentity.provider, 'deepseek-official')
  assert.deepEqual(analysis.observable.tokens, { input: 10137, cachedInput: 0, uncachedInput: 10137, output: 299, reasoning: 0, total: 10436 })
  assert.equal(validateImportedSnapshot(imported.snapshot).valid, true)
  assert.equal(validateImportedSnapshot({ descriptor: imported.snapshot.descriptor, normalized: { ...result.trace, turns: [], stats: { ...result.trace.stats, userMessages: 0, assistantMessages: 0, toolCalls: 0 } } }).valid, false)
})

test('imports Zstd-compressed JSONL with the Node runtime', async () => {
  const compressed = zstdCompressSync(Buffer.from(dshEvents.map(JSON.stringify).join('\n')))
  const imported = await new CodexAdapter().importWithRuns('session.jsonl.zst', compressed.toString('base64'))
  assert.equal(imported.snapshot.normalized?.source.format, 'deepseek-harness')
})

test('preserves Codex detection', () => {
  assert.equal(detectSessionFormat([{ type: 'session_meta', payload: { id: 'codex' } }]), 'codex')
  assert.equal(detectSessionFormat([{ type: 'not-a-session' }]), 'unknown')
})

test('recognizes DSH event families when session metadata has a nonstandard ID', async () => {
  const events = [
    { type: 'session', version: 0, id: 'opaque-session-id', createdAt: 1_787_908_440_321 },
    { type: 'session/title', time: 1_787_908_440_421, data: { title: '导入 DSH 变体' } },
    { type: 'turn/start', time: 1_787_908_440_521, data: { turn: 1 } },
    { type: 'user/message', time: 1_787_908_440_621, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', time: 1_787_908_440_721, data: { message: { role: 'assistant', content: [{ type: 'text', text: '你好。' }] } } },
  ]
  assert.equal(detectSessionFormat(events), 'deepseek-harness')
  const imported = await new CodexAdapter().importWithRuns('variant.jsonl', Buffer.from(events.map(JSON.stringify).join('\n')).toString('base64'))
  assert.equal(imported.snapshot.normalized?.source.format, 'deepseek-harness')
  assert.equal(imported.snapshot.runs?.length, 1)
})

test('creates a comparable import run when legacy JSONL has messages but no task_started', async () => {
  const events = [
    { timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'legacy-import' } },
    { timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: '检查导入会话' } },
    { timestamp: '2026-09-01T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: '可以比较。' } },
  ]
  const imported = await new CodexAdapter().importWithRuns('legacy.jsonl', Buffer.from(events.map(JSON.stringify).join('\n')).toString('base64'))
  assert.equal(imported.snapshot.runs?.length, 1)
  assert.equal(validateImportedSnapshot(imported.snapshot).valid, true)
})

test('rejects metadata-only imports before the compare page can report a missing task_started', async () => {
  const imported = await new CodexAdapter().importWithRuns('empty.jsonl', Buffer.from(JSON.stringify({ timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'empty-import' } })).toString('base64'))
  assert.equal(validateImportedSnapshot(imported.snapshot).valid, false)
})
