import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { ArrowLeftRight, BarChart3, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleHelp, Clock3, Coins, Download, FileUp, GitCompareArrows, Gauge, Layers3, RotateCcw, Settings2, ShieldCheck, Target, Wrench, X, Zap } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, sessionTitle, type ComparisonExportFormat, type ComparisonReport, type RunAnalysis, type RunSource, type Session } from '@/api'
import { TrajectoryView } from '@/features/runs/RunReportPage'

type Ref = { source: RunSource; id?: string; sessionId?: string; turnId?: string }
type Relation = 'same' | 'different' | 'unknown'
type CompareResultData = {
  mode: 'controlled' | 'exploratory'
  baseline: RunAnalysis
  candidate: RunAnalysis
  variables: Array<{ key: string; label: string; left: string | null; right: string | null; relation: string }>
  metrics: Array<{ key: string; baseline: number | null; current: number | null; absoluteDelta: number | null; relativeDelta: number | null }>
  trajectoryDiff: { summary: Record<string, number>; steps: Array<{ side: 'baseline' | 'current'; index: number; label: string; state: string }> }
  attribution: { type: string; validity: string; direction: string; warnings: string[] }
  comparisonReport: ComparisonReport
}
type Optimization = 'balanced' | 'quality' | 'cost' | 'speed' | 'reliability'
type CompareDimension = { key: string; label: string; left: string; right: string; status: Relation; experimental?: boolean }
type SummaryRow = { key: string; label: string; icon: ReactNode; a: string; b: string; delta: string; better: 'A' | 'B' | '—' }
type FullTrace = { run: RunAnalysis; side: 'A' | 'B' }

const evidenceRows = [['task_complete', 'Task Completed'], ['test', 'Tests'], ['build', 'Build'], ['lint', 'Lint'], ['artifact', 'Artifact'], ['command', 'Git Diff'], ['user_confirmation', 'Human Confirmation']] as const
const optimizationLabels: Record<Optimization, string> = { balanced: 'Balanced', quality: 'Quality First', cost: 'Cost First', speed: 'Speed First', reliability: 'Reliability First' }
const relationText: Record<string, string> = { same: '相同', similar: '相近', different: '已变化', unknown: '未知' }
const outcomeLabels: Record<string, string> = { success: 'Verified Success', partial: 'Partial Success', failed: 'Failed', unknown: 'Unverified Success' }
const sourceLabels: Record<RunSource, string> = { codex: 'Codex', claude: 'Claude', workbuddy: 'WorkBuddy', import: 'Import' }
const footprintColors: Record<string, string> = { system: '#2c70e8', developer: '#36a9bd', skills: '#7659d9', tools: '#f1a126', permissions: '#e84f72', environment: '#14b8a6', apps: '#8b5cf6', userHistory: '#94a3b8' }
const footprintLabels: Record<string, string> = { system: 'System', developer: 'Developer', skills: 'Skills', tools: 'Tool I/O', permissions: 'Memory', environment: 'Environment', apps: 'Apps', userHistory: 'Conversation' }

