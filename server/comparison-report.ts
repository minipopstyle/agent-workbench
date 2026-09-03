import type { RunAnalysis } from './types.js'

export type ReportSide = 'A' | 'B'
export type ReportRelation = 'same' | 'different' | 'unknown'
export type Better = ReportSide | 'tie' | 'unknown'
export type ReportStatus = 'verified_success' | 'partial_success' | 'unverified_success' | 'failed' | 'unknown'
export type OptimizationGoal = 'balanced' | 'quality' | 'cost' | 'speed' | 'reliability'

export interface MetricDelta<T = number> {
  key: string
  label: string
  a: T | null
  b: T | null
  absoluteDelta?: number | null
  percentDelta?: number | null
  percentagePointDelta?: number | null
  better: Better
}

export interface ComparisonBundle {
  mode: 'exploratory' | 'controlled'
  baseline: RunAnalysis
  candidate: RunAnalysis
  variables: Array<{ key: string; label: string; left: string | null; right: string | null; relation: string }>
  metrics: Array<{ key: string; baseline: number | null; current: number | null; absoluteDelta: number | null; relativeDelta: number | null; direction?: string }>
  trajectoryDiff: { steps: Array<{ side: 'baseline' | 'current'; index: number; label: string; state: string }>; summary: Record<string, number> }
  attribution: { type: string; validity: string; warnings: string[] }
  coverage: { baseline: RunAnalysis['coverage']; candidate: RunAnalysis['coverage'] }
}

export interface ReportSession {
  source: string
  sessionId: string
  turnId?: string | null
  title?: string | null
  model: string | null
  provider: string | null
  reasoningEffort?: string | null
  harnessFamily?: string | null
  harnessVersion?: string | null
  status: string
  startedAt?: string | null
  endedAt?: string | null
  durationMs: number | null
  projectLabel?: string | null
  environmentLabel?: string | null
}

export interface ComparisonValidity {
  level: 'high' | 'medium' | 'low' | 'invalid'
  confidence: number
  experimentalVariables: string[]
  controlledVariables: string[]
  unknownVariables: string[]
  dimensions: Array<{ key: string; label: string; relation: ReportRelation; role: 'controlled' | 'experimental' | 'unknown' }>
  attributionEnabled: boolean
  summary: string
  warnings: string[]
}

export interface ComparisonSummary {
  judgement: 'a_dominates' | 'b_dominates' | 'trade_off' | 'insufficient_evidence'
  headline: string
  keyFindings: Array<{ type: 'positive' | 'negative' | 'neutral' | 'warning'; metric: string; side?: ReportSide; text: string }>
  dimensionWinners: { outcome: Better; efficiency: Better; reliability: Better; processQuality: Better }
}

export interface SessionOutcome {
  status: ReportStatus
  evidenceCoverage: { verified: number; available: number; ratio: number | null }
  evidence: Array<{
    key: 'task_complete' | 'tests' | 'build' | 'lint' | 'typecheck' | 'artifact' | 'git_diff' | 'tool_result' | 'human_confirmation'
    label: string
    status: 'passed' | 'failed' | 'unknown' | 'not_applicable'
    source?: string | null
  }>
}

export interface ContextMetrics {
  promptFootprintTotal: number | null
  knownPromptCategories: number
  totalPromptCategories: number
  knownCoverage: number | null
  peakRatio: number | null
  compactions: number
  cacheHitRatio: number | null
  composition: Array<{ category: string; estimatedTokens: number | null; known: boolean; share: number | null }>
  contextGrowthRate?: number | null
  repeatedPayloadTokens?: number | null
  unusedContextTokens?: number | null
  contextWasteRate?: number | null
}

export interface ComparisonReport {
  schemaVersion: '1.0'
  meta: { type: 'session_comparison'; generatedAt: string; mode: 'exploratory' | 'controlled'; optimizationGoal: 'balanced' | 'quality' | 'cost' | 'speed' | 'reliability' }
  sessions: { baseline: ReportSession; candidate: ReportSession }
  validity: ComparisonValidity
  summary: ComparisonSummary
  outcome: { baseline: SessionOutcome; candidate: SessionOutcome; evidenceCoverage: MetricDelta }
  efficiency: {
    duration: MetricDelta
    ttft: MetricDelta
    modelCalls: MetricDelta
    toolCalls: MetricDelta
    stepCount: MetricDelta
    inputTokens: MetricDelta
    cachedInputTokens: MetricDelta
    uncachedInputTokens: MetricDelta
    outputTokens: MetricDelta
    reasoningTokens: MetricDelta
    totalTokens: MetricDelta
    cacheHitRatio: MetricDelta
    uncachedInputRatio: MetricDelta
    tokensPerModelCall: MetricDelta
    tokensPerToolCall: MetricDelta
    tokensPerStep: MetricDelta
    modelCallsPerMinute: MetricDelta
    toolCallsPerMinute: MetricDelta
    estimatedCost: MetricDelta | null
    costPerSuccessfulOutcome: MetricDelta | null
  }
  reliability: {
    toolSuccessRate: MetricDelta
    toolFailureRate: MetricDelta
    retryCount: MetricDelta
    retryRate: MetricDelta
    recoveryAttempts: MetricDelta
    recoverySuccesses: MetricDelta
    recoveryRate: MetricDelta
    recoveryTokens: MetricDelta | null
    recoveryTimeMs: MetricDelta | null
    repeatedFailures: MetricDelta
    fatalFailures: MetricDelta
    timeoutCount: MetricDelta | null
  }
  context: { baseline: ContextMetrics; candidate: ContextMetrics; peakRatio: MetricDelta; compactions: MetricDelta; compositionDelta: Array<{ category: string; aTokens: number | null; bTokens: number | null; deltaTokens: number | null; aShare: number | null; bShare: number | null; shareDeltaPp: number | null }> }
  tokenFlow: Array<{ side: ReportSide; index: number; atMs: number; input: number; cachedInput: number; uncachedInput: number; reasoningOutput: number; visibleOutput: number; contextRatio: number | null; compacted: boolean }>
  drivers: { tokens: DriverAnalysis; runtime: DriverAnalysis }
  divergences: DivergencePoint[]
  behavior: { metrics: BehaviorMetric[]; patterns: BehaviorPattern[] }
  recommendations: Recommendation[]
  dataQuality: DataQuality
  provenance: { analyzerVersion: string; schemaVersion: string; metricDefinitionsVersion: string; baselineSessionId: string; candidateSessionId: string; generatedAt: string; sourceBundleHash?: string }
}

export interface DriverAnalysis {
  totalDelta: number | null
  items: Array<{ key: string; label: string; value: number; shareOfDelta?: number | null; source: 'measured' | 'derived' | 'estimated'; confidence: 'low' | 'medium' | 'high' }>
  unexplained: number | null
}

export interface DivergencePoint {
  id: string
  rank: number
  type: 'tool_path_change' | 'failure' | 'retry' | 'extra_step' | 'missing_step' | 'context_spike' | 'token_spike' | 'compaction' | 'output_change' | 'recovery_change'
  a: { stepIds: string[]; timestampMs?: number | null; sequence: string[] }
  b: { stepIds: string[]; timestampMs?: number | null; sequence: string[] }
  impact: { tokenDelta?: number | null; runtimeDeltaMs?: number | null; toolCallDelta?: number | null; failureDelta?: number | null }
  confidence: 'low' | 'medium' | 'high'
  summary: string
}

