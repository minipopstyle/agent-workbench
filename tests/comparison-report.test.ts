import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComparisonReport, sanitizeForReport, validateComparisonReport } from '../server/comparison-report.ts'
import { compareRuns } from '../server/compare.ts'
import { renderComparisonHtml } from '../server/renderComparisonHtml.ts'
import type { RunAnalysis } from '../server/types.ts'

const footprint = (tools = 80, skills = 20) => [
  { category: 'system', characters: 0, utf8Bytes: 0, estimatedTokens: 0, known: false },
  { category: 'developer', characters: 40, utf8Bytes: 160, estimatedTokens: 40, known: true },
  { category: 'skills', characters: skills * 4, utf8Bytes: skills * 4, estimatedTokens: skills, known: true },
  { category: 'tools', characters: tools * 4, utf8Bytes: tools * 4, estimatedTokens: tools, known: true },
  { category: 'permissions', characters: 0, utf8Bytes: 0, estimatedTokens: 0, known: false },
  { category: 'environment', characters: 20, utf8Bytes: 80, estimatedTokens: 20, known: true },
  { category: 'apps', characters: 0, utf8Bytes: 0, estimatedTokens: 0, known: false },
  { category: 'userHistory', characters: 20, utf8Bytes: 80, estimatedTokens: 20, known: true },
] as RunAnalysis['observable']['promptFootprint']