const sessionOf = (ref: Ref | null) => ref?.sessionId || ref?.id || ''
const refValue = (ref: Ref | null) => ref ? `${ref.source}:${sessionOf(ref)}` : ''
const refFromValue = (value: string, turnId?: string): Ref | null => {
  const pivot = value.indexOf(':')
  if (pivot < 1) return null
  const source = value.slice(0, pivot) as RunSource
  const id = value.slice(pivot + 1)
  return source === 'import' ? { source, id } : { source, sessionId: id, turnId }
}
const sourceFromParam = (value: string | null): RunSource => ['codex', 'claude', 'workbuddy', 'import'].includes(value || '') ? value as RunSource : 'codex'
const formatDuration = (value?: number | null) => {
  if (value == null) return '—'
  const seconds = Math.max(0, Math.round(value / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const formatNumber = (value?: number | null) => value == null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString()
const formatTokens = (value?: number | null) => {
  if (value == null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
}
const signed = (value: number | null, formatter: (value: number) => string = formatNumber) => value == null ? '—' : `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatter(Math.abs(value))}`
const toBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(value)
}
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const observable = (run: RunAnalysis) => run.observable || {}
const toolsOf = (run: RunAnalysis) => Array.isArray(observable(run).tools) ? observable(run).tools : []
const toolSummary = (run: RunAnalysis) => observable(run).toolSummary || {}
const activity = (run: RunAnalysis) => observable(run).harnessActivity || {}
const tokensOf = (run: RunAnalysis) => observable(run).tokens || {}
const contextOf = (run: RunAnalysis) => observable(run).context || {}

function relation(left: unknown, right: unknown): Relation {
  const unknown = new Set(['', 'unknown', '—', 'n/a', 'null'])
  if (left == null || right == null || unknown.has(String(left).trim().toLowerCase()) || unknown.has(String(right).trim().toLowerCase())) return 'unknown'
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase() ? 'same' : 'different'
}

function harnessLabel(run: RunAnalysis) {
  const harness = run.identity?.harness || {}
  return [harness.family, harness.version].filter(Boolean).join(' · ') || 'Unknown'
}

function modelLabel(run: RunAnalysis) {
  const identity = run.identity?.modelIdentity || {}
  return [identity.model || run.identity?.model, identity.reasoningEffort || run.identity?.effort].filter(Boolean).join(' · ') || 'Unknown'
}

function environmentLabel(run: RunAnalysis) {
  const environment = run.identity?.environment || {}
  return [environment.os, environment.sandbox].filter(Boolean).join(' · ') || 'Unknown'
}

function workingDirectory(run: RunAnalysis) {
  return run.identity?.environment?.cwd || run.identity?.projectPath || 'Unknown'
}

function commitLabel(run: RunAnalysis) {
  const identity = run.identity as any
  const v2 = run.v2 as any
  return identity.commit || identity.commitSha || v2?.commit || v2?.metadata?.commit || 'Unknown'
}

function buildDimensions(result: CompareResultData): CompareDimension[] {
  const left = result.baseline
  const right = result.candidate
  const variable = (key: string) => result.variables.find(item => item.key === key)
  const fromVariable = (key: string, fallbackLeft: string, fallbackRight: string): CompareDimension => {
    const item = variable(key)
    return { key, label: item?.label || key, left: item?.left || fallbackLeft, right: item?.right || fallbackRight, status: (item?.relation === 'similar' ? 'same' : item?.relation || relation(fallbackLeft, fallbackRight)) as Relation }
  }
  return [
    fromVariable('task', left.identity?.title || 'Unknown', right.identity?.title || 'Unknown'),
    { key: 'model', label: 'Model', left: modelLabel(left), right: modelLabel(right), status: relation(modelLabel(left), modelLabel(right)) },
    { key: 'harness', label: 'Harness', left: harnessLabel(left), right: harnessLabel(right), status: relation(harnessLabel(left), harnessLabel(right)), experimental: true },
    { key: 'environment', label: 'Environment', left: environmentLabel(left), right: environmentLabel(right), status: relation(environmentLabel(left), environmentLabel(right)) },
    { key: 'repository', label: 'Repository', left: left.identity?.projectPath || 'Unknown', right: right.identity?.projectPath || 'Unknown', status: relation(left.identity?.projectPath, right.identity?.projectPath) },
    { key: 'commit', label: 'Commit', left: commitLabel(left), right: commitLabel(right), status: relation(commitLabel(left), commitLabel(right)) },
    { key: 'input', label: 'Input', left: left.identity?.title || 'Unknown', right: right.identity?.title || 'Unknown', status: relation(left.identity?.title, right.identity?.title) },
    { key: 'cwd', label: 'Working Directory', left: workingDirectory(left), right: workingDirectory(right), status: relation(workingDirectory(left), workingDirectory(right)) },
  ]
}

function validityFor(result: CompareResultData, dimensions: CompareDimension[]) {
  const weights: Record<string, number> = { task: 30, input: 20, model: 15, environment: 10, repository: 10, commit: 10, harness: 5 }
  const score = Math.round(dimensions.reduce((total, item) => {
    const weight = weights[item.key] || 0
    if (item.experimental) return total + (item.status === 'unknown' ? weight * .35 : weight)
    return total + (item.status === 'same' ? weight : item.status === 'unknown' ? weight * .35 : 0)
  }, 0))
  const level = score >= 85 ? 'High' : score >= 50 ? 'Medium' : score >= 25 ? 'Low' : 'Invalid'
  const changed = dimensions.filter(item => item.status === 'different' && !item.experimental).map(item => item.label)
  const explanation = result.mode === 'controlled' && !changed.length
    ? '当前可用于行为差异分析；Harness 作为实验变量处理，不降低归因可信度。'
    : changed.length
      ? `当前可用于行为差异分析，但 ${changed.join('、')} 未确认一致，不能将结果差异完全归因于 Harness。`
      : '当前为探索性对比，结果用于观察差异，不构成因果归因。'
  return { score, level, explanation }
}

function evidenceState(run: RunAnalysis, type: string): 'passed' | 'failed' | 'unknown' | 'none' {
  const rows = run.outcome?.evidence?.filter(item => item.type === type) || []
  if (!rows.length && type === 'task_complete' && run.outcome?.status === 'success') return 'passed'
  if (!rows.length) return 'none'
  if (rows.some(item => item.status === 'failed')) return 'failed'
  if (rows.some(item => item.status === 'passed' || item.status === 'completed')) return 'passed'
  return 'unknown'
}

function evidenceStats(run: RunAnalysis) {
  const states = evidenceRows.map(([type]) => evidenceState(run, type))
  const usable = states.filter(state => state !== 'none' && state !== 'unknown').length
  const observed = states.filter(state => state !== 'none').length
  return { usable, observed, total: states.length, coverage: states.length ? usable / states.length * 100 : 0 }
}

function outcomeLabel(run: RunAnalysis) {
  const status = run.outcome?.status || 'unknown'
  if (status === 'success' && evidenceStats(run).coverage >= 70) return outcomeLabels.success
  return outcomeLabels[status] || outcomeLabels.unknown
}

function betterFor(a: number | null, b: number | null, lowerIsBetter: boolean): 'A' | 'B' | '—' {
  if (a == null || b == null || a === b) return '—'
  if (lowerIsBetter) return a < b ? 'A' : 'B'
  return a > b ? 'A' : 'B'
}

function buildSummaryRows(a: RunAnalysis, b: RunAnalysis): SummaryRow[] {
  const aEvidence = evidenceStats(a)
  const bEvidence = evidenceStats(b)
  const runtimeA = num(observable(a).durationMs)
  const runtimeB = num(observable(b).durationMs)
  const tokenA = num(tokensOf(a).total)
  const tokenB = num(tokensOf(b).total)
  const failureA = num(toolSummary(a).failed)
  const failureB = num(toolSummary(b).failed)
  const retryA = num(toolSummary(a).retryCount) ?? num(observable(a).trajectory?.mechanicalRetries)
  const retryB = num(toolSummary(b).retryCount) ?? num(observable(b).trajectory?.mechanicalRetries)
  const coverageA = aEvidence.coverage
  const coverageB = bEvidence.coverage
  return [
    { key: 'runtime', label: 'Runtime', icon: <Clock3 size={13} />, a: formatDuration(runtimeA), b: formatDuration(runtimeB), delta: signed(runtimeB != null && runtimeA != null ? runtimeB - runtimeA : null, value => formatDuration(Math.abs(value))), better: betterFor(runtimeA, runtimeB, true) },
    { key: 'tokens', label: 'Total Tokens', icon: <Layers3 size={13} />, a: formatTokens(tokenA), b: formatTokens(tokenB), delta: signed(tokenB != null && tokenA != null ? tokenB - tokenA : null, value => formatTokens(Math.abs(value))), better: betterFor(tokenA, tokenB, true) },
    { key: 'failed', label: 'Failed Calls', icon: <CircleAlert size={13} />, a: formatNumber(failureA), b: formatNumber(failureB), delta: signed(failureB != null && failureA != null ? failureB - failureA : null), better: betterFor(failureA, failureB, true) },
    { key: 'retry', label: 'Retry', icon: <RotateCcw size={13} />, a: formatNumber(retryA), b: formatNumber(retryB), delta: signed(retryB != null && retryA != null ? retryB - retryA : null), better: betterFor(retryA, retryB, true) },
    { key: 'evidence', label: 'Evidence Coverage', icon: <ShieldCheck size={13} />, a: `${Math.round(coverageA)}%`, b: `${Math.round(coverageB)}%`, delta: signed(coverageB - coverageA, value => `${Math.round(Math.abs(value))}pp`), better: betterFor(coverageA, coverageB, false) },
  ]
}

function judgement(rows: SummaryRow[]) {
  const aWins = rows.filter(row => row.better === 'A').length
  const bWins = rows.filter(row => row.better === 'B').length
  if (!aWins && !bWins) return 'Insufficient Evidence'
  if (aWins >= rows.length - 1 && !bWins) return 'A Dominates'
  if (bWins >= rows.length - 1 && !aWins) return 'B Dominates'
  return 'Trade-off'
}

function traceTime(run: RunAnalysis) {
  const duration = num(observable(run).durationMs) || 0
  return duration > 0 ? duration : Math.max(...toolsOf(run).map((tool: any) => Number(tool.endMs) || 0), 1)
}

function countTools(run: RunAnalysis, pattern: RegExp) {
  return toolsOf(run).filter((tool: any) => pattern.test(`${tool.category || ''} ${tool.name || ''} ${tool.label || ''} ${tool.args || ''}`)).length
}

function signalCount(run: RunAnalysis, patterns: string[]) {
  return (run.behavioralSignals || []).filter(signal => patterns.includes(signal.type)).length
}

function contextItems(run: RunAnalysis): Array<{ category: string; tokens: number }> {
  return (observable(run).promptFootprint || []).filter((item: any) => item.known && Number(item.estimatedTokens) > 0).map((item: any) => ({ category: item.category, tokens: Number(item.estimatedTokens) || 0 }))
}

// ponytail: estimate waste from observed repeated actions; replace with payload hashes when per-payload attribution exists.
function contextWaste(run: RunAnalysis) {
  const repeated = Number(observable(run).trajectory?.repeatedActions) || signalCount(run, ['repeated_read', 'repeated_tool_call', 'backtrack'])
  const tools = contextItems(run).find(item => item.category === 'tools')?.tokens || 0
  const total = contextItems(run).reduce((sum, item) => sum + item.tokens, 0)
  if (!total) return { tokens: null, rate: null }
  const tokens = repeated ? Math.min(tools, repeated * Math.max(1, tools / Math.max(1, toolsOf(run).length))) : 0
  return { tokens, rate: tokens / total * 100 }
}

function runtimeToolTime(run: RunAnalysis) {
  return toolsOf(run).reduce((sum: number, tool: any) => sum + (Number(tool.durationMs) || 0), 0)
}

export function ComparePage() {
  const [params, setParams] = useSearchParams()
  const [sessions, setSessions] = useState<Session[]>([])
  const [savedImports, setSavedImports] = useState<Array<{ id: string; snapshot: any; savedAt: string }>>([])
  const [baseline, setBaseline] = useState<Ref | null>(params.get('baselineSession') ? { source: sourceFromParam(params.get('baselineSource')), sessionId: params.get('baselineSession')!, turnId: params.get('baselineTurn') || undefined } : params.get('baseline') ? { source: 'codex', id: params.get('baseline')! } : null)
  const [candidate, setCandidate] = useState<Ref | null>(params.get('candidateSession') ? { source: sourceFromParam(params.get('candidateSource')), sessionId: params.get('candidateSession')!, turnId: params.get('candidateTurn') || undefined } : params.get('candidate') ? { source: 'codex', id: params.get('candidate')! } : null)
  const [result, setResult] = useState<CompareResultData | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const taskId = params.get('task') || undefined

  useEffect(() => {
    Promise.all([api.sessions(), api.savedImports()]).then(([local, saved]) => { setSessions(local); setSavedImports(saved) }).catch(err => setError(err instanceof Error ? err.message : '加载 Session 失败'))
  }, [])

  useEffect(() => {
    if (!baseline || !candidate) return
    api.compare(baseline, candidate, taskId).then(value => {
      setResult(value); setError('')
      const next = new URLSearchParams()
      if (taskId) next.set('task', taskId)
      next.set('baselineSource', baseline.source); next.set('baselineSession', sessionOf(baseline)); if (baseline.turnId) next.set('baselineTurn', baseline.turnId)
      next.set('candidateSource', candidate.source); next.set('candidateSession', sessionOf(candidate)); if (candidate.turnId) next.set('candidateTurn', candidate.turnId)
      setParams(next)
    }).catch(err => setError(err instanceof Error ? err.message : '比较失败'))
  }, [baseline, candidate, setParams, taskId])

  useEffect(() => {
    if (!exportOpen) return
    const closeOnOutside = (event: PointerEvent) => { if (!exportMenuRef.current?.contains(event.target as Node)) setExportOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExportOpen(false) }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape) }
  }, [exportOpen])

  const importFile = async (event: ChangeEvent<HTMLInputElement>, slot: 'baseline' | 'candidate') => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const imported = await api.importTrace(file.name, toBase64(await file.arrayBuffer()))
      const ref: Ref = { source: 'import', id: imported.descriptor.id }
      if (slot === 'baseline') setBaseline(ref); else setCandidate(ref)
      const trace = imported.normalized
      const format = trace?.source?.format === 'deepseek-harness' ? 'DeepSeek Harness' : 'Session'
      const diagnostics = imported.parseDiagnostics
      const warning = diagnostics && (diagnostics.malformedLines || diagnostics.ignoredEvents) ? `；已忽略 ${diagnostics.malformedLines || 0} 行、${diagnostics.ignoredEvents || 0} 个非核心事件` : ''
      const details = trace ? [sessionTitle(imported.descriptor, 20), trace.source.model, `${trace.turns.length} Turn${trace.turns.length === 1 ? '' : 's'}`, `${trace.stats.toolCalls} Tool Calls`, `${(trace.stats.inputTokens || 0) + (trace.stats.outputTokens || 0)} Tokens`].filter(Boolean).join(' · ') : sessionTitle(imported.descriptor, 20)
      setNotice(`已导入 ${format} Session：${details}${warning}`); setError('')
    } catch (err) { setNotice(''); setError(err instanceof Error ? err.message : '导入失败') }
  }
  const saveImported = async (ref: Ref | null) => {
    if (!ref || ref.source !== 'import') return
    try { await api.saveImport(sessionOf(ref)); setNotice('已保存规范化 Import；原始 JSONL 未写入侧车。'); setError('') }
    catch (err) { setNotice(''); setError(err instanceof Error ? err.message : '保存导入失败') }
  }
  const downloadBlob = (blob: Blob, filename: string) => { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0) }
  const exportComparison = async (format: ComparisonExportFormat) => {
    if (!baseline || !candidate) return
    setExportOpen(false)
    try { const result = await api.exportComparison(baseline, candidate, format, taskId); downloadBlob(result.blob, result.filename); setError('') }
    catch (err) { setNotice(''); setError(err instanceof Error ? err.message : '导出失败') }
  }
  const formatLabel = (session: Session) => session.sourceFormat === 'deepseek-harness' ? 'DSH' : sourceLabels[session.source]
  const options = <>{sessions.map(session => <option key={`${session.source}:${session.id}`} value={`${session.source}:${session.id}`}>{sessionTitle(session, 20)} · {formatLabel(session)} · {session.model || 'Unknown model'} · {session.turnCount || 0} Turn{session.turnCount === 1 ? '' : 's'} · {session.status}</option>)}{savedImports.length ? <optgroup label="Saved imports">{savedImports.map(item => <option key={item.id} value={`import:${item.id}`}>{sessionTitle(item.snapshot.descriptor, 20)} · {item.snapshot.descriptor.sourceFormat === 'deepseek-harness' ? 'DSH' : 'Import'} · {item.snapshot.descriptor.model || 'Unknown model'} · {item.snapshot.descriptor.turnCount || 0} Turn{item.snapshot.descriptor.turnCount === 1 ? '' : 's'} · saved</option>)}</optgroup> : null}</>

  return <main className="aw-compare-page aw-compare-page-v3">
    <section className="aw-page-header aw-compare-header"><div className="aw-page-title-group"><h2>Trace Compare</h2><span className="aw-counter-badge">{taskId ? 'Task group context' : 'Exploratory A/B'}</span></div><div className="aw-compare-header-actions"><button type="button" className="aw-icon-button" aria-label="比较说明"><CircleHelp size={15} /></button><button type="button" className="aw-icon-button" aria-label="比较设置"><Settings2 size={15} /></button>{import.meta.env.DEV && <Link className="aw-btn-view" to={`/debug/comparison-report?${params.toString()}`}>Debug</Link>}<div className="aw-export-menu" ref={exportMenuRef}><button type="button" className="aw-btn-compare aw-export-trigger" aria-haspopup="menu" aria-expanded={exportOpen} aria-controls="comparison-export-menu" onClick={() => setExportOpen(value => !value)}><Download size={13} /><span>导出报告</span><ChevronDown className="aw-export-chevron" size={13} aria-hidden="true" /></button>{exportOpen && <div id="comparison-export-menu" className="aw-export-popover" role="menu"><button type="button" role="menuitem" disabled={!baseline || !candidate} onClick={() => void exportComparison('html')}>HTML 可视化报告 <small>推荐 · offline</small></button><button type="button" role="menuitem" disabled={!baseline || !candidate} onClick={() => void exportComparison('report-json')}>报告数据 JSON <small>comparison-report.json</small></button><button type="button" role="menuitem" disabled={!baseline || !candidate} onClick={() => void exportComparison('bundle-json')}>完整分析 JSON <small>comparison-bundle.json</small></button></div>}</div></div></section>
    <section className="aw-compare-selector-wrap">
      <div className="aw-compare-selectors">
        <Picker label="Baseline A (基准路径)" accent="blue" value={refValue(baseline)} turnId={baseline?.turnId || ''} run={result?.baseline} options={options} onChange={value => setBaseline(refFromValue(value, baseline?.turnId))} onTurnChange={turnId => setBaseline(value => value ? { ...value, turnId: turnId || undefined } : value)} onImport={event => importFile(event, 'baseline')} />
        <Picker label="Candidate B (候选路径)" accent="green" value={refValue(candidate)} turnId={candidate?.turnId || ''} run={result?.candidate} options={options} onChange={value => setCandidate(refFromValue(value, candidate?.turnId))} onTurnChange={turnId => setCandidate(value => value ? { ...value, turnId: turnId || undefined } : value)} onImport={event => importFile(event, 'candidate')} />
      </div>
      <button className="aw-compare-swap aw-compare-swap-center" type="button" onClick={() => { setBaseline(candidate); setCandidate(baseline) }} disabled={!baseline || !candidate} aria-label="交换 A / B"><ArrowLeftRight size={14} /></button>
    </section>
    {(baseline?.source === 'import' || candidate?.source === 'import') && <div className="aw-import-save"><span>Imported traces are memory-only until explicitly saved.</span>{baseline?.source === 'import' && <button type="button" className="aw-btn-view" onClick={() => void saveImported(baseline)}>Save A</button>}{candidate?.source === 'import' && <button type="button" className="aw-btn-view" onClick={() => void saveImported(candidate)}>Save B</button>}</div>}
    {notice && <div className="aw-inline-notice">{notice}</div>}
    {error && <div className="aw-inline-error"><CircleAlert size={15} />{error}</div>}
    {!result ? <section className="aw-empty" style={{ padding: '48px 16px' }}><GitCompareArrows size={26} color="#2563eb" /><b>{baseline || candidate ? '请选择另一条 Session' : '选择两条 Session 开始对比'}</b><p>从本地会话下拉选择，或通过导入按钮上传快照</p></section> : <CompareResult result={result} />}
  </main>
}