export interface BehaviorMetric extends MetricDelta { }
export interface BehaviorPattern {
  session: ReportSide
  type: 'repeated_search' | 'repeated_read' | 'tool_failure_loop' | 'retry_loop' | 'backtracking' | 'context_heavy_tool_output' | 'large_shell_output' | 'no_op_steps' | 'premature_completion' | 'evidence_missing' | 'compaction_event' | 'high_context_pressure'
  severity: 'low' | 'medium' | 'high'
  occurrences: number
  evidenceSteps: string[]
  evidenceCallIds: string[]
  summary: string
}

export interface Recommendation {
  id: string
  priority: 'high' | 'medium' | 'low'
  category: 'tool' | 'context' | 'prompt' | 'skill' | 'cache' | 'retry' | 'reliability' | 'evidence' | 'harness'
  target: ReportSide | 'both'
  title: string
  problem: string
  evidence: { metrics: string[]; stepIds: string[]; callIds: string[] }
  recommendation: string
  expectedImpact?: { tokenReduction?: { min: number; max: number } | null; runtimeReductionMs?: { min: number; max: number } | null; costReductionPercent?: { min: number; max: number } | null }
  risk: 'low' | 'medium' | 'high'
  confidence: 'low' | 'medium' | 'high'
}

export interface DataQuality {
  baseline: { tokenUsageKnown: boolean; promptFootprintKnown: boolean; toolPairingRatio: number | null; malformedLines: number }
  candidate: { tokenUsageKnown: boolean; promptFootprintKnown: boolean; toolPairingRatio: number | null; malformedLines: number }
  warnings: string[]
}

type RawModelCall = { atMs: number; input: number; cachedInput: number; uncachedInput: number; reasoningOutput: number; visibleOutput: number; total: number; contextRatio: number | null; compacted: boolean }
type Tool = RunAnalysis['observable']['tools'][number] & { retryClusterId?: string | number | null; stepId?: string }

const FOOTPRINT_CATEGORIES = ['system', 'developer', 'skills', 'tools', 'permissions', 'environment', 'apps', 'userHistory']
const DIMENSION_LABELS: Record<string, string> = { task: 'Task', input: 'Input', model: 'Model', harness: 'Harness', environment: 'Environment', repository: 'Repository', commit: 'Commit', workingDirectory: 'Working Directory' }
const forbiddenKeys = new Set(['absolutepath', 'rawprompt', 'prompt', 'rawinput', 'userinput', 'args', 'tool.args', 'result', 'tool.result', 'shelloutput', 'shell.output', 'environmentvariables', 'environment.variables', 'secret', 'credential', 'cookie', 'authorization', 'authorizationheader', 'api_key', 'apikey', 'token', 'password'])

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const text = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : String(value)
const safeText = (value: unknown) => text(value).replace(/\/Users\/[^\s]+/g, '<path>').replace(/[A-Za-z]:\\Users\\[^\s]+/g, '<path>').replace(/https?:\/\/[^\s]+/gi, '<redacted>').replace(/\b(?:authorization|bearer|api[_-]?key|secret|credential|cookie|password)\b(?:\s*[:=]?\s*[^\s]+)?/gi, '<redacted>').replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]+|glpat-[A-Za-z0-9_-]+)\b/g, '<redacted>').slice(0, 240)
export const sanitizeText = (value: unknown) => safeText(value)
const leaf = (value: unknown) => {
  const clean = text(value).replace(/[\\/]+$/, '')
  return clean ? safeText(clean.split(/[\\/]/).at(-1)) : null
}
const safeValue = (value: unknown) => /^\/Users\/[^/]+\/.+$/s.test(text(value)) || /^[A-Za-z]:\\Users\\[^\\]+\\.+$/s.test(text(value)) ? leaf(value) : safeText(value)
const normalize = (value: unknown) => text(value).trim().toLowerCase()
const asArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : []
const sum = (values: Array<number | null>) => values.some(value => value != null) ? values.reduce((total: number, value) => total + (value || 0), 0) : null

export function sanitizeForReport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForReport)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? safeValue(value) : value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !forbiddenKeys.has(key.toLowerCase())).map(([key, item]) => [key, sanitizeForReport(item)]))
}

export function sanitizeComparisonReport(report: ComparisonReport): ComparisonReport {
  return sanitizeForReport(report) as ComparisonReport
}

const relation = (left: unknown, right: unknown): ReportRelation => {
  if (!normalize(left) || !normalize(right) || ['unknown', 'null', 'n/a', '—'].includes(normalize(left)) || ['unknown', 'null', 'n/a', '—'].includes(normalize(right))) return 'unknown'
  return normalize(left) === normalize(right) ? 'same' : 'different'
}
const oldRelation = (bundle: ComparisonBundle, key: string): ReportRelation => {
  const value = bundle.variables.find(item => item.key === key)?.relation
  return value === 'same' ? 'same' : value === 'different' ? 'different' : 'unknown'
}
const environmentLabel = (run: RunAnalysis) => [run.identity.environment.os, run.identity.environment.sandbox].filter(Boolean).join(' · ')
const commitOf = (run: RunAnalysis) => {
  const identity = run.identity as RunAnalysis['identity'] & { commit?: string; commitSha?: string }
  const v2 = run.v2 as { commit?: string; metadata?: { commit?: string } } | undefined
  return identity.commit || identity.commitSha || v2?.commit || v2?.metadata?.commit || ''
}
const cwdOf = (run: RunAnalysis) => run.identity.environment.cwd || ''
const toolsOf = (run: RunAnalysis): Tool[] => asArray<Tool>(run.observable?.tools)
const modelCallsOf = (run: RunAnalysis): RawModelCall[] => {
  const calls = asArray<Record<string, unknown>>((run.v2 as Record<string, unknown> | undefined)?.modelCalls)
  if (calls.length) return calls.map(call => ({ atMs: finite(call.atMs) || 0, input: finite(call.input) || 0, cachedInput: finite(call.cachedInput) || 0, uncachedInput: finite(call.uncachedInput) ?? Math.max(0, (finite(call.input) || 0) - (finite(call.cachedInput) || 0)), reasoningOutput: finite(call.reasoningOutput) || 0, visibleOutput: finite(call.visibleOutput) || 0, total: finite(call.total) ?? (finite(call.input) || 0) + (finite(call.reasoningOutput) || 0) + (finite(call.visibleOutput) || 0), contextRatio: finite(call.contextRatio), compacted: Boolean(call.compacted) }))
  return asArray<Record<string, unknown>>(run.observable?.context?.points).map(point => ({ atMs: finite(point.atMs) || 0, input: 0, cachedInput: 0, uncachedInput: 0, reasoningOutput: 0, visibleOutput: 0, total: 0, contextRatio: finite(point.ratio), compacted: Boolean(point.compacted) }))
}
const tokenValues = (run: RunAnalysis) => run.observable?.tokens || {}
const metric = (key: string, label: string, a: number | null, b: number | null, better: 'lower' | 'higher' = 'lower', ratio = false): MetricDelta => {
  const absoluteDelta = a != null && b != null ? b - a : null
  const percentDelta = absoluteDelta != null && a != null && a !== 0 ? absoluteDelta / Math.abs(a) : null
  const percentagePointDelta = ratio && absoluteDelta != null ? absoluteDelta * 100 : null
  const winner: Better = a == null || b == null ? 'unknown' : a === b ? 'tie' : (better === 'lower' ? a < b : a > b) ? 'A' : 'B'
  return { key, label, a, b, absoluteDelta, percentDelta, percentagePointDelta, better: winner }
}
const divide = (numerator: number | null, denominator: number | null) => numerator == null || denominator == null || denominator <= 0 ? null : numerator / denominator
const toolMetric = (run: RunAnalysis, key: string) => finite((run.observable?.toolSummary as Record<string, unknown> | undefined || {})[key])
const callsMetric = (run: RunAnalysis) => modelCallsOf(run).length || finite(run.observable?.harnessActivity?.modelCalls) || 0
const footprint = (run: RunAnalysis) => asArray<Record<string, unknown>>(run.observable?.promptFootprint)

