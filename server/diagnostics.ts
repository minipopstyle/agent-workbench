import { compareRuns } from './comparison.js'
import { runKey } from './run-analysis.js'
import type { RunAnalysis, RunRef } from './types.js'

const metricSnapshot = (run: RunAnalysis) => ({ durationMs: run.observable.durationMs, inputTokens: run.observable.tokens.input, toolCalls: run.observable.toolSummary.total, failures: run.observable.toolSummary.failed, retries: run.observable.toolSummary.retryCount, peakContextRatio: run.observable.context.peakRatio, compactions: run.observable.context.compactions, stepCount: run.observable.tools.length })

export function buildTaskDiagnostics(title: string, runs: RunAnalysis[], baselineRef?: RunRef) {
  const baseline = baselineRef ? runs.find(run => runKey(run.ref) === runKey(baselineRef)) : undefined
  const entries = runs.map(run => ({ ref: run.ref, title: run.identity.title, model: [run.identity.modelIdentity.model, run.identity.modelIdentity.reasoningEffort].filter(Boolean).join(' ') || 'Unknown', harness: [run.identity.harness.family, run.identity.harness.version].filter(Boolean).join(' ') || 'Unknown', outcome: run.outcome.status, metrics: metricSnapshot(run), signals: run.behavioralSignals.map(signal => ({ type: signal.type, severity: signal.severity, message: signal.evidence.message })) }))
  const comparisons = baseline ? runs.filter(run => run !== baseline).map(run => { const comparison = compareRuns(baseline, run, true, title); return { ref: run.ref, variables: comparison.variables, metrics: comparison.metrics, trajectory: comparison.trajectoryDiff.summary, attribution: comparison.attribution } }) : []
  const detected = comparisons.reduce<Record<string, number>>((all, comparison) => comparison.attribution.type === 'inconclusive' ? all : { ...all, [comparison.attribution.type]: (all[comparison.attribution.type] || 0) + 1 }, {})
  return { baseline: baseline?.ref || null, entries, comparisons, detected }
}