function Picker({ label, accent, value, turnId, run, options, onChange, onTurnChange, onImport }: { label: string; accent: 'blue' | 'green'; value: string; turnId: string; run?: RunAnalysis; options: ReactNode; onChange: (value: string) => void; onTurnChange: (value: string) => void; onImport: (event: ChangeEvent<HTMLInputElement>) => void }) {
  const id = value ? value.split(':').slice(1).join(':') : '未选择'
  return <article className={`aw-picker-card ${accent}`}><div className="aw-picker-top"><div><span>{label}</span><b>{id.slice(0, 18)}</b></div>{run && <strong>{run.identity?.status || 'unknown'}</strong>}</div><div className="aw-picker-meta"><span>{run?.identity?.startedAt ? new Date(run.identity.startedAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '选择本地 Session'}</span><span>{run ? formatDuration(run.observable?.durationMs) : '—'}</span><span>{run ? `${formatTokens(run.observable?.tokens?.total)} tokens` : '—'}</span></div><div className="aw-picker-row"><select value={value} onChange={event => onChange(event.target.value)}><option value="">-- 选择本地会话 --</option>{options}</select><label className="aw-import-btn"><FileUp size={12} /> 导入<input type="file" accept=".jsonl,.zstd,.jsonl.zstd" onChange={onImport} /></label></div><input className="aw-turn-input" value={turnId} onChange={event => onTurnChange(event.target.value)} placeholder="Specific Turn ID (leave blank = latest)" aria-label={`${label} Turn ID`} /></article>
}

function CompareResult({ result }: { result: CompareResultData }) {
  const [optimization, setOptimization] = useState<Optimization>('balanced')
  const [focusedStep, setFocusedStep] = useState<number | null>(null)
  const [fullTrace, setFullTrace] = useState<FullTrace | null>(null)
  const dimensions = useMemo(() => buildDimensions(result), [result])
  const validity = useMemo(() => validityFor(result, dimensions), [dimensions, result])
  const rows = useMemo(() => buildSummaryRows(result.baseline, result.candidate), [result.baseline, result.candidate])
  const locate = (index: number) => { setFocusedStep(index); window.setTimeout(() => document.getElementById('aw-compare-trajectories')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0) }
  return <>
    <ValidityCard dimensions={dimensions} validity={validity} result={result} />
    <SummarySection rows={rows} baseline={result.baseline} candidate={result.candidate} optimization={optimization} onOptimizationChange={setOptimization} />
    <section className="aw-compare-four-grid">
      <OutcomePanel baseline={result.baseline} candidate={result.candidate} />
      <EfficiencyPanel baseline={result.baseline} candidate={result.candidate} />
      <ReliabilityPanel baseline={result.baseline} candidate={result.candidate} />
      <ContextEfficiencyPanel baseline={result.baseline} candidate={result.candidate} />
    </section>
    <section className="aw-compare-two-grid">
      <CostDriverDelta baseline={result.baseline} candidate={result.candidate} />
      <DivergencePanel result={result} onLocate={locate} />
    </section>
    <TrajectorySection baseline={result.baseline} candidate={result.candidate} result={result} focusedStep={focusedStep} onFocus={setFocusedStep} onOpenFullTrace={(run, side) => setFullTrace({ run, side })} />
    <section className="aw-compare-bottom-grid">
      <BehaviorDelta baseline={result.baseline} candidate={result.candidate} />
      <BehaviorPatterns baseline={result.baseline} candidate={result.candidate} />
      <Recommendations baseline={result.baseline} candidate={result.candidate} optimization={optimization} />
    </section>
    <FullTraceDialog trace={fullTrace} onClose={() => setFullTrace(null)} />
  </>
}

function PanelHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <header className="aw-compare-panel-header"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{action}</header>
}