function reportSession(run: RunAnalysis): ReportSession {
  const title = run.identity.title && !run.identity.title.includes('\n') ? safeText(run.identity.title).slice(0, 96) : null
  const safe = sanitizeForReport({
    source: run.ref.source,
    sessionId: run.ref.sessionId,
    turnId: run.ref.turnId,
    model: run.identity.modelIdentity.model || run.identity.model,
    provider: run.identity.modelIdentity.provider,
    reasoningEffort: run.identity.modelIdentity.reasoningEffort || run.identity.effort,
    harnessFamily: run.identity.harness.family,
    harnessVersion: run.identity.harness.version,
    status: run.identity.status,
    startedAt: run.identity.startedAt,
    endedAt: run.identity.endedAt,
    durationMs: finite(run.observable?.durationMs),
    projectLabel: leaf(run.identity.projectPath),
    environmentLabel: environmentLabel(run) || null,
    title,
  }) as ReportSession
  return safe
}

function buildValidity(bundle: ComparisonBundle): ComparisonValidity {
  const baseline = bundle.baseline
  const candidate = bundle.candidate
  const task = oldRelation(bundle, 'task')
  const input = bundle.mode === 'controlled' && task === 'same' ? 'same' : relation(baseline.identity.title, candidate.identity.title)
  const raw: Array<[string, ReportRelation]> = [
    ['task', task], ['input', input], ['model', oldRelation(bundle, 'model')], ['harness', oldRelation(bundle, 'harness')],
    ['environment', oldRelation(bundle, 'environment')], ['repository', relation(baseline.identity.projectPath, candidate.identity.projectPath)],
    ['commit', relation(commitOf(baseline), commitOf(candidate))], ['workingDirectory', relation(cwdOf(baseline), cwdOf(candidate))],
  ]
  const dimensions = raw.map(([key, itemRelation]) => ({ key, label: DIMENSION_LABELS[key], relation: itemRelation, role: key === 'harness' && itemRelation === 'different' ? 'experimental' as const : itemRelation === 'same' ? 'controlled' as const : itemRelation === 'different' ? 'experimental' as const : 'unknown' as const }))
  const weights: Record<string, number> = { task: 30, input: 20, model: 15, environment: 10, repository: 10, commit: 10, workingDirectory: 5 }
  const confidence = dimensions.reduce((total, item) => total + (item.role === 'controlled' ? weights[item.key] || 0 : 0), 0) / 100
  const currentInvalid = String(bundle.attribution?.validity || '') === 'invalid'
  const capped = raw.find(([key, itemRelation]) => (key === 'task' && itemRelation === 'different') || (key === 'task' && itemRelation === 'unknown' && raw.find(([candidateKey]) => candidateKey === 'environment')?.[1] === 'different'))
  const level: ComparisonValidity['level'] = currentInvalid ? 'invalid' : capped ? 'low' : confidence >= .85 ? 'high' : confidence >= .65 ? 'medium' : confidence >= .4 ? 'low' : 'invalid'
  const experimentalVariables = dimensions.filter(item => item.role === 'experimental').map(item => item.key)
  const controlledVariables = dimensions.filter(item => item.role === 'controlled').map(item => item.key)
  const unknownVariables = dimensions.filter(item => item.role === 'unknown').map(item => item.key)
  const warnings = [...(bundle.attribution?.warnings || [])]
  if (currentInvalid && !warnings.includes('Existing experiment attribution is invalid.')) warnings.push('Existing experiment attribution is invalid.')
  if (experimentalVariables.includes('task')) warnings.push('Task differs; comparison is descriptive only.')
  const changedMain = dimensions.filter(item => item.relation === 'different' && item.key !== 'harness')
  if (changedMain.length > 1) warnings.push('More than one main comparison variable changed; attribution is disabled.')
  if (unknownVariables.length) warnings.push(`Unknown comparison dimensions: ${unknownVariables.join(', ')}.`)
  const attributionEnabled = !currentInvalid && bundle.mode === 'controlled' && changedMain.length <= 1 && !experimentalVariables.includes('task') && level !== 'invalid'
  return {
    level,
    confidence,
    experimentalVariables,
    controlledVariables,
    unknownVariables,
    dimensions,
    attributionEnabled,
    summary: level === 'invalid' ? '当前证据不足以进行归因。' : level === 'high' ? '主要比较变量已确认一致，可进行归因。' : level === 'medium' ? '比较可用，但部分变量未知。' : '比较仅适合描述性观察，不应视为确定因果结论。',
    warnings: [...new Set(warnings)],
  }
}

const evidenceStatus = (run: RunAnalysis, key: SessionOutcome['evidence'][number]['key']): SessionOutcome['evidence'][number]['status'] => {
  const outcomeEvidence = asArray<{ type?: string; status?: string }>(run.outcome?.evidence)
  const validations = asArray<{ kind?: string; passed?: boolean | null }>(run.evidence?.validations)
  const has = (types: string[]) => outcomeEvidence.filter(item => types.includes(String(item.type)))
  const passed = (items: Array<{ status?: string }>) => items.some(item => ['passed', 'completed', 'success'].includes(String(item.status)))
  const failed = (items: Array<{ status?: string }>) => items.some(item => item.status === 'failed')
  if (key === 'task_complete') return has(['task_complete']).length || run.identity.status === 'complete' ? 'passed' : 'not_applicable'
  if (key === 'tests' || key === 'build' || key === 'lint') {
    const kind = key === 'tests' ? 'test' : key
    const items = validations.filter(item => item.kind === kind)
    if (!items.length) return 'not_applicable'
    return items.some(item => item.passed === false) || failed(has([kind])) ? 'failed' : items.some(item => item.passed === true) || passed(has([kind])) ? 'passed' : 'unknown'
  }
  if (key === 'typecheck') return 'not_applicable'
  if (key === 'artifact') return run.evidence?.artifacts?.length || has(['artifact']).length ? 'passed' : 'not_applicable'
  if (key === 'git_diff') return asArray<{ kind?: string }>(run.evidence?.artifacts).some(item => item.kind === 'file-change') ? 'passed' : 'not_applicable'
  if (key === 'human_confirmation') return run.outcome?.source === 'user' || has(['user_confirmation']).length ? 'passed' : 'not_applicable'
  const tools = toolsOf(run)
  if (!tools.length && !has(['tool_result']).length) return 'not_applicable'
  return tools.some(tool => tool.status === 'failed') || failed(has(['tool_result'])) ? 'failed' : tools.some(tool => tool.status === 'success') || passed(has(['tool_result'])) ? 'passed' : 'unknown'
}

