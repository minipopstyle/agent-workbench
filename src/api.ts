export type RunSource = 'codex' | 'claude' | 'workbuddy' | 'import'
export type SessionFormat = 'codex' | 'deepseek-harness' | 'unknown'
export type RunRef = { source: RunSource; sessionId: string; turnId: string }
export type Session = { id: string; source: RunSource; parentId: string | null; projectPath: string | null; model: string | null; effort?: string | null; startedAt: string; updatedAt: string; status: 'live' | 'complete' | 'aborted' | 'unknown'; childCount: number; turnCount?: number; latestTurnId?: string | null; name?: string; displayTitle?: string; nativeTitle?: string | null; titleSource?: 'native' | 'first_user_message' | 'fallback_id'; additionalModelCount?: number; projectName?: string | null; nativeSessionId?: string | null; sourceFormat?: SessionFormat; provider?: string | null; importedFileName?: string | null; contextWindow?: number | null; models?: Array<{ provider?: string; model: string; time?: number; turn?: number }> }
export const sessionTitle = (session: Session, maxLength?: number) => {
  const title = session.displayTitle || session.name || `Session ${session.id.slice(0, 8)}`
  return maxLength && [...title].length > maxLength ? `${[...title].slice(0, maxLength).join('')}…` : title
}
export type Turn = { ref: RunRef; title: string | null; model: string | null; effort: string | null; status: Session['status']; startedAt: string; endedAt: string | null; durationMs: number }
export type Evaluation = { evaluatorId: string; rubricId: 'generic' | 'coding' | 'content'; rubricVersion: 1; status: string; dimensions: Array<{ id: string; label: string; score: number | null; weight: number; note?: string }>; overall: number | null; notes: string | null; createdAt: string }
export type Outcome = { status: 'success' | 'partial' | 'failed' | 'unknown'; source: 'observed' | 'user' | 'experimental_evaluator'; confidence?: number; note?: string; evidence?: Array<{ type: string; status: string; label: string; value?: string | number }> }
export type RunAnalysis = { schemaVersion: 1; ref: RunRef; identity: { title: string | null; model: string | null; effort: string | null; projectPath: string | null; cliVersion: string | null; startedAt: string; endedAt: string | null; status: Session['status']; harness: any; modelIdentity: any; environment: any }; observable: any; evidence: any; outcome: Outcome; behavioralSignals: any[]; coverage: any; evaluation?: Evaluation; v2: any }
export type Snapshot = { descriptor: Session; v2: any; diagnostics: string[]; runs?: Turn[]; normalized?: any; parseDiagnostics?: any }
export type TaskGroup = { evalTaskId: string; title: string; taskType: 'generic' | 'coding' | 'content'; confirmedRuns: RunRef[]; suggestedRuns: RunRef[]; baselineRun?: RunRef; createdAt: string; updatedAt: string }
export type SourceInfo = { id: RunSource; label: string; root?: string; path?: string; status: 'ready' | 'not_found' | 'error'; sessionCount: number; error?: string }
export type ComparisonReport = Record<string, any>
export type ComparisonExportFormat = 'html' | 'report-json' | 'bundle-json'

const request = async <T>(path: string, options?: RequestInit) => {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options?.headers || {}) } })
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error(`本地服务响应格式错误（${response.status}）`)
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '请求失败'); return value as T
}
export const runPath = (ref: RunRef) => `/runs/${ref.source}/${encodeURIComponent(ref.sessionId)}/${encodeURIComponent(ref.turnId)}`
export const api = {
  sources: () => request<SourceInfo[]>('/sources'),
  sessions: async (q = '', source?: RunSource) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (source) params.set('source', source)
    const qs = params.toString()
    const sessions = await request<Session[]>(`/sessions${qs ? `?${qs}` : ''}`)
    if (!Array.isArray(sessions)) throw new Error('本地 Session 目录格式错误')
    return sessions
  },
  snapshot: (id: string, source: RunSource = 'codex') => request<Snapshot>(`/sessions/${source}/${encodeURIComponent(id)}`),
  turns: (sessionId: string, source: RunSource = 'codex') => request<Turn[]>(`/sessions/${source}/${encodeURIComponent(sessionId)}/turns`),
  run: (ref: RunRef) => request<RunAnalysis>(runPath(ref)),
  compare: (baseline: { source: string; id?: string; sessionId?: string; turnId?: string }, candidate: { source: string; id?: string; sessionId?: string; turnId?: string }, evalTaskId?: string) => request<any>('/comparisons', { method: 'POST', body: JSON.stringify({ baseline: { ...baseline, id: baseline.id || baseline.sessionId }, candidate: { ...candidate, id: candidate.id || candidate.sessionId }, evalTaskId }) }),
  exportComparison: async (baseline: { source: string; id?: string; sessionId?: string; turnId?: string }, candidate: { source: string; id?: string; sessionId?: string; turnId?: string }, format: ComparisonExportFormat, evalTaskId?: string, optimizationGoal?: string) => {
    const response = await fetch('/api/comparisons/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseline: { ...baseline, id: baseline.id || baseline.sessionId }, candidate: { ...candidate, id: candidate.id || candidate.sessionId }, format, evalTaskId, optimizationGoal }) })
    if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || '导出失败') }
    const contentDisposition = response.headers.get('content-disposition') || ''
    if (!/attachment/i.test(contentDisposition)) throw new Error('导出服务未更新：请重启 Agent Workbench 后重试')
    const filename = contentDisposition.match(/filename="([^"]+)"/)?.[1] || (format === 'html' ? 'agent-workbench-comparison.html' : format === 'report-json' ? 'comparison-report.json' : 'comparison-bundle.json')
    return { blob: await response.blob(), filename }
  },
  validateComparisonReport: (report: unknown) => request<{ valid: boolean; errors: string[] }>('/comparisons/validate', { method: 'POST', body: JSON.stringify({ report }) }),
  importTrace: (name: string, data: string) => request<Snapshot>('/imports', { method: 'POST', body: JSON.stringify({ name, data }) }),
  saveImport: (id: string) => request<{ saved: boolean }>(`/imports/${encodeURIComponent(id)}/save`, { method: 'POST', body: '{}' }),
  savedImports: () => request<Array<{ id: string; snapshot: Snapshot; savedAt: string }>>('/imports/saved'),
  evaluators: () => request<{ rubrics: any[]; judgeConfigured: boolean }>('/evaluators'),
  evaluate: (body: Record<string, unknown>) => request<Evaluation>('/evaluations', { method: 'POST', body: JSON.stringify(body) }),
  saveOutcome: (body: { ref: RunRef; status: Outcome['status']; note?: string }) => request<Outcome>('/outcomes', { method: 'POST', body: JSON.stringify(body) }),
  taskGroups: () => request<TaskGroup[]>('/task-groups'),
  createTaskGroup: (body: Partial<TaskGroup>) => request<TaskGroup>('/task-groups', { method: 'POST', body: JSON.stringify(body) }),
  patchTaskGroup: (id: string, body: Record<string, unknown>) => request<TaskGroup>(`/task-groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  addTaskRun: (id: string, ref: RunRef) => request<TaskGroup>(`/task-groups/${id}/runs`, { method: 'POST', body: JSON.stringify({ ref }) }),
  refreshSuggestions: (id: string) => request<TaskGroup>(`/task-groups/${id}/suggestions`, { method: 'POST', body: '{}' }),
  reliability: (id: string) => request<any>(`/task-groups/${id}/reliability`),
  taskDiagnostics: (id: string) => request<any>(`/task-groups/${id}/diagnostics`),
}