function ValidityCard({ dimensions, validity, result }: { dimensions: CompareDimension[]; validity: ReturnType<typeof validityFor>; result: CompareResultData }) {
  return <section className={`aw-cv-card ${validity.level.toLowerCase()}`}><div className="aw-cv-heading"><div><span className="aw-section-kicker">COMPARISON VALIDITY</span><h3>对比有效性 <small>/ Comparison Validity</small></h3></div><div className="aw-cv-confidence"><span>归因可信度</span><strong>{validity.score}%</strong><em>{validity.level}</em></div></div><div className="aw-cv-body"><div className="aw-cv-dimensions">{dimensions.map(item => <div className="aw-cv-dimension" key={item.key}><span>{item.label}</span><b className={item.status}>{item.status === 'same' ? '✓' : item.status === 'different' ? '△' : '?'} {relationText[item.status]}</b>{item.experimental && <small>实验变量</small>}</div>)}</div><div className="aw-cv-explanation"><b>{result.mode === 'controlled' ? 'Controlled comparison' : 'Exploratory comparison'}</b><p>{validity.explanation}</p></div></div></section>
}

function SummarySection({ rows, baseline, candidate, optimization, onOptimizationChange }: { rows: SummaryRow[]; baseline: RunAnalysis; candidate: RunAnalysis; optimization: Optimization; onOptimizationChange: (value: Optimization) => void }) {
  const verdict = judgement(rows)
  const aGood = rows.filter(row => row.better === 'A').map(row => row.label.toLowerCase()).slice(0, 2).join('、')
  const bGood = rows.filter(row => row.better === 'B').map(row => row.label.toLowerCase()).slice(0, 2).join('、')
  const narrative = verdict === 'Trade-off' ? `A 在 ${aGood || '稳定性'} 更有优势，B 在 ${bGood || '速度'} 更有优势。` : verdict === 'A Dominates' ? 'A 在当前可观测指标上整体更稳健。' : verdict === 'B Dominates' ? 'B 在当前可观测指标上整体更优。' : '当前证据不足以判断哪条路径更好。'
  return <section className="aw-summary-section"><div className="aw-summary-heading"><div><span className="aw-section-kicker">A / B ANALYSIS</span><h3>比较结论 <small>/ Comparison Summary</small></h3><div className={`aw-verdict ${verdict === 'Trade-off' ? 'tradeoff' : verdict === 'A Dominates' ? 'a' : verdict === 'B Dominates' ? 'b' : 'unknown'}`}>{verdict}</div><p>{narrative} 不使用单一综合评分，原始指标保留在下方。</p></div><div className="aw-optimization"><span>优化目标</span><div>{(Object.keys(optimizationLabels) as Optimization[]).map(value => <button type="button" className={optimization === value ? 'active' : ''} key={value} onClick={() => onOptimizationChange(value)}>{optimizationLabels[value]}</button>)}</div></div></div><div className="aw-summary-metrics">{rows.map(row => <article key={row.key}><div className="aw-summary-metric-title">{row.icon}<b>{row.label}</b></div><div className="aw-summary-metric-values"><span><small>A</small>{row.a}</span><span><small>B</small>{row.b}</span><strong className={row.delta.startsWith('-') ? 'good' : row.delta.startsWith('+') ? 'bad' : ''}>{row.delta}</strong><em>Better <b className={row.better.toLowerCase()}>{row.better}</b></em></div></article>)}</div><div className="aw-summary-foot"><span><b>A</b> {outcomeLabel(baseline)} · {formatTokens(tokensOf(baseline).total)} total tokens</span><span><b>B</b> {outcomeLabel(candidate)} · {formatTokens(tokensOf(candidate).total)} total tokens</span></div></section>
}

