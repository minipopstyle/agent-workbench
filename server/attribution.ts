import type { RunAnalysis } from './types.js'

export type AttributionType = 'harness' | 'model' | 'environment' | 'inconclusive'
export type AttributionValidity = 'valid' | 'weak' | 'invalid'
export interface AttributionResult {
  type: AttributionType
  validity: AttributionValidity
  direction: 'regression' | 'improvement' | 'mixed' | 'neutral'
  evidence: Array<{ key: string; label: string; baseline: number; current: number; relativeDelta: number | null; direction: 'increase' | 'decrease' }>
  warnings: string[]
}

type Variable = { key: string; relation: 'same' | 'different' | 'similar' | 'unknown' }
type Delta = { key: string; baseline: number | null; current: number | null; relativeDelta: number | null }
const labels: Record<string, string> = { durationMs: 'Duration', ttftMs: 'TTFT', 'tokens.input': 'Input tokens', 'tokens.output': 'Output tokens', 'tools.total': 'Tool calls', 'tools.failed': 'Tool failures', retries: 'Retries', 'context.peakRatio': 'Peak context', compactions: 'Compactions', stepCount: 'Steps', modelCalls: 'Model calls' }
const health = new Set(Object.keys(labels))

export function attributeComparison(variables: Variable[], metrics: Delta[], controlled: boolean): AttributionResult {
  const byKey = Object.fromEntries(variables.map(item => [item.key, item])) as Record<string, Variable>
  const changed = ['model', 'harness', 'environment'].filter(key => byKey[key]?.relation === 'different')
  const warnings: string[] = []
  if (!controlled || byKey.task?.relation !== 'same') warnings.push('Tasks are not confirmed in the same Task Group; attribution is disabled.')
  if (changed.length !== 1) warnings.push(changed.length ? 'More than one main variable changed.' : 'No isolated main-variable change was observed.')
  if (byKey.environment?.relation === 'unknown') warnings.push('Environment metadata is incomplete.')
  const valid = controlled && byKey.task?.relation === 'same' && changed.length === 1
  const validity: AttributionValidity = valid ? byKey.environment?.relation === 'unknown' ? 'weak' : 'valid' : 'invalid'
  const type: AttributionType = validity === 'invalid' ? 'inconclusive' : changed[0] as AttributionType
  const evidence = metrics.flatMap(item => {
    if (!health.has(item.key) || item.baseline == null || item.current == null || item.baseline === item.current) return []
    return [{ key: item.key, label: labels[item.key] || item.key, baseline: item.baseline, current: item.current, relativeDelta: item.relativeDelta, direction: item.current > item.baseline ? 'increase' as const : 'decrease' as const }]
  })
  const worsened = evidence.filter(item => item.direction === 'increase').length
  const improved = evidence.filter(item => item.direction === 'decrease').length
  const direction = !evidence.length ? 'neutral' : worsened >= 2 && worsened > improved ? 'regression' : improved >= 2 && improved > worsened ? 'improvement' : 'mixed'
  return { type, validity, direction: type === 'inconclusive' ? 'neutral' : direction, evidence: evidence.slice(0, 6), warnings }
}

export const harnessLabel = (run: RunAnalysis) => [run.identity.harness.family, run.identity.harness.version].filter(Boolean).join(' ') || 'Unknown'
