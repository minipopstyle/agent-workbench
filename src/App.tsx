import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { CircleAlert, Radio } from 'lucide-react'
import { api } from '@/api'
import { WorkbenchShell } from '@/components/WorkbenchShell'
import { ComparePage } from '@/features/compare/ComparePage'
import { ComparisonReportDebugPage } from '@/features/debug/ComparisonReportDebugPage'
import { EvaluatorsPage } from '@/features/evaluators/EvaluatorsPage'
import { LivePage } from '@/features/live/LivePage'
import { RunReportPage } from '@/features/runs/RunReportPage'
import { SessionsPage } from '@/features/sessions/SessionsPage'
import { SourcesPage } from '@/features/sessions/SourcesPage'

export default function App() {
  return <AppErrorBoundary><BrowserRouter><Routes><Route element={<WorkbenchShell />}>
    <Route index element={<SessionsPage />} />
    <Route path="live" element={<LatestLiveSession />} />
    <Route path="sessions/:id/live" element={<LivePage />} />
    <Route path="sessions/:id/runs" element={<RunReportPage />} />
    <Route path="sessions/:id/runs/:turnId" element={<RunReportPage />} />
    <Route path="compare" element={<ComparePage />} />
    <Route path="debug/comparison-report" element={<ComparisonReportDebugPage />} />
    <Route path="evaluators" element={<EvaluatorsPage />} />
    <Route path="sources" element={<SourcesPage />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route></Routes></BrowserRouter></AppErrorBoundary>
}

function LatestLiveSession() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const source = (['codex', 'workbuddy', 'claude'].includes(searchParams.get('source') || '') ? searchParams.get('source') : 'codex') as 'codex' | 'workbuddy' | 'claude'
  const sourceLabel = source === 'workbuddy' ? 'WorkBuddy' : source === 'claude' ? 'Claude' : 'Codex'
  const [error, setError] = useState('')
  const load = useCallback(() => {
    setError('')
    api.sessions('', source).then(sessions => {
      if (sessions[0]) navigate(`/sessions/${sessions[0].id}/live?source=${sessions[0].source}`, { replace: true })
      else setError(`未发现任何本地 ${sourceLabel} Session`)
    }).catch(err => setError(err instanceof Error ? err.message : '连接服务失败'))
  }, [navigate, source, sourceLabel])
  useEffect(() => { void load() }, [load])
  return <main className="aw-page"><section className="aw-empty">
    {error ? <><CircleAlert size={22} /><b>未能打开实时轨迹</b><p>{error}</p><button type="button" onClick={load}>重试</button></> : <><Radio className="aw-spin" size={22} /><b>正在打开最新 {sourceLabel} Session 的实时轨迹</b><p>从本地 {sourceLabel} Session 建立 V2 快照…</p></>}
  </section></main>
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error) { return { error: error.message || '页面加载失败' } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Agent Workbench render failed', error, info) }
  render() { return this.state.error ? <main className="aw-fatal"><div><b>工作台页面加载失败</b><p>{this.state.error}</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></div></main> : this.props.children }
}