function StatusMark({ state }: { state: 'passed' | 'failed' | 'unknown' | 'none' }) {
  return <span className={`aw-status-mark ${state}`}>{state === 'passed' ? <Check size={11} /> : state === 'failed' ? <X size={11} /> : <span>{state === 'none' ? '—' : '?'}</span>}</span>
}

function OutcomePanel({ baseline, candidate }: { baseline: RunAnalysis; candidate: RunAnalysis }) {
  const aStats = evidenceStats(baseline); const bStats = evidenceStats(candidate)
  return <article className="aw-compare-card aw-outcome-compare"><PanelHeader title="结果与证据" subtitle="Outcome & Evidence" action={<span className="aw-card-badge">{aStats.usable + bStats.usable} 条已观测</span>} /><div className="aw-outcome-result"><div><span>A</span><b>{outcomeLabel(baseline)}</b></div><div><span>B</span><b>{outcomeLabel(candidate)}</b></div></div><div className="aw-compact-table aw-evidence-table-v3"><div className="head"><span>Evidence</span><b>A</b><b>B</b></div>{evidenceRows.map(([type, label]) => <div key={type}><span>{label}</span><StatusMark state={evidenceState(baseline, type)} /><StatusMark state={evidenceState(candidate, type)} /></div>)}</div><div className="aw-coverage-pair"><span><b>{aStats.usable} / {aStats.total}</b> usable · {Math.round(aStats.coverage)}%</span><span><b>{bStats.usable} / {bStats.total}</b> usable · {Math.round(bStats.coverage)}%</span></div></article>
}

function EfficiencyPanel({ baseline, candidate }: { baseline: RunAnalysis; candidate: RunAnalysis }) {
  const rows: Array<[string, string, string]> = [
    ['Wall Time', formatDuration(observable(baseline).durationMs), formatDuration(observable(candidate).durationMs)],
    ['Model Requests', formatNumber(activity(baseline).modelCalls), formatNumber(activity(candidate).modelCalls)],
    ['Tool Calls', formatNumber(toolSummary(baseline).total), formatNumber(toolSummary(candidate).total)],
    ['Input Tokens', formatTokens(tokensOf(baseline).input), formatTokens(tokensOf(candidate).input)],
    ['Output Tokens', formatTokens(tokensOf(baseline).output), formatTokens(tokensOf(candidate).output)],
    ['Total Tokens', formatTokens(tokensOf(baseline).total), formatTokens(tokensOf(candidate).total)],
    ['Estimated Cost', '—', '—'],
  ]
  return <article className="aw-compare-card aw-efficiency-compare"><PanelHeader title="效率与成本" subtitle="Efficiency & Cost" action={<Gauge size={16} />} /><div className="aw-compact-table aw-metric-table"><div className="head"><span>Metric</span><b>A</b><b>B</b></div>{rows.map(([label, a, b]) => <div key={label}><span>{label}</span><b>{a}</b><b>{b}</b></div>)}</div><p className="aw-compare-note"><Coins size={12} /> Cost / Successful Outcome：缺少模型价格</p></article>
}

function recoveryStats(run: RunAnalysis) {
  const summary = toolSummary(run); const trajectory = observable(run).trajectory || {}
  const failures = Number(summary.failed) || 0
  const success = Number(trajectory.adaptiveRecoveries) || toolsOf(run).filter((tool: any) => tool.recovery === 'recovered').length
  const recoveryTime = toolsOf(run).filter((tool: any) => tool.recovery === 'recovered').reduce((sum: number, tool: any) => sum + (Number(tool.durationMs) || 0), 0)
  return { failures, retries: Number(summary.retryCount) || Number(trajectory.mechanicalRetries) || 0, success, rate: failures ? success / failures * 100 : null, recoveryTime: recoveryTime || null }
}

function ReliabilityPanel({ baseline, candidate }: { baseline: RunAnalysis; candidate: RunAnalysis }) {
  const a = recoveryStats(baseline); const b = recoveryStats(candidate)
  const rows: Array<[string, string, string]> = [
    ['Failure', formatNumber(a.failures), formatNumber(b.failures)],
    ['Failure Rate', a.failures ? `${(a.failures / Math.max(1, Number(toolSummary(baseline).total) || 1) * 100).toFixed(1)}%` : '0%', b.failures ? `${(b.failures / Math.max(1, Number(toolSummary(candidate).total) || 1) * 100).toFixed(1)}%` : '0%'],
    ['Retry', formatNumber(a.retries), formatNumber(b.retries)],
    ['Recovery', a.failures ? `${a.success} / ${a.failures}` : '—', b.failures ? `${b.success} / ${b.failures}` : '—'],
    ['Recovery Rate', a.rate == null ? '—' : `${a.rate.toFixed(1)}%`, b.rate == null ? '—' : `${b.rate.toFixed(1)}%`],
    ['Recovery Time', formatDuration(a.recoveryTime), formatDuration(b.recoveryTime)],
  ]
  return <article className="aw-compare-card aw-reliability-compare"><PanelHeader title="稳定性" subtitle="Reliability" action={<ShieldCheck size={16} />} /><div className="aw-compact-table aw-metric-table"><div className="head"><span>Metric</span><b>A</b><b>B</b></div>{rows.map(([label, aValue, bValue]) => <div key={label}><span>{label}</span><b>{aValue}</b><b>{bValue}</b></div>)}</div><p className="aw-compare-note"><RotateCcw size={12} /> Recovery cost：分项 Token 未提供</p></article>
}

