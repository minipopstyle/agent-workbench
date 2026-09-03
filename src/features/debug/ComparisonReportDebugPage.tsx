import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, Copy, Download, ShieldCheck } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { api, type ComparisonReport, type RunSource } from '@/api'

const sourceOf = (value: string | null): RunSource => ['codex', 'claude', 'workbuddy', 'import'].includes(value || '') ? value as RunSource : 'codex'

export function ComparisonReportDebugPage() {
  const [params] = useSearchParams(); const [result, setResult] = useState<{ comparisonReport: ComparisonReport; [key: string]: any } | null>(null); const [tab, setTab] = useState<'bundle' | 'report'>('report'); const [error, setError] = useState(''); const [validation, setValidation] = useState<{ valid: boolean; errors: string[] } | null>(null)
  const baseline = params.get('baselineSession'); const candidate = params.get('candidateSession'); const baselineSource = sourceOf(params.get('baselineSource')); const candidateSource = sourceOf(params.get('candidateSource')); const baselineTurn = params.get('baselineTurn') || undefined; const candidateTurn = params.get('candidateTurn') || undefined; const task = params.get('task') || undefined
  useEffect(() => {
    if (!baseline || !candidate) return
    api.compare({ source: baselineSource, sessionId: baseline, turnId: baselineTurn }, { source: candidateSource, sessionId: candidate, turnId: candidateTurn }, task).then(setResult).catch(value => setError(value instanceof Error ? value.message : '加载报告失败'))
  }, [baseline, candidate, baselineSource, candidateSource, baselineTurn, candidateTurn, task])
  const value = useMemo(() => {
    if (!result) return null
    if (tab === 'report') return result.comparisonReport
    const { comparisonReport: _report, ...bundle } = result
    return bundle
  }, [result, tab])
  const content = value ? JSON.stringify(value, null, 2) : ''
  const copy = () => { if (content) void navigator.clipboard?.writeText(content) }
  const download = () => { if (!content) return; const blob = new Blob([content], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = tab === 'report' ? 'comparison-report.json' : 'comparison-bundle.json'; link.click(); URL.revokeObjectURL(url) }
  const validate = async () => { if (!result?.comparisonReport) return; try { setValidation(await api.validateComparisonReport(result.comparisonReport)) } catch (value) { setError(value instanceof Error ? value.message : '校验失败') } }
  return <main className="aw-page" style={{ maxWidth: 1180 }}><header className="aw-page-header"><div><span className="aw-eyebrow">DEVELOPMENT DEBUG</span><h2>ComparisonBundle → ComparisonReport</h2></div><div style={{ display: 'flex', gap: 6 }}><button type="button" className={`aw-seg-tab ${tab === 'bundle' ? 'active' : ''}`} onClick={() => setTab('bundle')}>Bundle</button><button type="button" className={`aw-seg-tab ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>Report</button><button type="button" className="aw-btn-view" disabled={!content} onClick={copy}><Copy size={13} /> Copy JSON</button><button type="button" className="aw-btn-view" disabled={!content} onClick={download}><Download size={13} /> Download</button><button type="button" className="aw-btn-view" disabled={!result} onClick={() => void validate()}><ShieldCheck size={13} /> Schema Validate</button></div></header>{error && <div className="aw-inline-error"><CircleAlert size={15} />{error}</div>}{validation && <div className={validation.valid ? 'aw-inline-success' : 'aw-inline-error'}><ShieldCheck size={15} />{validation.valid ? 'Comparison Report schema valid' : validation.errors.join(' ')}</div>}{!baseline || !candidate ? <section className="aw-empty"><b>需要比较参数</b><p>从 Trace Compare 进入 Debug，或提供 baselineSession / candidateSession 查询参数。</p></section> : !value ? <section className="aw-empty"><b>正在生成报告…</b></section> : <pre style={{ margin: 0, padding: 16, overflow: 'auto', maxHeight: 'calc(100svh - 130px)', border: '1px solid #e2e8f0', borderRadius: 10, background: '#0f172a', color: '#e2e8f0', font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace' }}>{content}</pre>}</main>
}
