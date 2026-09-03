import { attributeComparison, harnessLabel } from './attribution.js'
import { buildComparisonReport, type ComparisonBundle, type OptimizationGoal } from './comparison-report.js'
import type { RunAnalysis } from './types.js'

const normalize = (value: string | null | undefined) => value?.trim().toLowerCase() || ''
const relation = (left: string | null | undefined, right: string | null | undefined) => !left || !right ? 'unknown' as const : normalize(left) === normalize(right) ? 'same' as const : 'different' as const
const modelLabel = (run: RunAnalysis) => [run.identity.modelIdentity.model, run.identity.modelIdentity.reasoningEffort].filter(Boolean).join(' ') || 'Unknown'
const environmentLabel = (run: RunAnalysis) => [run.identity.environment.os, run.identity.environment.cwd, run.identity.environment.sandbox].filter(Boolean).join(' · ') || 'Unknown'
const environmentKnown = (run: RunAnalysis) => Boolean(run.identity.environment.os || run.identity.environment.cwd || run.identity.environment.sandbox)
const metric = (key: string, baseline: number | null, current: number | null) => ({ key, baseline, current, absoluteDelta: baseline != null && current != null ? current - baseline : null, relativeDelta: baseline != null && current != null && baseline !== 0 ? (current - baseline) / Math.abs(baseline) : null, direction: baseline == null || current == null ? 'unknown' : current === baseline ? 'same' : current > baseline ? 'increase' : 'decrease' })
const stepKey = (tool: any) => `${normalize(tool.name)}:${normalize(tool.args).replace(/\s+/g, ' ').slice(0, 160)}`

function trajectoryDiff(baseline: RunAnalysis, current: RunAnalysis) {
  const left = baseline.observable.tools; const right = current.observable.tools
  const matched = new Set<number>(); const steps: Array<{ side: 'baseline' | 'current'; index: number; label: string; state: 'same' | 'added' | 'removed' | 'repeated' | 'retry' | 'error' }> = []
  left.forEach((tool, index) => {
    const found = right.findIndex((candidate, candidateIndex) => !matched.has(candidateIndex) && stepKey(candidate) === stepKey(tool))
    if (found >= 0) { matched.add(found); steps.push({ side: 'baseline', index: index + 1, label: tool.label || tool.name, state: 'same' }) }
    else steps.push({ side: 'baseline', index: index + 1, label: tool.label || tool.name, state: 'removed' })
  })
  right.forEach((tool, index) => {
    if (matched.has(index)) return
    const state = tool.status === 'failed' ? 'error' : tool.flags.includes('mechanical-retry') ? 'retry' : tool.flags.includes('repeated') ? 'repeated' : 'added'
    steps.push({ side: 'current', index: index + 1, label: tool.label || tool.name, state })
  })
  const count = (state: string) => steps.filter(step => step.side === 'current' && step.state === state).length
  return { steps, summary: { added: count('added'), removed: steps.filter(step => step.side === 'baseline' && step.state === 'removed').length, repeated: count('repeated'), retries: count('retry'), errors: count('error') } }
}

export function compareRuns(baseline: RunAnalysis, candidate: RunAnalysis, controlled = false, taskTitle?: string | null, optimizationGoal?: OptimizationGoal) {
  const taskRelation = controlled ? 'same' : relation(baseline.identity.title, candidate.identity.title)
  const modelRelation = relation(modelLabel(baseline), modelLabel(candidate))
  const harnessRelation = relation(harnessLabel(baseline), harnessLabel(candidate))
  const environmentRelation = environmentKnown(baseline) && environmentKnown(candidate) ? relation(environmentLabel(baseline), environmentLabel(candidate)) : 'unknown'
  const variables = [
    { key: 'task', label: 'Task', left: controlled ? taskTitle || baseline.identity.title : baseline.identity.title, right: controlled ? taskTitle || candidate.identity.title : candidate.identity.title, relation: taskRelation },
    { key: 'model', label: 'Model', left: modelLabel(baseline), right: modelLabel(candidate), relation: modelRelation },
    { key: 'harness', label: 'Harness', left: harnessLabel(baseline), right: harnessLabel(candidate), relation: harnessRelation },
    { key: 'environment', label: 'Environment', left: environmentLabel(baseline), right: environmentLabel(candidate), relation: environmentRelation },
  ]
  const a = baseline.observable; const b = candidate.observable
  const metrics = [metric('durationMs', a.durationMs, b.durationMs), metric('ttftMs', a.ttftMs, b.ttftMs), metric('tokens.input', a.tokens.input, b.tokens.input), metric('tokens.output', a.tokens.output, b.tokens.output), metric('tokens.cachedInput', a.tokens.cachedInput, b.tokens.cachedInput), metric('tools.total', a.toolSummary.total, b.toolSummary.total), metric('tools.failed', a.toolSummary.failed, b.toolSummary.failed), metric('retries', a.toolSummary.retryCount, b.toolSummary.retryCount), metric('context.peakRatio', a.context.peakRatio, b.context.peakRatio), metric('compactions', a.context.compactions, b.context.compactions), metric('stepCount', a.tools.length, b.tools.length), metric('modelCalls', a.context.points.length, b.context.points.length)]
  const bundle: ComparisonBundle = { mode: controlled ? 'controlled' : 'exploratory', baseline, candidate, variables, metrics, trajectoryDiff: trajectoryDiff(baseline, candidate), attribution: attributeComparison(variables, metrics, controlled), coverage: { baseline: baseline.coverage, candidate: candidate.coverage } }
  return { ...bundle, comparisonReport: buildComparisonReport(bundle, { optimizationGoal }) }
}

export { buildComparisonReport, sanitizeForReport, validateComparisonReport } from './comparison-report.js'