function ContextStack({ run, side }: { run: RunAnalysis; side: 'A' | 'B' }) {
  const items = contextItems(run); const total = items.reduce((sum, item) => sum + item.tokens, 0)
  return <div className="aw-context-stack-row"><b>{side}</b><div className="aw-context-stack" aria-label={`${side} prompt composition`}>{items.length ? items.map(item => <i key={item.category} title={`${footprintLabels[item.category] || item.category} ${formatTokens(item.tokens)}`} style={{ width: `${item.tokens / total * 100}%`, background: footprintColors[item.category] || '#94a3b8' }} />) : <em>未提供可见上下文</em>}</div><small>{formatTokens(total)}</small></div>
}

function ContextEfficiencyPanel({ baseline, candidate }: { baseline: RunAnalysis; candidate: RunAnalysis }) {
  const aWaste = contextWaste(baseline); const bWaste = contextWaste(candidate)
  const aCache = num(tokensOf(baseline).cachedInput); const bCache = num(tokensOf(candidate).cachedInput)
  const aInput = num(tokensOf(baseline).input); const bInput = num(tokensOf(candidate).input)
  const aRepeated = aWaste.tokens; const bRepeated = bWaste.tokens
  return <article className="aw-compare-card aw-context-compare"><PanelHeader title="上下文效率" subtitle="Context Efficiency" action={<Layers3 size={16} />} /><div className="aw-context-composition"><ContextStack run={baseline} side="A" /><ContextStack run={candidate} side="B" /></div><div className="aw-context-legend">{[...new Set([...contextItems(baseline), ...contextItems(candidate)].map(item => item.category))].map(category => <span key={category}><i style={{ background: footprintColors[category] || '#94a3b8' }} />{footprintLabels[category] || category}</span>)}</div><div className="aw-context-metrics"><div><span>Context Waste</span><b>{aWaste.rate == null ? '—' : `${aWaste.rate.toFixed(1)}%`} <small>/ {bWaste.rate == null ? '—' : `${bWaste.rate.toFixed(1)}%`}</small></b></div><div><span>Cache Hit</span><b>{aCache == null || aInput == null ? '—' : `${(aCache / Math.max(1, aInput) * 100).toFixed(0)}%`} <small>/ {bCache == null || bInput == null ? '—' : `${(bCache / Math.max(1, bInput) * 100).toFixed(0)}%`}</small></b></div><div><span>Repeated Payload</span><b>{formatTokens(aRepeated)} <small>/ {formatTokens(bRepeated)}</small></b></div><div><span>Compactions</span><b>{formatNumber(contextOf(baseline).compactions)} <small>/ {formatNumber(contextOf(candidate).compactions)}</small></b></div></div><p className="aw-compare-note">A / B 顺序展示；浪费与重复 payload 为观测启发式估算。</p></article>
}

function deltaFor(a: number | null, b: number | null) { return a != null && b != null ? b - a : null }

function DriverBars({ title, total, drivers, formatter }: { title: string; total: number | null; drivers: Array<{ label: string; value: number | null; note?: string }>; formatter: (value: number) => string }) {
  const max = Math.max(1, ...drivers.map(item => Math.abs(item.value || 0)))
  return <div className="aw-driver-list"><div className="aw-driver-title"><b>{title}</b><strong>{total == null ? '—' : signed(total, value => formatter(value))}</strong></div>{drivers.map(item => <div className="aw-driver-row" key={item.label}><span>{item.label}{item.note && <small>{item.note}</small>}</span><div className={item.value != null && item.value < 0 ? 'negative' : 'positive'}><i style={{ width: `${Math.abs(item.value || 0) / max * 100}%` }} /><b>{item.value == null ? '—' : signed(item.value, value => formatter(value))}</b></div></div>)}</div>
}

function CostDriverDelta({ baseline, candidate }: { baseline: RunAnalysis; candidate: RunAnalysis }) {
  const tokenDelta = deltaFor(num(tokensOf(baseline).total), num(tokensOf(candidate).total))
  const toolDelta = deltaFor(contextItems(baseline).find(item => item.category === 'tools')?.tokens ?? null, contextItems(candidate).find(item => item.category === 'tools')?.tokens ?? null)
  const outputDelta = deltaFor(num(tokensOf(baseline).output), num(tokensOf(candidate).output))
  const unexplained = tokenDelta == null ? null : tokenDelta - (toolDelta || 0) - (outputDelta || 0)
  const timeDelta = deltaFor(traceTime(baseline), traceTime(candidate))
  const toolTimeDelta = deltaFor(runtimeToolTime(baseline), runtimeToolTime(candidate))
  const otherTime = timeDelta == null ? null : timeDelta - (toolTimeDelta || 0)
  return <article className="aw-compare-card aw-driver-card"><PanelHeader title="差异归因" subtitle="Cost Driver Delta" action={<BarChart3 size={16} />} /><div className="aw-driver-columns"><DriverBars title="Token Delta · B vs A" total={tokenDelta} formatter={formatTokens} drivers={[{ label: 'Tool I/O', value: toolDelta }, { label: 'Output Tokens', value: outputDelta }, { label: 'Unexplained', value: unexplained, note: tokenDelta == null ? '缺少 Token 计数' : '由可观测字段推导' }]} /><DriverBars title="Time Delta · B vs A" total={timeDelta} formatter={formatDuration} drivers={[{ label: 'Tool Time', value: toolTimeDelta }, { label: 'Other', value: otherTime, note: 'estimated' }]} /></div></article>
}

function divergenceItems(result: CompareResultData) {
  const steps = result.trajectoryDiff.steps.filter(step => step.state !== 'same')
  const items: Array<{ index: number; state: string; a?: typeof steps[number]; b?: typeof steps[number] }> = []
  steps.slice(0, 6).forEach(step => {
    const existing = items.find(item => item.index === step.index || item.state === step.state)
    if (existing) { if (step.side === 'baseline') existing.a = step; else existing.b = step; return }
    items.push({ index: step.index, state: step.state, ...(step.side === 'baseline' ? { a: step } : { b: step }) })
  })
  return items
}

function DivergencePanel({ result, onLocate }: { result: CompareResultData; onLocate: (index: number) => void }) {
  const items = divergenceItems(result)
  const label: Record<string, string> = { error: 'Tool failure', retry: 'Retry path', repeated: 'Repeated call', added: 'Additional step', removed: 'Removed step' }
  return <article className="aw-compare-card aw-divergence-card"><PanelHeader title="关键分歧点" subtitle="Key Divergence Points" action={<button className="aw-text-button" type="button">查看全部 ({items.length})</button>} />{items.length ? <div className="aw-divergence-list">{items.slice(0, 3).map((item, position) => <article key={`${item.state}-${item.index}`}><div className="aw-divergence-head"><b>{position + 1}</b><span>Step {String(item.index).padStart(2, '0')}</span><em>{label[item.state] || item.state}</em></div><div className="aw-divergence-lines"><span><b>A</b>{item.a?.label || '—'}</span><span><b>B</b>{item.b?.label || '—'}</span></div><div className="aw-divergence-impact"><span>Impact</span><b>{item.state === 'error' || item.state === 'retry' ? 'Failure / recovery path changed' : 'Additional trajectory step'}</b></div><button type="button" onClick={() => onLocate(item.index)}>定位到轨迹 <ChevronRight size={12} /></button></article>)}</div> : <p className="aw-chart-empty">未发现基础差异</p>}</article>
}