function sessionOutcome(run: RunAnalysis): SessionOutcome {
  const entries: Array<[SessionOutcome['evidence'][number]['key'], string]> = [['task_complete', 'Task Completed'], ['tests', 'Tests'], ['build', 'Build'], ['lint', 'Lint'], ['typecheck', 'Typecheck'], ['artifact', 'Artifact'], ['git_diff', 'Git Diff'], ['tool_result', 'Tool Result'], ['human_confirmation', 'Human Confirmation']]
  const evidence = entries.map(([key, label]) => ({ key, label, status: evidenceStatus(run, key), source: run.outcome?.source || 'observed' }))
  const available = evidence.filter(item => item.status !== 'not_applicable')
  const verified = available.filter(item => item.status === 'passed').length
  const ratio = available.length ? verified / available.length : null
  const criticalFailure = evidence.some(item => ['tests', 'build', 'lint', 'typecheck'].includes(item.key) && item.status === 'failed')
  const completed = evidence.find(item => item.key === 'task_complete')?.status === 'passed'
  const sourceFailed = run.outcome?.status === 'failed'
  const status: ReportStatus = sourceFailed || criticalFailure ? completed ? 'partial_success' : 'failed' : run.outcome?.status === 'partial' ? 'partial_success' : !available.length ? 'unknown' : completed && available.every(item => item.status === 'passed') ? 'verified_success' : completed ? 'unverified_success' : 'unknown'
  return { status, evidenceCoverage: { verified, available: available.length, ratio }, evidence }
}

function buildEfficiency(a: RunAnalysis, b: RunAnalysis) {
  const tokensA = tokenValues(a); const tokensB = tokenValues(b)
  const durationA = finite(a.observable?.durationMs); const durationB = finite(b.observable?.durationMs)
  const modelA = callsMetric(a); const modelB = callsMetric(b)
  const toolA = toolMetric(a, 'total') ?? toolsOf(a).length; const toolB = toolMetric(b, 'total') ?? toolsOf(b).length
  const stepA = toolsOf(a).length; const stepB = toolsOf(b).length
  const inputA = finite(tokensA.input); const inputB = finite(tokensB.input)
  const cachedA = finite(tokensA.cachedInput); const cachedB = finite(tokensB.cachedInput)
  const uncachedA = finite(tokensA.uncachedInput); const uncachedB = finite(tokensB.uncachedInput)
  const outputA = finite(tokensA.output); const outputB = finite(tokensB.output)
  const reasoningA = finite(tokensA.reasoning); const reasoningB = finite(tokensB.reasoning)
  const totalA = finite(tokensA.total); const totalB = finite(tokensB.total)
  const cacheA = divide(cachedA, inputA); const cacheB = divide(cachedB, inputB)
  const uncachedRatioA = divide(uncachedA, inputA); const uncachedRatioB = divide(uncachedB, inputB)
  const minutesA = durationA != null && durationA > 0 ? durationA / 60_000 : null; const minutesB = durationB != null && durationB > 0 ? durationB / 60_000 : null
  return {
    duration: metric('duration', 'Duration', durationA, durationB), ttft: metric('ttft', 'TTFT', finite(a.observable?.ttftMs), finite(b.observable?.ttftMs)), modelCalls: metric('modelCalls', 'Model Calls', modelA, modelB), toolCalls: metric('toolCalls', 'Tool Calls', toolA, toolB), stepCount: metric('stepCount', 'Step Count', stepA, stepB), inputTokens: metric('inputTokens', 'Input Tokens', inputA, inputB), cachedInputTokens: metric('cachedInputTokens', 'Cached Input Tokens', cachedA, cachedB), uncachedInputTokens: metric('uncachedInputTokens', 'Uncached Input Tokens', uncachedA, uncachedB), outputTokens: metric('outputTokens', 'Output Tokens', outputA, outputB), reasoningTokens: metric('reasoningTokens', 'Reasoning Tokens', reasoningA, reasoningB), totalTokens: metric('totalTokens', 'Total Tokens', totalA, totalB), cacheHitRatio: metric('cacheHitRatio', 'Cache Hit Ratio', cacheA, cacheB, 'higher', true), uncachedInputRatio: metric('uncachedInputRatio', 'Uncached Input Ratio', uncachedRatioA, uncachedRatioB, 'lower', true), tokensPerModelCall: metric('tokensPerModelCall', 'Tokens / Model Call', divide(totalA, modelA), divide(totalB, modelB)), tokensPerToolCall: metric('tokensPerToolCall', 'Tokens / Tool Call', divide(totalA, toolA), divide(totalB, toolB)), tokensPerStep: metric('tokensPerStep', 'Tokens / Step', divide(totalA, stepA), divide(totalB, stepB)), modelCallsPerMinute: metric('modelCallsPerMinute', 'Model Calls / Minute', divide(modelA, minutesA), divide(modelB, minutesB)), toolCallsPerMinute: metric('toolCallsPerMinute', 'Tool Calls / Minute', divide(toolA, minutesA), divide(toolB, minutesB)), estimatedCost: null, costPerSuccessfulOutcome: null,
  }
}

function recoveryStats(run: RunAnalysis) {
  const tools = toolsOf(run); const trajectory = run.observable?.trajectory || {}; const clusters = new Set(tools.map(tool => tool.retryClusterId).filter(value => value != null).map(String))
  const mechanical = finite(trajectory.mechanicalRetries) ?? finite(run.observable?.toolSummary?.retryCount) ?? 0
  const adaptive = finite(trajectory.adaptiveRecoveries) ?? tools.filter(tool => tool.recovery === 'recovered').length
  const recoveryMarkers = tools.filter(tool => tool.recovery).length
  const attempts = clusters.size || mechanical + adaptive || Math.ceil(recoveryMarkers / 2)
  const successes = tools.filter(tool => tool.recovery === 'recovered').length || adaptive
  const failures = toolMetric(run, 'failed') ?? tools.filter(tool => tool.status === 'failed').length
  const recoveredTime = tools.filter(tool => tool.recovery === 'recovered').reduce((total, tool) => total + (finite(tool.durationMs) || 0), 0)
  return { attempts, successes, failures, retryCount: mechanical, recoveryTimeMs: recoveredTime || null }
}

function buildReliability(a: RunAnalysis, b: RunAnalysis) {
  const stats = (run: RunAnalysis) => { const tools = toolMetric(run, 'total') ?? toolsOf(run).length; const failed = toolMetric(run, 'failed') ?? toolsOf(run).filter(tool => tool.status === 'failed').length; const recovery = recoveryStats(run); return { total: tools, failed, recovery, successRate: divide(tools - failed, tools), failureRate: divide(failed, tools), retryRate: divide(recovery.retryCount, tools), recoveryRate: divide(recovery.successes, recovery.attempts), repeatedFailures: toolsOf(run).filter(tool => tool.status === 'failed' && (tool.flags?.includes('repeated') || tool.flags?.includes('mechanical-retry'))).length, fatalFailures: run.outcome?.status === 'failed' ? 1 : 0 } }
  const left = stats(a); const right = stats(b)
  return { toolSuccessRate: metric('toolSuccessRate', 'Tool Success Rate', left.successRate, right.successRate, 'higher', true), toolFailureRate: metric('toolFailureRate', 'Tool Failure Rate', left.failureRate, right.failureRate, 'lower', true), retryCount: metric('retryCount', 'Retry Count', left.recovery.retryCount, right.recovery.retryCount), retryRate: metric('retryRate', 'Retry Rate', left.retryRate, right.retryRate, 'lower', true), recoveryAttempts: metric('recoveryAttempts', 'Recovery Attempts', left.recovery.attempts, right.recovery.attempts), recoverySuccesses: metric('recoverySuccesses', 'Recovery Successes', left.recovery.successes, right.recovery.successes, 'higher'), recoveryRate: metric('recoveryRate', 'Recovery Rate', left.recoveryRate, right.recoveryRate, 'higher', true), recoveryTokens: null, recoveryTimeMs: metric('recoveryTimeMs', 'Recovery Time', left.recovery.recoveryTimeMs, right.recovery.recoveryTimeMs), repeatedFailures: metric('repeatedFailures', 'Repeated Failures', left.repeatedFailures, right.repeatedFailures), fatalFailures: metric('fatalFailures', 'Fatal Failures', left.fatalFailures, right.fatalFailures), timeoutCount: null }
}

