import type { RunAnalysis } from '@/api'

export type Severity = 'high' | 'medium' | 'low' | 'info'
export type Verdict = 'pass' | 'fail' | 'unknown'

export type Diagnosis = {
  id: string
  severity: Severity
  title: string
  evidence: string[]
  impact?: string
  recommendation?: string
}

export type Recommendation = {
  id: string
  priority: Exclude<Severity, 'info'>
  title: string
  reason: string
  evidenceIds: string[]
}

export type RuntimeToolStat = {
  tool: string
  calls: number
  failed: number
  failureRate: number
  durationMs: number
  outputChars: number | null
}

export type TokenFlowMarker = {
  callIndex: number
  label: string
  kind: 'read' | 'tool_failure' | 'retry' | 'large_tool_output' | 'compaction'
}

export type SessionAnalysis = {
  outcome: RunAnalysis['outcome']['status']
  durationMs: number
  modelCalls: number | null
  toolCalls: number
  failedToolCalls: number
  retries: number
  compactions: number
  wasteSteps: number
  cumulativeInputTokens: number | null
  parsedPromptTokens: number | null
  averageInputTokens: number | null
  runtime: RuntimeToolStat[]
  skillTokens: number | null
  toolIOTokens: number | null
  diagnoses: Diagnosis[]
  recommendations: Recommendation[]
  tokenPoints: Array<{ index: number; inputTokens: number; atMs: number }>
  tokenMarkers: TokenFlowMarker[]
  contextSources: Array<{ category: string; tokens: number; known: boolean }>
}