function sparkPoints(run: RunAnalysis) {
  const points = (contextOf(run).points || []).map((point: any, index: number) => `${(index / Math.max(1, contextOf(run).points.length - 1)) * 100},${24 - Math.min(20, Math.max(1, Number(point.ratio) || 0) * 18)}`)
  return points.length > 1 ? points.join(' ') : '0,22 18,19 36,21 54,15 72,18 88,10 100,13'
}

function TrajectoryPreview({ run, side, focusedStep, onFocus, onOpenFullTrace }: { run: RunAnalysis; side: 'A' | 'B'; focusedStep: number | null; onFocus: (index: number) => void; onOpenFullTrace: (run: RunAnalysis, side: 'A' | 'B') => void }) {
  const tools = toolsOf(run)
  const time = traceTime(run)
  const toolPosition = (index: number) => `${(index / Math.max(1, tools.length - 1)) * 100}%`
  return <article className={`aw-trajectory-card-v3 ${side.toLowerCase()}`}><header><div><span>{side === 'A' ? 'A 基准路径' : 'B 候选路径'}</span><b>{run.identity?.model || 'Unknown model'}</b></div><div><small>{formatDuration(run.observable?.durationMs)} · {formatTokens(tokensOf(run).total)} tokens</small><button type="button" onClick={() => onOpenFullTrace(run, side)}>查看完整 Trace</button></div></header><div className="aw-trace-preview"><div className="aw-trace-scale"><span>0:00</span><span>{formatDuration(time * .25)}</span><span>{formatDuration(time * .5)}</span><span>{formatDuration(time * .75)}</span><span>{formatDuration(time)}</span></div><div className="aw-trace-lane"><b>工具调用</b><div className="aw-trace-track">{tools.map((tool: any, index: number) => <button key={`${tool.id || tool.name}-${index}`} className={`${tool.status === 'failed' ? 'failed' : ''} ${tool.flags?.includes('mechanical-retry') ? 'retry' : ''} ${focusedStep === index + 1 ? 'focused' : ''}`} style={{ left: toolPosition(index) }} title={`${tool.label || tool.name} · ${tool.status || 'unknown'}`} onClick={() => { onFocus(index + 1); document.getElementById('aw-compare-trajectories')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{index + 1}</button>)}{focusedStep != null && focusedStep <= tools.length && <i className="aw-trace-focus" style={{ left: toolPosition(Math.max(0, focusedStep - 1)) }} />}</div></div><div className="aw-trace-lane"><b>Token 峰值</b><div className="aw-trace-dashes">{tools.slice(0, 34).map((tool: any, index: number) => <i key={`${tool.id || tool.name}-token-${index}`} className={tool.status === 'failed' ? 'failed' : ''} style={{ left: toolPosition(index), height: `${8 + (index * 7 % 15)}px` }} />)}</div></div><div className="aw-trace-lane"><b>上下文压力</b><div className="aw-trace-spark"><svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-label={`${side} context pressure`}><polyline points={sparkPoints(run)} /></svg></div></div><div className="aw-trace-legend"><span><i className="normal" />普通</span><span><i className="failure" />Failure</span><span><i className="retry" />Retry</span><span><i className="divergence" />Divergence</span></div></div></article>
}

function FullTraceDialog({ trace, onClose }: { trace: FullTrace | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (trace && !element.open) element.showModal()
    if (!trace && element.open) element.close()
  }, [trace])
  return <dialog ref={dialog} className="aw-trace-dialog" aria-labelledby="aw-trace-dialog-title" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }}>{trace && <div className="aw-trace-dialog-content"><header className={`aw-trace-dialog-header ${trace.side.toLowerCase()}`}><div><span>{trace.side === 'A' ? 'A 基准路径' : 'B 候选路径'}</span><h2 id="aw-trace-dialog-title">{trace.run.identity?.model || 'Unknown model'} 完整轨迹</h2></div><button type="button" aria-label="关闭完整轨迹" onClick={() => dialog.current?.close()}><X size={18} /></button></header><TrajectoryView run={trace.run} frameTitle={`${trace.side} full trajectory`} /></div>}</dialog>
}

function TrajectorySection({ baseline, candidate, result, focusedStep, onFocus, onOpenFullTrace }: { baseline: RunAnalysis; candidate: RunAnalysis; result: CompareResultData; focusedStep: number | null; onFocus: (index: number | null) => void; onOpenFullTrace: (run: RunAnalysis, side: 'A' | 'B') => void }) {
  const diffs = result.trajectoryDiff.steps.filter(step => step.state !== 'same')
  const current = focusedStep == null ? (diffs[0]?.index || null) : focusedStep
  const move = (direction: -1 | 1) => { const indexes = diffs.map(step => step.index); if (!indexes.length) return; const position = Math.max(0, indexes.indexOf(current || indexes[0])); onFocus(indexes[(position + direction + indexes.length) % indexes.length]) }
  return <section className="aw-trajectory-section-v3" id="aw-compare-trajectories"><div className="aw-trajectory-heading"><div><span className="aw-section-kicker">SYNCHRONIZED TRACE VIEW</span><h3>双轨迹同步查看 <small>/ A/B Trajectory</small></h3></div><div className="aw-trace-nav"><button type="button" onClick={() => move(-1)} disabled={!diffs.length}><ChevronLeft size={13} /> 上一个差异</button><span>{diffs.length ? `${Math.max(1, diffs.findIndex(step => step.index === current) + 1)} / ${diffs.length}` : '0 / 0'}</span><button type="button" onClick={() => move(1)} disabled={!diffs.length}>下一个差异 <ChevronRight size={13} /></button></div></div><div className="aw-trajectory-grid"><TrajectoryPreview run={baseline} side="A" focusedStep={focusedStep} onFocus={index => onFocus(index)} onOpenFullTrace={onOpenFullTrace} /><TrajectoryPreview run={candidate} side="B" focusedStep={focusedStep} onFocus={index => onFocus(index)} onOpenFullTrace={onOpenFullTrace} /></div></section>
}