function contextMetrics(run: RunAnalysis): ContextMetrics {
  const items = footprint(run); const known = items.filter(item => item.known === true && finite(item.estimatedTokens) != null); const total = sum(known.map(item => finite(item.estimatedTokens)))
  const composition = FOOTPRINT_CATEGORIES.map(category => { const item = items.find(candidate => candidate.category === category); const value = item?.known ? finite(item.estimatedTokens) : null; return { category, estimatedTokens: value, known: Boolean(item?.known), share: total != null && value != null && total > 0 ? value / total : null } })
  const calls = modelCallsOf(run).sort((left, right) => left.atMs - right.atMs); const growth: number[] = []
  for (let index = 1; index < calls.length; index++) { const previous = calls[index - 1]; const current = calls[index]; if (!previous.input || !current.input || previous.compacted || current.compacted || current.input < previous.input) continue; growth.push(current.input - previous.input) }
  const tokens = tokenValues(run); const input = finite(tokens.input); const cached = finite(tokens.cachedInput)
  return { promptFootprintTotal: total, knownPromptCategories: known.length, totalPromptCategories: FOOTPRINT_CATEGORIES.length, knownCoverage: known.length / FOOTPRINT_CATEGORIES.length, peakRatio: finite(run.observable?.context?.peakRatio), compactions: finite(run.observable?.context?.compactions) || 0, cacheHitRatio: divide(cached, input), composition, contextGrowthRate: growth.length ? growth.reduce((a, b) => a + b, 0) / growth.length : null, repeatedPayloadTokens: null, unusedContextTokens: null, contextWasteRate: null }
}

function buildContext(a: RunAnalysis, b: RunAnalysis) {
  const baseline = contextMetrics(a); const candidate = contextMetrics(b)
  const compositionDelta = FOOTPRINT_CATEGORIES.map(category => { const left = baseline.composition.find(item => item.category === category)!; const right = candidate.composition.find(item => item.category === category)!; return { category, aTokens: left.estimatedTokens, bTokens: right.estimatedTokens, deltaTokens: left.estimatedTokens != null && right.estimatedTokens != null ? right.estimatedTokens - left.estimatedTokens : null, aShare: left.share, bShare: right.share, shareDeltaPp: left.share != null && right.share != null ? (right.share - left.share) * 100 : null } })
  return { baseline, candidate, peakRatio: metric('peakContextRatio', 'Peak Context Ratio', baseline.peakRatio, candidate.peakRatio, 'lower', true), compactions: metric('compactions', 'Compactions', baseline.compactions, candidate.compactions), compositionDelta }
}

const winner = (left: Better, right: Better): Better => left === right ? left : left === 'unknown' ? right : right === 'unknown' ? left : 'tie'

function buildSummary(outcome: { baseline: SessionOutcome; candidate: SessionOutcome }, efficiency: ReturnType<typeof buildEfficiency>, reliability: ReturnType<typeof buildReliability>, validity: ComparisonValidity): ComparisonSummary {
  const evidenceCoverage = metric('evidenceCoverage', 'Evidence Coverage', outcome.baseline.evidenceCoverage.ratio, outcome.candidate.evidenceCoverage.ratio, 'higher', true)
  const dimensions = { outcome: outcome.baseline.status === outcome.candidate.status ? 'tie' as Better : outcome.baseline.status === 'verified_success' ? 'A' as Better : outcome.candidate.status === 'verified_success' ? 'B' as Better : 'unknown' as Better, efficiency: winner(efficiency.duration.better, efficiency.totalTokens.better), reliability: winner(reliability.toolFailureRate.better, reliability.toolSuccessRate.better), processQuality: winner(reliability.repeatedFailures.better, reliability.recoveryRate.better) }
  const candidates: Array<{ type: 'positive' | 'negative' | 'neutral' | 'warning'; metric: string; side?: ReportSide; text: string }> = []
  for (const item of [efficiency.duration, efficiency.totalTokens, reliability.toolFailureRate, evidenceCoverage]) {
    if (item.better === 'A' || item.better === 'B') candidates.push({ type: 'positive', metric: item.key, side: item.better, text: `${item.label} favors ${item.better}.` })
  }
  const aWins = Object.values(dimensions).filter(value => value === 'A').length; const bWins = Object.values(dimensions).filter(value => value === 'B').length
  if (validity.level === 'invalid') return { judgement: 'insufficient_evidence', headline: 'Insufficient evidence for a reliable overall judgement.', keyFindings: [{ type: 'warning', metric: 'comparisonValidity', text: '当前证据不足以判断哪条路径更好。' }], dimensionWinners: { outcome: 'unknown', efficiency: 'unknown', reliability: 'unknown', processQuality: 'unknown' } }
  const judgement: ComparisonSummary['judgement'] = !aWins && !bWins ? 'insufficient_evidence' : aWins >= 3 && !bWins ? 'a_dominates' : bWins >= 3 && !aWins ? 'b_dominates' : 'trade_off'
  const headline = judgement === 'a_dominates' ? 'Baseline A dominates on the observed dimensions.' : judgement === 'b_dominates' ? 'Candidate B dominates on the observed dimensions.' : judgement === 'trade_off' ? 'A/B trade off across the observed dimensions.' : 'Insufficient evidence for a reliable overall judgement.'
  return { judgement, headline, keyFindings: candidates.slice(0, 8), dimensionWinners: { outcome: dimensions.outcome, efficiency: dimensions.efficiency, reliability: dimensions.reliability, processQuality: dimensions.processQuality } }
}

function driver(totalDelta: number | null, candidates: Array<{ key: string; label: string; value: number | null; source: 'measured' | 'derived' | 'estimated'; confidence: 'low' | 'medium' | 'high' }>): DriverAnalysis {
  if (totalDelta == null) return { totalDelta: null, items: [], unexplained: null }
  const items = candidates.filter(item => item.value != null).map(item => ({ ...item, value: item.value as number, shareOfDelta: totalDelta === 0 ? null : item.value! / totalDelta }))
  const unexplained = totalDelta - items.reduce((total, item) => total + item.value, 0)
  return { totalDelta, items, unexplained: Math.abs(unexplained) < 1e-9 ? 0 : unexplained }
}