function run(side: 'a' | 'b' = 'a'): RunAnalysis {
  const candidate = side === 'b'
  const tools = candidate ? [
    { id: 'read-1', stepId: 's1', name: 'Read', label: 'Read', category: 'Read', startMs: 0, endMs: 30, durationMs: 30, status: 'success' as const, args: '/Users/alice/project/a.ts', result: 'Bearer secret-result', flags: [], recovery: null },
    { id: 'exec-1', stepId: 's2', name: 'exec', label: 'exec', category: 'Shell', startMs: 30, endMs: 50, durationMs: 20, status: 'success' as const, args: 'npm test', result: 'ok', flags: [], recovery: null },
  ] : [
    { id: 'read-1', stepId: 's1', name: 'Read', label: 'Read', category: 'Read', startMs: 0, endMs: 20, durationMs: 20, status: 'failed' as const, args: 'a.ts', result: 'failed', flags: [], recovery: 'same_retry' },
  ]
  return {
    schemaVersion: 1,
    ref: { source: 'codex', sessionId: `session-${side}`, turnId: 'turn-1' },
    identity: { title: 'small task', model: 'model-x', effort: 'medium', projectPath: '/Users/alice/project', cliVersion: '1.0', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:02.000Z', status: 'complete', harness: { family: candidate ? 'workbuddy' : 'codex', version: '1', source: 'test' }, modelIdentity: { provider: 'openai', model: 'model-x', reasoningEffort: 'medium' }, environment: { os: 'macOS', cwd: '/Users/alice/project', sandbox: 'workspace', source: 'codex' } },
    observable: { durationMs: candidate ? 1000 : 2000, ttftMs: candidate ? 100 : 200, tokens: candidate ? { input: 120, cachedInput: 30, uncachedInput: 90, output: 20, reasoning: 5, total: 140 } : { input: 100, cachedInput: 50, uncachedInput: 50, output: 20, reasoning: 5, total: 120 }, context: { peakRatio: candidate ? .4 : .9, compactions: 0, points: [{ atMs: 1, ratio: candidate ? .4 : .9, compacted: false }] }, tools, toolSummary: { total: tools.length, succeeded: tools.filter(tool => tool.status === 'success').length, failed: tools.filter(tool => tool.status === 'failed').length, retryCount: 0, parallelRate: null, concentration: null, wallMs: tools.reduce((sum, tool) => sum + tool.durationMs, 0), cumulativeMs: tools.reduce((sum, tool) => sum + tool.durationMs, 0) }, agents: { observed: 0, ids: [] }, trajectory: { repeatedActions: 0, mechanicalRetries: 0, adaptiveRecoveries: 0, loops: 0, wasteActionIds: [], coverage: 1 }, promptFootprint: footprint(candidate ? 100 : 80, candidate ? 0 : 20), harnessActivity: { modelCalls: 2, reasoningItems: 0, assistantMessages: 1, toolDiscoveries: 0, webSearches: 0, mcpCalls: 0, mcpServers: [], skillsUsed: [] } },
    evidence: { goal: 'small task', finalOutput: 'done', validations: [{ kind: 'test', label: 'npm test', passed: candidate, detail: '' }], artifacts: [{ label: 'apply_patch', kind: 'file-change' }] },
    outcome: { status: candidate ? 'success' : 'partial', source: 'observed', evidence: [{ type: 'task_complete', status: 'completed', label: 'Task completed' }, { type: 'test', status: candidate ? 'passed' : 'failed', label: 'npm test' }] },
    behavioralSignals: candidate ? [] : [{ id: 'failure-1', type: 'tool_failure', severity: 'medium', evidence: { callIds: ['read-1'], message: 'failure' }, metrics: { count: 1 } }],
    coverage: { malformedLines: 0, tokenUsageKnown: true, promptFootprintKnown: true, toolPairingRatio: 1, notes: [] },
    v2: { modelCalls: candidate ? [{ atMs: 0, input: 120, cachedInput: 30, uncachedInput: 90, visibleOutput: 15, reasoningOutput: 5, total: 140, contextRatio: .4, compacted: false }] : [{ atMs: 0, input: 100, cachedInput: 50, uncachedInput: 50, visibleOutput: 15, reasoningOutput: 5, total: 120, contextRatio: .9, compacted: false }] },
  }
}

test('builds report metrics, ratios, outcome, behavior, and privacy-safe sessions', () => {
  const report = buildComparisonReport(compareRuns(run(), run('b'), true, 'small task'))
  assert.equal(report.schemaVersion, '1.0')
  assert.equal(report.efficiency.cacheHitRatio.a, .5)
  assert.equal(report.efficiency.cacheHitRatio.b, .25)
  assert.equal(report.reliability.toolFailureRate.a, 1)
  assert.equal(report.reliability.toolFailureRate.b, 0)
  assert.equal(report.context.baseline.promptFootprintTotal, 180)
  assert.equal(report.context.baseline.composition.find(item => item.category === 'tools')?.share, 80 / 180)
  assert.equal(report.outcome.baseline.status, 'partial_success')
  assert.equal(report.outcome.candidate.status, 'verified_success')
  assert.ok(report.behavior.patterns.some(pattern => pattern.type === 'tool_failure_loop'))
  assert.equal(report.sessions.baseline.projectLabel, 'project')
  assert.equal(report.sessions.baseline.title, 'small task')
  assert.equal(report.validity.dimensions.find(item => item.key === 'harness')?.role, 'experimental')
  assert.equal(report.validity.confidence, .9)
  assert.equal(report.efficiency.tokensPerToolCall.b, 70)
  assert.equal(report.efficiency.cacheHitRatio.better, 'A')
  assert.equal(report.summary.judgement, 'trade_off')
  assert.ok(report.divergences.some(item => item.type === 'failure'))
  assert.equal(validateComparisonReport(report).valid, true)
})

test('allows self comparison and reports no trajectory difference', () => {
  const result = compareRuns(run(), run())
  assert.equal(result.trajectoryDiff.steps.every(step => step.state === 'same'), true)
  assert.deepEqual(result.trajectoryDiff.summary, { added: 0, removed: 0, repeated: 0, retries: 0, errors: 0 })
})

test('does not divide by zero and preserves unexplained driver delta', () => {
  const left = run(); const right = run('b')
  right.observable.tokens.input = 0
  right.observable.tokens.cachedInput = 0
  right.observable.tokens.uncachedInput = 0
  right.observable.tokens.total = 200
  const report = buildComparisonReport(compareRuns(left, right, true, 'small task'))
  assert.equal(report.efficiency.cacheHitRatio.b, null)
  assert.equal(report.efficiency.tokensPerToolCall.a, 120)
  assert.equal(report.efficiency.tokensPerToolCall.b, 100)
  const tokenDrivers = report.drivers.tokens
  const explained = tokenDrivers.items.reduce((sum, item) => sum + item.value, 0) + (tokenDrivers.unexplained || 0)
  assert.equal(explained, tokenDrivers.totalDelta)
  assert.ok((tokenDrivers.unexplained || 0) !== 0)
})

test('sanitizes paths, credentials, raw tool payload keys, and shell output', () => {
  const value = sanitizeForReport({ absolutePath: '/Users/alice/project', rawPrompt: 'do it', tool: { args: 'secret', result: 'Bearer abc' }, shellOutput: 'full output', message: '/Users/alice/project Bearer abc sk-live' }) as Record<string, unknown>
  assert.equal('absolutePath' in value, false)
  assert.equal('rawPrompt' in value, false)
  assert.equal('tool' in value, true)
  assert.equal((value.tool as Record<string, unknown>).args, undefined)
  assert.doesNotMatch(JSON.stringify(value), /\/Users\/|Bearer abc|sk-live/)
  assert.equal(sanitizeForReport('/Users/alice/Documents/project'), 'project')
  assert.equal(sanitizeForReport('C:\\Users\\alice\\project'), 'project')
})

test('renders an offline privacy-safe HTML report', () => {
  const report = buildComparisonReport(compareRuns(run(), run('b'), true, 'small task'), { generatedAt: '2026-08-31T10:00:00.000Z' })
  const html = renderComparisonHtml(report)
  assert.match(html, /AGENT WORKBENCH/)
  assert.match(html, /PORCELAIN REPORT · VISUAL DRAFT/)
  assert.match(html, /轨迹结构差异/)
  assert.match(html, /agent-workbench-report-data/)
  assert.match(html, /class="hero-arc session-arc-diagram"/)
  assert.equal((html.match(/class="session-arc-line /g) || []).length, 3)
  assert.equal((html.match(/class="session-arc-anchor /g) || []).length, 4)
  assert.match(html, /class="session-arc-baseline"/)
  assert.doesNotMatch(html, /<(?:div|span) class="arc-label/)
  assert.doesNotMatch(html, /https?:\/\//i)
  assert.doesNotMatch(html, /<link\b|<script\s+src=|<img\b/i)
  assert.doesNotMatch(html, /\/Users\/|C:\\Users\\|Authorization|Bearer|api_key|secret|cookie|credential/i)
  assert.doesNotMatch(html, /NaN|Infinity|undefined/)
})

test('keeps the renderer deterministic and tolerates missing report data', () => {
  const bundle = compareRuns(run(), run('b'), true, 'small task')
  const first = buildComparisonReport(bundle, { generatedAt: '2026-08-31T10:00:00.000Z' })
  const second = buildComparisonReport(bundle, { generatedAt: '2026-08-31T10:00:00.000Z' })
  assert.deepEqual(first, second)
  assert.equal(renderComparisonHtml(first), renderComparisonHtml(second))
  const missing = run()
  missing.observable.tokens = { input: null, cachedInput: null, uncachedInput: null, output: null, reasoning: null, total: null }
  missing.observable.promptFootprint = []
  missing.observable.tools = []
  missing.observable.context.points = []
  missing.evidence = { goal: null, finalOutput: null, validations: [], artifacts: [] }
  missing.outcome = { status: 'unknown', source: 'observed', evidence: [] }
  const missingReport = buildComparisonReport(compareRuns(missing, missing, true, null), { generatedAt: '2026-08-31T10:00:00.000Z' })
  const html = renderComparisonHtml(missingReport)
  assert.match(html, /DATA UNAVAILABLE|数据不足/)
  assert.doesNotMatch(html, /NaN|Infinity|undefined/)
})

test('does not claim a winner when attribution is invalid', () => {
  const report = buildComparisonReport(compareRuns(run(), run('b'), false, null), { generatedAt: '2026-08-31T10:00:00.000Z' })
  report.validity.level = 'invalid'
  report.validity.attributionEnabled = false
  report.summary.judgement = 'b_dominates'
  const html = renderComparisonHtml(report)
  assert.match(html, /INSUFFICIENT EVIDENCE/)
  assert.doesNotMatch(html, /B 在当前观测维度整体更优/)
})