const severityWeight: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 }
const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const compact = (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : `${Math.round(value)}`

function severityForRate(rate: number, failed: number): Severity {
  if (failed >= 3 && rate >= .35) return 'high'
  if (rate >= .25 || failed >= 3) return 'medium'
  if (rate >= .1) return 'low'
  return 'info'
}

function severityForRatio(ratio: number): Severity {
  return ratio > .2 ? 'high' : ratio >= .1 ? 'medium' : ratio >= .05 ? 'low' : 'info'
}

export function buildSessionAnalysis(run: RunAnalysis): SessionAnalysis {
  const observable = run.observable || {}
  const activity = observable.harnessActivity || {}
  const summary = observable.toolSummary || {}
  const trajectory = observable.trajectory || {}
  const footprint = (observable.promptFootprint || []) as Array<{ category: string; estimatedTokens: number; known: boolean }>
  const knownSources = footprint.filter(item => item.known && item.estimatedTokens > 0)
  const parsedPromptTokens = knownSources.length ? knownSources.reduce((sum, item) => sum + item.estimatedTokens, 0) : null
  const skillSource = footprint.find(item => item.category === 'skills')
  const toolSource = footprint.find(item => item.category === 'tools')
  const skillTokens = skillSource?.known ? skillSource.estimatedTokens : null
  const toolIOTokens = toolSource?.known ? toolSource.estimatedTokens : null
  const modelCalls = Number.isFinite(activity.modelCalls) ? Number(activity.modelCalls) : Array.isArray(run.v2?.modelCalls) ? run.v2.modelCalls.length : null
  const toolCalls = Number(summary.total) || 0
  const failedToolCalls = Number(summary.failed) || 0
  const runtimeMap = new Map<string, RuntimeToolStat>()
  for (const tool of observable.tools || []) {
    const key = tool.category || tool.transport || 'Other'
    const item = runtimeMap.get(key) || { tool: key, calls: 0, failed: 0, failureRate: 0, durationMs: 0, outputChars: 0 }
    item.calls += 1
    item.failed += tool.status === 'failed' ? 1 : 0
    item.durationMs += Number(tool.durationMs) || 0
    if (typeof tool.result === 'string' && tool.result) item.outputChars = (item.outputChars || 0) + [...tool.result].length
    runtimeMap.set(key, item)
  }
  const runtime = [...runtimeMap.values()].map(item => ({ ...item, failureRate: item.calls ? item.failed / item.calls : 0, outputChars: item.outputChars || null })).sort((a, b) => b.calls - a.calls)
  const diagnoses: Diagnosis[] = []
  const failureRate = toolCalls ? failedToolCalls / toolCalls : 0
  if (failedToolCalls) diagnoses.push({
    id: 'tool-failure', severity: severityForRate(failureRate, failedToolCalls), title: '工具执行不稳定',
    evidence: [`${failedToolCalls} / ${toolCalls} 次工具调用失败（${pct(failureRate)}）`, ...runtime.filter(item => item.failed).map(item => `${item.tool}：${item.failed} 次失败`)],
    impact: '可能引发重试与重复操作', recommendation: '先检查失败工具的参数、权限与输出边界。',
  })
  const activatedSkills = Array.isArray(activity.skillsUsed) ? activity.skillsUsed.length : 0
  if (skillTokens && !activatedSkills && parsedPromptTokens) {
    const ratio = skillTokens / parsedPromptTokens
    diagnoses.push({ id: 'unused-skills', severity: severityForRatio(ratio), title: '未使用的 Skill 上下文', evidence: [`0 个 Skill 被激活`, `Skill Catalog：${compact(skillTokens)} tokens（${pct(ratio)}）`], impact: '已加载但未使用，属于潜在上下文开销', recommendation: '按需加载 Skill Catalog，减少无关规则进入 Prompt。' })
  }
  if (toolIOTokens && parsedPromptTokens) {
    const ratio = toolIOTokens / parsedPromptTokens
    if (ratio >= .2) diagnoses.push({ id: 'tool-context', severity: ratio > .45 ? 'high' : ratio >= .3 ? 'medium' : 'low', title: '工具上下文偏大', evidence: [`Tool I/O：${compact(toolIOTokens)} tokens（${pct(ratio)}）`], impact: '过长的 Shell / Read 输出会持续抬高后续输入成本', recommendation: '限制 Shell / Read 输出长度，优先返回摘要或目标片段。' })
  }
  if ((modelCalls || 0) >= 12 && !observable.context?.compactions) diagnoses.push({ id: 'no-compaction', severity: 'low', title: '未观察到上下文压缩', evidence: [`${modelCalls} 次模型调用`, '压缩次数：0'], impact: '需要结合 Token 流向判断上下文是否持续膨胀', recommendation: '持续观察输入 Token 曲线，在接近窗口上限前触发压缩。' })
  const recommendations = diagnoses.filter(item => item.severity !== 'info').map(item => ({ id: item.id, priority: item.severity as Exclude<Severity, 'info'>, title: item.recommendation || item.title, reason: item.evidence.join('；'), evidenceIds: [item.id] })).sort((a, b) => severityWeight[b.priority] - severityWeight[a.priority]).slice(0, 3)
  const rawCalls = Array.isArray(run.v2?.modelCalls) ? run.v2.modelCalls : []
  const tokenPoints = rawCalls.filter((item: any) => Number.isFinite(Number(item.input))).map((item: any, index: number) => ({ index: index + 1, inputTokens: Number(item.input), atMs: Number(item.atMs) || 0 }))
  const callIndexFor = (atMs: number) => tokenPoints.length ? tokenPoints.reduce((best: typeof tokenPoints[number], point: typeof tokenPoints[number]) => Math.abs(point.atMs - atMs) < Math.abs(best.atMs - atMs) ? point : best, tokenPoints[0]).index : undefined
  const eventCandidates = (observable.tools || []).flatMap((tool: any) => {
    const callIndex = callIndexFor(Number(tool.endMs ?? tool.startMs) || 0)
    if (!callIndex) return []
    if (tool.category === 'Read' || /\b(cat|sed|head|tail|ls)\b/i.test(`${tool.name} ${tool.args}`)) return [{ callIndex, label: 'Read', kind: 'read' as const }]
    if (tool.status === 'failed' && tool.category === 'Shell') return [{ callIndex, label: 'Shell 失败', kind: 'tool_failure' as const }]
    if (tool.flags?.includes('mechanical-retry')) return [{ callIndex, label: '重试', kind: 'retry' as const }]
    if (typeof tool.result === 'string' && [...tool.result].length >= 10_000) return [{ callIndex, label: '工具输出过大', kind: 'large_tool_output' as const }]
    return []
  })
  const compacted = rawCalls.flatMap((call: any, index: number) => call.compacted && tokenPoints[index] ? [{ callIndex: tokenPoints[index].index, label: '压缩', kind: 'compaction' as const }] : [])
  const tokenMarkers = [...eventCandidates, ...compacted].sort((a, b) => a.callIndex - b.callIndex).filter((item, index, list) => index === list.findIndex(other => other.callIndex === item.callIndex || other.kind === item.kind)).slice(0, 4)
  const cumulativeInputTokens = observable.tokens?.input == null ? null : Number(observable.tokens.input)
  return {
    outcome: run.outcome?.status || 'unknown', durationMs: Number(observable.durationMs) || 0, modelCalls, toolCalls, failedToolCalls,
    retries: Number(summary.retryCount) || 0, compactions: Number(observable.context?.compactions) || 0, wasteSteps: trajectory.wasteActionIds?.length || 0,
    cumulativeInputTokens, parsedPromptTokens, averageInputTokens: cumulativeInputTokens != null && modelCalls ? cumulativeInputTokens / modelCalls : null,
    runtime, skillTokens, toolIOTokens, diagnoses: diagnoses.sort((a, b) => severityWeight[b.severity] - severityWeight[a.severity]), recommendations,
    tokenPoints, tokenMarkers, contextSources: footprint.map(item => ({ category: item.category, tokens: item.estimatedTokens, known: item.known })),
  }
}

export function evidenceVerdict(status?: string): Verdict {
  if (status === 'passed' || status === 'completed') return 'pass'
  if (status === 'failed') return 'fail'
  return 'unknown'
}