function buildDrivers(a: RunAnalysis, b: RunAnalysis, efficiency: ReturnType<typeof buildEfficiency>) {
  const totalDelta = efficiency.totalTokens.absoluteDelta; const cached = efficiency.cachedInputTokens.absoluteDelta; const uncached = efficiency.uncachedInputTokens.absoluteDelta
  const output = efficiency.outputTokens.absoluteDelta
  const tokens = driver(totalDelta ?? null, [{ key: 'cachedInputDelta', label: 'Cached Input Delta', value: cached ?? null, source: 'measured', confidence: 'high' }, { key: 'uncachedInputDelta', label: 'Uncached Input Delta', value: uncached ?? null, source: 'measured', confidence: 'high' }, { key: 'other', label: 'Other', value: output ?? null, source: 'derived', confidence: 'high' }])
  const runtime = driver(efficiency.duration.absoluteDelta ?? null, [{ key: 'toolWallTimeDelta', label: 'Tool Wall Time Delta', value: (finite(b.observable?.toolSummary?.wallMs) != null && finite(a.observable?.toolSummary?.wallMs) != null) ? (finite(b.observable?.toolSummary?.wallMs)! - finite(a.observable?.toolSummary?.wallMs)!) : null, source: 'measured', confidence: 'high' }, { key: 'ttftDelta', label: 'TTFT Delta', value: efficiency.ttft.absoluteDelta ?? null, source: 'measured', confidence: 'high' }, { key: 'recoveryTimeDelta', label: 'Retry / Recovery Time', value: buildReliability(a, b).recoveryTimeMs?.absoluteDelta ?? null, source: 'derived', confidence: 'medium' }])
  return { tokens, runtime }
}

const toolSequence = (tools: Tool[]) => tools.map(tool => safeText(tool.label || tool.name || 'tool'))
const divergence = (type: DivergencePoint['type'], aTools: Tool[], bTools: Tool[], impact: DivergencePoint['impact'], confidenceOrSummary: DivergencePoint['confidence'] | string, maybeSummary?: string): DivergencePoint => ({ id: '', rank: 0, type, a: { stepIds: aTools.map(tool => safeText(tool.stepId || tool.id)), timestampMs: aTools[0]?.startMs ?? null, sequence: toolSequence(aTools) }, b: { stepIds: bTools.map(tool => safeText(tool.stepId || tool.id)), timestampMs: bTools[0]?.startMs ?? null, sequence: toolSequence(bTools) }, impact, confidence: maybeSummary ? confidenceOrSummary as DivergencePoint['confidence'] : 'medium', summary: maybeSummary || confidenceOrSummary })

function buildDivergences(a: RunAnalysis, b: RunAnalysis, efficiency: ReturnType<typeof buildEfficiency>, reliability: ReturnType<typeof buildReliability>, context: ReturnType<typeof buildContext>): DivergencePoint[] {
  const left = toolsOf(a); const right = toolsOf(b); const points: DivergencePoint[] = []
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const aTool = left[index]; const bTool = right[index]
    if (!aTool && bTool) points.push(divergence('extra_step', [], [bTool], { toolCallDelta: 1, runtimeDeltaMs: efficiency.duration.absoluteDelta }, 'Candidate has an extra tool step.'))
    else if (aTool && !bTool) points.push(divergence('missing_step', [aTool], [], { toolCallDelta: -1, runtimeDeltaMs: efficiency.duration.absoluteDelta }, 'Candidate is missing a baseline tool step.'))
    else if (aTool && bTool) {
      if (aTool.category !== bTool.category || safeText(aTool.label) !== safeText(bTool.label)) points.push(divergence('tool_path_change', [aTool], [bTool], { toolCallDelta: 0, runtimeDeltaMs: efficiency.duration.absoluteDelta }, 'Tool category or label changed at the same sequence position.'))
      if (aTool.status !== bTool.status) points.push(divergence('failure', [aTool], [bTool], { failureDelta: (bTool.status === 'failed' ? 1 : 0) - (aTool.status === 'failed' ? 1 : 0), runtimeDeltaMs: efficiency.duration.absoluteDelta }, 'Tool success state changed at the same sequence position.'))
      if (Boolean(aTool.recovery) !== Boolean(bTool.recovery)) points.push(divergence('recovery_change', [aTool], [bTool], { runtimeDeltaMs: efficiency.duration.absoluteDelta }, 'Recovery metadata changed at the same sequence position.'))
    }
  }
  if (reliability.retryCount.absoluteDelta && reliability.retryCount.absoluteDelta !== 0) points.push(divergence('retry', left.filter(tool => tool.flags?.includes('mechanical-retry')), right.filter(tool => tool.flags?.includes('mechanical-retry')), { runtimeDeltaMs: efficiency.duration.absoluteDelta, toolCallDelta: efficiency.toolCalls.absoluteDelta }, 'Retry count changed between paths.'))
  if (efficiency.modelCalls.absoluteDelta && efficiency.modelCalls.absoluteDelta !== 0) points.push(divergence(efficiency.modelCalls.absoluteDelta > 0 ? 'extra_step' : 'missing_step', [], [], { tokenDelta: efficiency.totalTokens.absoluteDelta, runtimeDeltaMs: efficiency.duration.absoluteDelta }, 'Model call count changed between paths.'))
  if (a.observable?.context?.compactions !== b.observable?.context?.compactions && (a.observable?.context?.compactions || b.observable?.context?.compactions)) points.push(divergence('compaction', [], [], { tokenDelta: efficiency.totalTokens.absoluteDelta }, 'Compaction occurred on only one path or at a different count.'))
  if (context.baseline.peakRatio != null && context.candidate.peakRatio != null && Math.abs(context.baseline.peakRatio - context.candidate.peakRatio) >= .2) points.push(divergence('context_spike', [], [], { tokenDelta: efficiency.inputTokens.absoluteDelta }, 'Peak context pressure differs by at least 20 percentage points.'))
  if (efficiency.inputTokens.percentDelta != null && Math.abs(efficiency.inputTokens.percentDelta) >= .25) points.push(divergence('token_spike', [], [], { tokenDelta: efficiency.inputTokens.absoluteDelta }, 'Input token usage differs by at least 25 percent.'))
  if (efficiency.outputTokens.absoluteDelta != null && efficiency.outputTokens.absoluteDelta !== 0) points.push(divergence('output_change', [], [], { tokenDelta: efficiency.outputTokens.absoluteDelta }, 'Output token usage changed.'))
  const confidenceWeight = { low: .5, medium: .75, high: 1 }
  const impactWeight = (point: DivergencePoint) => Math.abs(point.impact.failureDelta || 0) * 100 + Math.abs(point.impact.tokenDelta || 0) + Math.abs(point.impact.runtimeDeltaMs || 0) / 10 + Math.abs(point.impact.toolCallDelta || 0) * 10 + (({ failure: 1000, retry: 800, token_spike: 700, context_spike: 600, compaction: 500 } as Record<string, number>)[point.type] || 0)
  return points.map((point, index) => ({ ...point, id: `d${index + 1}` })).sort((x, y) => impactWeight(y) * confidenceWeight[y.confidence] - impactWeight(x) * confidenceWeight[x.confidence]).slice(0, 5).map((point, index) => ({ ...point, rank: index + 1 }))
}