function behaviorRows(baseline: RunAnalysis, candidate: RunAnalysis) {
  const get = (run: RunAnalysis) => ({
    planning: null,
    search: countTools(run, /search|web/i),
    read: countTools(run, /read|cat|sed|head|tail|list/i),
    shell: countTools(run, /shell|exec|command/i),
    repeated: Number(observable(run).trajectory?.repeatedActions) || signalCount(run, ['repeated_read', 'repeated_tool_call']),
    failed: Number(toolSummary(run).failed) || 0,
    retries: Number(toolSummary(run).retryCount) || Number(observable(run).trajectory?.mechanicalRetries) || 0,
    backtracking: signalCount(run, ['backtrack']),
    noOp: Array.isArray(observable(run).trajectory?.wasteActionIds) ? observable(run).trajectory.wasteActionIds.length : null,
    subagents: num(observable(run).agents?.observed),
  })
  const a = get(baseline); const b = get(candidate)
  return [['Planning Steps', a.planning, b.planning], ['Search', a.search, b.search], ['Read', a.read, b.read], ['Shell', a.shell, b.shell], ['Repeated Calls', a.repeated, b.repeated], ['Failed Calls', a.failed, b.failed], ['Retries', a.retries, b.retries], ['Backtracking', a.backtracking, b.backtracking], ['No-op Steps', a.noOp, b.noOp], ['Subagents', a.subagents, b.subagents]] as Array<[string, number | null, number | null]>
}

function BehaviorDelta({ baseline, candidate }: { baseline: RunAnalysis; candidate: RunAnalysis }) {
  return <article className="aw-compare-card aw-behavior-delta"><PanelHeader title="行为差异" subtitle="Behavior Delta" action={<Wrench size={16} />} /><div className="aw-compact-table aw-behavior-table"><div className="head"><span>Behavior</span><b>A</b><b>B</b><b>Δ</b></div>{behaviorRows(baseline, candidate).map(([label, a, b]) => <div key={label}><span>{label}</span><b>{formatNumber(a)}</b><b>{formatNumber(b)}</b><strong className={(a != null && b != null && b > a) ? 'bad' : ''}>{a != null && b != null ? signed(b - a) : '—'}</strong></div>)}</div></article>
}

function patternsFor(baseline: RunAnalysis, candidate: RunAnalysis) {
  const patterns: Array<{ label: string; tone: string; detail: string }> = []
  const bFailed = Number(toolSummary(candidate).failed) || 0; const aFailed = Number(toolSummary(baseline).failed) || 0
  const bRepeated = Number(observable(candidate).trajectory?.repeatedActions) || signalCount(candidate, ['repeated_read', 'repeated_tool_call'])
  const aRepeated = Number(observable(baseline).trajectory?.repeatedActions) || signalCount(baseline, ['repeated_read', 'repeated_tool_call'])
  if (bRepeated > aRepeated) patterns.push({ label: 'Repeated Search / Read', tone: 'warn', detail: `B 多 ${bRepeated - aRepeated} 次重复动作` })
  if (bFailed > aFailed) patterns.push({ label: 'Tool Failure Loop', tone: 'bad', detail: `B 多 ${bFailed - aFailed} 次失败调用` })
  const bTools = contextItems(candidate).find(item => item.category === 'tools')?.tokens || 0; const aTools = contextItems(baseline).find(item => item.category === 'tools')?.tokens || 0
  if (bTools > aTools) patterns.push({ label: 'Context-heavy Tool Output', tone: 'bad', detail: `B 的 Tool I/O 高 ${formatTokens(bTools - aTools)}` })
  const aRuntime = num(observable(baseline).durationMs); const bRuntime = num(observable(candidate).durationMs)
  if (aRuntime != null && bRuntime != null && bRuntime < aRuntime) patterns.push({ label: 'Faster Execution', tone: 'good', detail: `B 快 ${formatDuration(aRuntime - bRuntime)}` })
  if (!patterns.length) patterns.push({ label: 'No high-confidence pattern', tone: 'neutral', detail: '当前没有可观测的显著行为模式' })
  return patterns
}

function BehaviorPatterns({ baseline, candidate }: { baseline: RunAnalysis; candidate: RunAnalysis }) {
  return <article className="aw-compare-card aw-pattern-card"><PanelHeader title="行为模式" subtitle="Behavioral Patterns" action={<Zap size={16} />} /><div className="aw-pattern-list">{patternsFor(baseline, candidate).map(pattern => <div key={pattern.label} className={`aw-pattern ${pattern.tone}`}><span>{pattern.label}</span><small>{pattern.detail}</small></div>)}</div><p className="aw-compare-note">规则来自已观测的失败、重复、工具输出与时间序列。</p></article>
}

function recommendationItems(baseline: RunAnalysis, candidate: RunAnalysis, optimization: Optimization) {
  const aFailed = Number(toolSummary(baseline).failed) || 0; const bFailed = Number(toolSummary(candidate).failed) || 0
  const aWaste = contextWaste(baseline); const bWaste = contextWaste(candidate)
  const aRepeated = Number(observable(baseline).trajectory?.repeatedActions) || signalCount(baseline, ['repeated_read', 'repeated_tool_call'])
  const bRepeated = Number(observable(candidate).trajectory?.repeatedActions) || signalCount(candidate, ['repeated_read', 'repeated_tool_call'])
  const aEvidence = evidenceStats(baseline); const bEvidence = evidenceStats(candidate)
  const list: Array<{ priority: 'HIGH' | 'MEDIUM' | 'LOW'; title: string; evidence: string; impact: string; target: Optimization }> = []
  if (bFailed > aFailed) list.push({ priority: 'HIGH', title: '修复失败调用与重试边界', evidence: `B 有 ${bFailed} 次失败调用，A 为 ${aFailed} 次。`, impact: 'Reliability ↑ · Recovery cost ↓', target: 'reliability' })
  if ((bWaste.rate || 0) > (aWaste.rate || 0)) list.push({ priority: 'HIGH', title: '减少重复上下文注入', evidence: `B 的估算 Context Waste 高 ${((bWaste.rate || 0) - (aWaste.rate || 0)).toFixed(1)}pp。`, impact: 'Tokens ↓ · Context pressure ↓', target: 'cost' })
  if (bRepeated > aRepeated) list.push({ priority: 'MEDIUM', title: '避免重复 Search / Read', evidence: `B 多 ${bRepeated - aRepeated} 次重复动作。`, impact: 'Runtime ↓ · Tool Calls ↓', target: 'speed' })
  if (bEvidence.coverage < aEvidence.coverage) list.push({ priority: 'MEDIUM', title: '补充完成证据校验', evidence: `B 证据覆盖 ${Math.round(bEvidence.coverage)}%，A 为 ${Math.round(aEvidence.coverage)}%。`, impact: 'Outcome confidence ↑', target: 'quality' })
  if (!list.length) list.push({ priority: 'LOW', title: '补充可验证的结果证据', evidence: '当前没有足够差异触发更具体的建议。', impact: 'Outcome confidence ↑', target: 'quality' })
  return [...list].sort((a, b) => (a.target === optimization ? -1 : 0) - (b.target === optimization ? -1 : 0)).slice(0, 3)
}

function Recommendations({ baseline, candidate, optimization }: { baseline: RunAnalysis; candidate: RunAnalysis; optimization: Optimization }) {
  return <article className="aw-compare-card aw-recommendation-card"><PanelHeader title="优化建议" subtitle="Recommendations" action={<Target size={16} />} /><div className="aw-recommendation-list">{recommendationItems(baseline, candidate, optimization).map(item => <article key={item.title} className={item.priority.toLowerCase()}><div className="aw-recommendation-top"><b>{item.priority}</b><span>{item.title}</span></div><p><strong>Evidence</strong> {item.evidence}</p><p><strong>Expected impact</strong> {item.impact}</p><small>Confidence · {item.priority === 'HIGH' ? 'High' : item.priority === 'MEDIUM' ? 'Medium' : 'Low'}</small></article>)}</div></article>
}