function buildBehavior(a: RunAnalysis, b: RunAnalysis): { metrics: BehaviorMetric[]; patterns: BehaviorPattern[] } {
  const metricsFor = (run: RunAnalysis) => {
    const tools = toolsOf(run); const signals = asArray<{ type?: string }>(run.behavioralSignals); const trajectory = run.observable?.trajectory || {}; const count = (category: string) => tools.filter(tool => tool.category === category).length
    return { planning: null, search: count('Search'), read: count('Read'), shell: count('Shell'), repeated: finite(trajectory.repeatedActions) ?? signals.filter(signal => ['repeated_read', 'repeated_tool_call'].includes(String(signal.type))).length, mechanicalRetries: finite(trajectory.mechanicalRetries), adaptiveRecoveries: finite(trajectory.adaptiveRecoveries), loops: finite(trajectory.loops), wasteActions: asArray(trajectory.wasteActionIds).length, failed: toolMetric(run, 'failed') ?? tools.filter(tool => tool.status === 'failed').length, backtracking: signals.filter(signal => signal.type === 'backtrack').length, noOp: null }
  }
  const left = metricsFor(a); const right = metricsFor(b); const definitions: Array<[string, string, keyof typeof left, 'lower' | 'higher']> = [['planningSteps', 'Planning Steps', 'planning', 'lower'], ['searchCalls', 'Search Calls', 'search', 'lower'], ['readCalls', 'Read Calls', 'read', 'lower'], ['shellCalls', 'Shell Calls', 'shell', 'lower'], ['repeatedActions', 'Repeated Actions', 'repeated', 'lower'], ['mechanicalRetries', 'Mechanical Retries', 'mechanicalRetries', 'lower'], ['adaptiveRecoveries', 'Adaptive Recoveries', 'adaptiveRecoveries', 'higher'], ['loops', 'Loops', 'loops', 'lower'], ['wasteActions', 'Waste Actions', 'wasteActions', 'lower'], ['failedCalls', 'Failed Calls', 'failed', 'lower'], ['backtracking', 'Backtracking', 'backtracking', 'lower'], ['noOpSteps', 'No-op Steps', 'noOp', 'lower']]
  const metrics = definitions.map(([key, label, field, direction]) => metric(key, label, left[field], right[field], direction))
  const patterns: BehaviorPattern[] = []
  const addPatterns = (run: RunAnalysis, session: ReportSide) => {
    const tools = toolsOf(run); const callIds = (signal: { evidence?: { callIds?: string[] } }) => asArray<string>(signal.evidence?.callIds).map(safeText); const stepIds = (signal: { evidence?: { callIds?: string[] } }) => callIds(signal).flatMap(id => tools.filter(tool => tool.id === id).map(tool => safeText(tool.stepId || tool.id)))
    for (const signal of asArray<{ type?: string; severity?: string; evidence?: { callIds?: string[] }; metrics?: Record<string, number> }>(run.behavioralSignals)) {
      const mapped: Record<string, BehaviorPattern['type']> = { repeated_read: 'repeated_read', repeated_tool_call: 'repeated_search', mechanical_retry: 'retry_loop', retry: 'retry_loop', tool_failure: 'tool_failure_loop', backtrack: 'backtracking', compaction: 'compaction_event', context_spike: 'high_context_pressure' }
      const type = mapped[String(signal.type)]
      if (!type) continue
      const ids = callIds(signal); patterns.push({ session, type, severity: signal.severity === 'high' ? 'high' : signal.severity === 'medium' ? 'medium' : 'low', occurrences: Math.max(1, finite(signal.metrics?.count) || ids.length), evidenceSteps: stepIds(signal), evidenceCallIds: ids, summary: `${type} observed in ${session}.` })
    }
    const largeOutputs = tools.filter(tool => text(tool.result).length >= 5000); if (largeOutputs.length) patterns.push({ session, type: 'context_heavy_tool_output', severity: 'medium', occurrences: largeOutputs.length, evidenceSteps: largeOutputs.map(tool => safeText(tool.stepId || tool.id)), evidenceCallIds: largeOutputs.map(tool => safeText(tool.id)), summary: 'Large tool results entered the observed context.' })
    const shellOutputs = tools.filter(tool => tool.category === 'Shell' && text(tool.result).length >= 5000); if (shellOutputs.length) patterns.push({ session, type: 'large_shell_output', severity: 'medium', occurrences: shellOutputs.length, evidenceSteps: shellOutputs.map(tool => safeText(tool.stepId || tool.id)), evidenceCallIds: shellOutputs.map(tool => safeText(tool.id)), summary: 'Large shell output was observed.' })
    const outcome = sessionOutcome(run); if (outcome.status === 'unverified_success' || outcome.status === 'unknown') patterns.push({ session, type: 'evidence_missing', severity: 'low', occurrences: 1, evidenceSteps: [], evidenceCallIds: [], summary: 'Outcome evidence is incomplete.' })
  }
  addPatterns(a, 'A'); addPatterns(b, 'B')
  return { metrics, patterns }
}

function buildRecommendations(a: RunAnalysis, b: RunAnalysis, efficiency: ReturnType<typeof buildEfficiency>, reliability: ReturnType<typeof buildReliability>, context: ReturnType<typeof buildContext>, behavior: ReturnType<typeof buildBehavior>): Recommendation[] {
  const list: Recommendation[] = []; const add = (item: Omit<Recommendation, 'id'>) => list.push({ ...item, id: `r${list.length + 1}` })
  const worse: ReportSide = reliability.toolFailureRate.better === 'A' ? 'B' : 'A'
  const failureRate = worse === 'B' ? reliability.toolFailureRate.b : reliability.toolFailureRate.a
  if (failureRate != null && failureRate > .2) add({ priority: 'high', category: 'reliability', target: worse, title: 'Inspect the highest-failure tool path', problem: `${worse} tool failure rate exceeds 20%.`, evidence: { metrics: ['toolFailureRate'], stepIds: [], callIds: [] }, recommendation: 'Inspect the failing tool contract and add a preflight check before retrying.', risk: 'medium', confidence: 'high' })
  for (const item of [{ side: 'A' as const, metrics: context.baseline, run: a }, { side: 'B' as const, metrics: context.candidate, run: b }]) {
    const { side, metrics, run } = item
    if (metrics.peakRatio != null && metrics.peakRatio > .8) add({ priority: 'high', category: 'context', target: side, title: 'Reduce peak context pressure', problem: `${side} peak context ratio exceeds 80%.`, evidence: { metrics: ['peakContextRatio'], stepIds: [], callIds: [] }, recommendation: 'Trim repeated context and compact before the next large tool result.', risk: 'medium', confidence: 'high' })
    const skills = metrics.composition.find(item => item.category === 'skills'); if ((skills?.share || 0) > .4 && !asArray(run.observable?.harnessActivity?.skillsUsed).length) add({ priority: 'medium', category: 'skill', target: side, title: 'Load skills on demand', problem: `Skills occupy a large share of known prompt footprint but no skill activation was observed.`, evidence: { metrics: ['context.skills.share'], stepIds: [], callIds: [] }, recommendation: 'Move optional skill instructions behind on-demand activation.', risk: 'low', confidence: 'medium' })
    const tools = metrics.composition.find(item => item.category === 'tools'); if ((tools?.share || 0) > .4) add({ priority: 'medium', category: 'tool', target: side, title: 'Trim tool schema and result context', problem: 'Tool context is a large share of the known prompt footprint.', evidence: { metrics: ['context.tools.share'], stepIds: [], callIds: [] }, recommendation: 'Return only the fields needed for the next decision and keep schemas narrow.', risk: 'low', confidence: 'medium' })
    const history = metrics.composition.find(item => item.category === 'userHistory'); if ((history?.share || 0) > .4) add({ priority: 'medium', category: 'prompt', target: side, title: 'Limit historical conversation context', problem: 'User history is a large share of the known prompt footprint.', evidence: { metrics: ['context.userHistory.share'], stepIds: [], callIds: [] }, recommendation: 'Summarize older turns and retain only task-relevant history.', risk: 'low', confidence: 'medium' })
  }
  for (const side of ['A', 'B'] as const) { const ratio = side === 'A' ? efficiency.cacheHitRatio.a : efficiency.cacheHitRatio.b; if (ratio != null && ratio < .3) add({ priority: 'medium', category: 'cache', target: side, title: 'Improve prompt cache stability', problem: `${side} cache hit ratio is below 30%.`, evidence: { metrics: ['cacheHitRatio'], stepIds: [], callIds: [] }, recommendation: 'Keep stable instructions before changing per-turn content.', risk: 'low', confidence: 'high' }) }
  const repeated = behavior.metrics.find(item => item.key === 'repeatedActions'); for (const side of ['A', 'B'] as const) { const count = side === 'A' ? repeated?.a : repeated?.b; if (typeof count === 'number' && count > 0) add({ priority: 'medium', category: 'retry', target: side, title: 'Reduce repeated actions', problem: `${side} contains repeated actions.`, evidence: { metrics: ['repeatedActions'], stepIds: [], callIds: [] }, recommendation: 'Cache the result of recent reads/searches and branch on the existing result.', risk: 'low', confidence: 'high' }) }
  for (const side of ['A', 'B'] as const) { const patterns = behavior.patterns.filter(pattern => pattern.session === side); if (patterns.some(pattern => pattern.type === 'context_heavy_tool_output')) add({ priority: 'medium', category: 'tool', target: side, title: 'Limit tool result length', problem: `${side} has large tool output entering context.`, evidence: { metrics: ['context.tools'], stepIds: patterns.flatMap(pattern => pattern.evidenceSteps), callIds: patterns.flatMap(pattern => pattern.evidenceCallIds) }, recommendation: 'Return only the fields needed for the next decision and cap verbose tool results.', risk: 'low', confidence: 'medium' }) }
  return list.slice(0, 8)
}

function dataQuality(run: RunAnalysis): DataQuality['baseline'] {
  return { tokenUsageKnown: Boolean(run.coverage?.tokenUsageKnown), promptFootprintKnown: Boolean(run.coverage?.promptFootprintKnown), toolPairingRatio: finite(run.coverage?.toolPairingRatio), malformedLines: finite(run.coverage?.malformedLines) || 0 }
}

export function validateComparisonReport(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []; const report = value as Record<string, unknown> | null; const required = ['schemaVersion', 'meta', 'sessions', 'validity', 'summary', 'outcome', 'efficiency', 'reliability', 'context', 'tokenFlow', 'drivers', 'divergences', 'behavior', 'recommendations', 'dataQuality', 'provenance']
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { valid: false, errors: ['Report must be an object.'] }
  for (const key of required) if (!(key in report)) errors.push(`Missing ${key}.`)
  if (report.schemaVersion !== '1.0') errors.push('schemaVersion must be 1.0.')
  const meta = report.meta as Record<string, unknown> | null; if (!meta || meta.type !== 'session_comparison' || !['exploratory', 'controlled'].includes(String(meta.mode)) || !['balanced', 'quality', 'cost', 'speed', 'reliability'].includes(String(meta.optimizationGoal))) errors.push('Invalid report meta.')
  const sessions = report.sessions as Record<string, unknown> | null; if (!sessions?.baseline || !sessions.candidate) errors.push('Both sessions are required.')
  for (const key of ['summary', 'outcome', 'efficiency', 'reliability', 'context', 'drivers', 'behavior', 'dataQuality', 'provenance']) if (!object(report[key])) errors.push(`${key} must be an object.`)
  for (const key of ['tokenFlow', 'divergences', 'recommendations']) if (!Array.isArray(report[key])) errors.push(`${key} must be an array.`)
  if (Array.isArray(report.divergences) && report.divergences.length > 5) errors.push('divergences must contain at most five items.')
  const validity = report.validity as Record<string, unknown> | null; if (!validity || !['high', 'medium', 'low', 'invalid'].includes(String(validity.level)) || typeof validity.confidence !== 'number') errors.push('Invalid validity.')
  return { valid: !errors.length, errors }
}

export function buildComparisonReport(bundle: ComparisonBundle, options: { optimizationGoal?: OptimizationGoal; generatedAt?: string } = {}): ComparisonReport {
  const generatedAt = options.generatedAt || new Date().toISOString(); const validity = buildValidity(bundle); const outcome = { baseline: sessionOutcome(bundle.baseline), candidate: sessionOutcome(bundle.candidate) }; const efficiency = buildEfficiency(bundle.baseline, bundle.candidate); const reliability = buildReliability(bundle.baseline, bundle.candidate); const context = buildContext(bundle.baseline, bundle.candidate); const behavior = buildBehavior(bundle.baseline, bundle.candidate)
  const warnings = [...validity.warnings]; const quality = { baseline: dataQuality(bundle.baseline), candidate: dataQuality(bundle.candidate), warnings }
  for (const side of [quality.baseline, quality.candidate]) { if (!side.tokenUsageKnown) quality.warnings.push('Token usage is incomplete for one session.'); if (!side.promptFootprintKnown) quality.warnings.push('Prompt footprint is incomplete for one session.'); if (side.malformedLines) quality.warnings.push('Malformed input lines were skipped.') }
  const report: ComparisonReport = {
    schemaVersion: '1.0', meta: { type: 'session_comparison', generatedAt, mode: bundle.mode, optimizationGoal: options.optimizationGoal || 'balanced' }, sessions: { baseline: reportSession(bundle.baseline), candidate: reportSession(bundle.candidate) }, validity, summary: buildSummary(outcome, efficiency, reliability, validity), outcome: { ...outcome, evidenceCoverage: metric('evidenceCoverage', 'Evidence Coverage', outcome.baseline.evidenceCoverage.ratio, outcome.candidate.evidenceCoverage.ratio, 'higher', true) }, efficiency, reliability, context, tokenFlow: [...modelCallsOf(bundle.baseline).map(call => ({ side: 'A' as const, ...call })), ...modelCallsOf(bundle.candidate).map(call => ({ side: 'B' as const, ...call }))].map((call, index) => ({ ...call, index: index + 1 })), drivers: buildDrivers(bundle.baseline, bundle.candidate, efficiency), divergences: buildDivergences(bundle.baseline, bundle.candidate, efficiency, reliability, context), behavior, recommendations: buildRecommendations(bundle.baseline, bundle.candidate, efficiency, reliability, context, behavior), dataQuality: { ...quality, warnings: [...new Set(quality.warnings)] }, provenance: { analyzerVersion: 'agent-workbench/1.0', schemaVersion: '1.0', metricDefinitionsVersion: '1.0', baselineSessionId: safeValue(bundle.baseline.ref.sessionId) as string, candidateSessionId: safeValue(bundle.candidate.ref.sessionId) as string, generatedAt },
  }
  const validation = validateComparisonReport(report); if (!validation.valid) throw new Error(`Comparison Report schema validation failed: ${validation.errors.join(' ')}`)
  return report
}
