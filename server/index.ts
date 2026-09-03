import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdapterRegistry } from './adapters/registry.js'
import { CodexAdapter } from './adapters/codex.js'
import { compareRuns } from './compare.js'
import { renderComparisonHtml } from './renderComparisonHtml.js'
import { sanitizeComparisonReport, validateComparisonReport } from './comparison-report.js'
import { buildTaskDiagnostics } from './diagnostics.js'
import { deterministicEvaluation, evaluatorCatalog, judgeEvaluation, judgePreview, manualEvaluation } from './evaluator.js'
import { runKey, suggestedTaskSimilarity } from './run-analysis.js'
import { reliabilityMetrics } from './reliability.js'
import { LocalState } from './state.js'
import { validateImportedSnapshot } from './imports.js'
import type { RunAnalysis, RunOutcome, RunRef, RunSource, SessionDescriptor, SessionSnapshot, TaskType } from './types.js'

const port = Number(process.env.AGENT_WORKBENCH_PORT || 47832)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const registry = new AdapterRegistry()
const codex = registry.get('codex') as CodexAdapter
const state = new LocalState(process.env.AGENT_WORKBENCH_STATE_ROOT || undefined)
const imports = new Map<string, { snapshot: SessionSnapshot; analyses: Map<string, RunAnalysis> }>()

const json = (res: http.ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const sendEvent = (res: http.ServerResponse, event: string, value: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
const readJson = async (req: http.IncomingMessage) => { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of req) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 100 * 1024 * 1024) throw new Error('请求超过 100MB'); chunks.push(buffer) }; return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any> }
const originOk = (req: http.IncomingMessage) => { const origin = req.headers.origin; return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin) }
const refOf = (value: Record<string, any>): RunRef => ({
  source: (['codex', 'claude', 'workbuddy', 'import'].includes(value.source) ? value.source : 'codex') as RunSource,
  sessionId: String(value.sessionId || value.id || ''),
  turnId: String(value.turnId || ''),
})

const sessionRecord = (session: SessionDescriptor) => {
  const title = session.name?.trim() || null
  const titleSource = session.titleSource || (title ? (session.source === 'codex' ? 'first_user_message' : 'native') : 'fallback_id')
  const nativeTitle = titleSource === 'native' ? title : null
  const firstUserTitle = titleSource === 'first_user_message' ? title : null
  const projectName = session.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) || null
  return {
    ...session,
    displayTitle: nativeTitle || firstUserTitle || `Session ${session.id.slice(0, 8)}`,
    nativeTitle,
    titleSource,
    projectName,
  }
}

async function loadImport(id: string) {
  let imported = imports.get(id)
  if (!imported) { const saved = await state.savedImport(id); if (saved) { imported = { snapshot: saved.snapshot, analyses: new Map(saved.analyses.map(item => [item.ref.turnId, item])) }; imports.set(id, imported) } }
  return imported
}

async function resolveRun(ref: RunRef) {
  let analysis: RunAnalysis
  if (ref.source === 'import') {
    const imported = await loadImport(ref.sessionId)
    if (!imported) throw new Error('导入 Session 已过期')
    analysis = imported.analyses.get(ref.turnId) || (() => { throw new Error('未找到导入 Turn') })()
  } else {
    analysis = await registry.run(ref)
  }
  const [evaluation, outcome] = await Promise.all([state.evaluation(ref), state.outcome(ref)])
  return { ...analysis, ...(evaluation ? { evaluation } : {}), ...(outcome ? { outcome } : {}) }
}

async function latestRef(source: RunSource, sessionId: string) {
  if (source === 'import') { const imported = await loadImport(sessionId); const turn = imported?.snapshot.runs?.at(-1); if (!turn) throw new Error('导入 Session 未解析出可比较的 Turn'); return turn.ref }
  const turn = (await registry.turns(source, sessionId)).at(-1); if (!turn) throw new Error('Session 不含可用 Turn'); return turn.ref
}

async function reliability(id: string) {
  const group = await state.group(id); if (!group) throw new Error('未找到任务组')
  const runs = await Promise.all(group.confirmedRuns.map(async ref => { try { return await resolveRun(ref) } catch { return null } }))
  const labeled = runs.filter((run): run is RunAnalysis => Boolean(run && (run.outcome.source === 'user' || run.outcome.status === 'success' || run.outcome.status === 'failed')))
  return { group, ...reliabilityMetrics(labeled.map(run => run.outcome.status === 'success' ? 100 : 0)), successSource: 'User-confirmed or observed explicit validation' }
}

async function taskDiagnostics(id: string) {
  const group = await state.group(id); if (!group) throw new Error('未找到任务组')
  const loaded = await Promise.all(group.confirmedRuns.map(async ref => { try { return await resolveRun(ref) } catch { return null } }))
  return { group, ...buildTaskDiagnostics(group.title, loaded.filter((run): run is RunAnalysis => Boolean(run)), group.baselineRun) }
}

const inferredTaskType = (goal: string | null): TaskType => /(?:bug|fix|code|test|build|lint|repo|代码|修复|测试|构建)/i.test(goal || '') ? 'coding' : /(?:translate|translation|rewrite|写作|翻译|文案)/i.test(goal || '') ? 'content' : 'generic'
const experimentalEvaluators = process.env.ENABLE_EXPERIMENTAL_EVALUATORS === 'true'
async function refreshSuggestions(id: string) {
  const group = await state.group(id); if (!group) throw new Error('未找到任务组')
  const anchor = group.confirmedRuns[0] ? await resolveRun(group.confirmedRuns[0]) : null
  if (!anchor?.identity.title) return state.patchGroup(id, { suggestedRuns: [] })
  const sessions = await codex.discover(); const found: RunRef[] = []
  for (const session of sessions) {
    if (anchor.identity.projectPath && session.projectPath !== anchor.identity.projectPath) continue
    for (const turn of await codex.turns(session.id)) {
      if (inferredTaskType(turn.title) !== group.taskType || group.confirmedRuns.some(ref => runKey(ref) === runKey(turn.ref))) continue
      if (suggestedTaskSimilarity(anchor.identity.title, turn.title) >= 0.82) found.push(turn.ref)
    }
  }
  return state.patchGroup(id, { suggestedRuns: found })
}

async function staticFile(res: http.ServerResponse, pathname: string) {
  const safe = path.normalize(pathname).replace(/^([.][.][\\/])+/, '')
  const file = path.join(dist, safe === '/' ? 'index.html' : safe)
  try { const content = await fs.readFile(file); const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'; const cacheControl = file.endsWith('.html') || pathname.startsWith('/legacy-v2/') ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable'; res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': cacheControl }); res.end(content) }
  catch { try { const index = await fs.readFile(path.join(dist, 'index.html')); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' }); res.end(index) } catch { json(res, { error: '请先运行 npm run build，或使用 npm run dev 配合 npm run server' }, 503) } }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
  try {
    if (url.pathname === '/api/health') return json(res, { ok: true, port, sources: registry.all().map(a => a.source) })
    if (url.pathname === '/api/sources') return json(res, await registry.detectAll())
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase()
      const status = url.searchParams.get('status')
      const source = url.searchParams.get('source') as RunSource | null
      const sessions = (source ? await registry.discoverSource(source) : await registry.discoverAll()).map(sessionRecord)
      return json(res, sessions.filter(session => (!q || `${session.displayTitle} ${session.nativeTitle || ''} ${session.id} ${session.model || ''} ${session.projectName || ''} ${session.projectPath || ''}`.toLowerCase().includes(q)) && (!status || session.status === status)))
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)(?:\/(stream|turns))?$/)
    if (sessionMatch && req.method === 'GET') {
      const [, sourceStr, id, suffix] = sessionMatch
      const source = sourceStr as RunSource
      if (suffix === 'turns') {
        if (source === 'import') {
          const imported = await loadImport(id)
          return json(res, imported?.snapshot.runs || [])
        }
        return json(res, await registry.turns(source, id))
      }
      if (!suffix) {
        if (source === 'import') {
          const imported = await loadImport(id)
          if (!imported) return json(res, { error: '未找到导入 Session' }, 404)
          return json(res, imported.snapshot)
        }
        return json(res, await registry.snapshot(source, id))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
      let last = ''; const timer = setInterval(async () => {
        try {
          const snapshot = source === 'import' ? (await loadImport(id))?.snapshot : await registry.snapshot(source, id)
          if (snapshot) {
            const signature = `${snapshot.descriptor.updatedAt}:${snapshot.descriptor.latestTurnId}`
            if (signature !== last) { last = signature; sendEvent(res, 'snapshot', snapshot) }
          }
        } catch (error) { sendEvent(res, 'diagnostic', { message: error instanceof Error ? error.message : '读取失败' }) }
      }, 1000)
      req.on('close', () => clearInterval(timer)); return
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(stream))?$/)
    if (runMatch && req.method === 'GET') {
      const [, source, sessionId, turnId, stream] = runMatch
      const ref: RunRef = { source: (['codex', 'claude', 'workbuddy', 'import'].includes(source) ? source : 'codex') as RunSource, sessionId, turnId }
      if (!stream) return json(res, await resolveRun(ref))
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
      let last = ''; const timer = setInterval(async () => {
        try {
          const run = await resolveRun(ref)
          const signature = `${run.identity.endedAt}:${run.observable.durationMs}:${run.observable.tools.length}`
          if (signature !== last) { last = signature; sendEvent(res, 'run', run) }
        } catch (error) { sendEvent(res, 'diagnostic', { message: error instanceof Error ? error.message : '读取失败' }) }
      }, 1000)
      req.on('close', () => clearInterval(timer)); return
    }
    if (url.pathname === '/api/imports' && req.method === 'POST') {
      if (!originOk(req)) return json(res, { error: '无效来源' }, 403)
      const body = await readJson(req)
      const codexAdapter = registry.get('codex') as CodexAdapter
      const imported = await codexAdapter.importWithRuns(String(body.name || 'import.jsonl'), String(body.data || ''))
      const validation = validateImportedSnapshot(imported.snapshot)
      if (!validation.valid) throw new Error(validation.message)
      imports.set(imported.snapshot.descriptor.id, imported)
      return json(res, imported.snapshot, 201)
    }
    if (url.pathname === '/api/imports/saved' && req.method === 'GET') return json(res, await state.savedImports())
    const importSave = url.pathname.match(/^\/api\/imports\/([^/]+)\/save$/)
    if (importSave && req.method === 'POST') { if (!originOk(req)) return json(res, { error: '无效来源' }, 403); const imported = imports.get(importSave[1]); if (!imported) throw new Error('导入 Session 已过期，无法保存'); const validation = validateImportedSnapshot(imported.snapshot); if (!validation.valid) throw new Error(validation.message); await state.saveImport(importSave[1], { snapshot: imported.snapshot, analyses: [...imported.analyses.values()], savedAt: new Date().toISOString() }); return json(res, { saved: true, id: importSave[1] }, 201) }
    if (url.pathname === '/api/evaluators' && req.method === 'GET') return json(res, { experimental: experimentalEvaluators, rubrics: experimentalEvaluators ? evaluatorCatalog : [], judgeConfigured: experimentalEvaluators && Boolean(process.env.AGENT_WORKBENCH_JUDGE_BASE_URL && process.env.AGENT_WORKBENCH_JUDGE_API_KEY && process.env.AGENT_WORKBENCH_JUDGE_MODEL) })
    if (url.pathname === '/api/evaluations' && req.method === 'POST') {
      if (!experimentalEvaluators) throw new Error('Experimental Evaluators 未启用')
      if (!originOk(req)) return json(res, { error: '无效来源' }, 403); const body = await readJson(req); const ref = refOf(body.ref); const run = await resolveRun(ref); const taskType = (body.taskType || 'generic') as TaskType
      if (body.mode === 'preview') return json(res, judgePreview(run.evidence, taskType))
      let evaluation
      if (body.mode === 'manual') evaluation = manualEvaluation(taskType, body.dimensions || {}, typeof body.notes === 'string' ? body.notes : null)
      else if (body.mode === 'llm') {
        if (!body.confirmed) throw new Error('LLM Judge 需要在发送预览后明确确认')
        const base = process.env.AGENT_WORKBENCH_JUDGE_BASE_URL; const key = process.env.AGENT_WORKBENCH_JUDGE_API_KEY; const model = process.env.AGENT_WORKBENCH_JUDGE_MODEL
        if (!base || !key || !model) throw new Error('LLM Judge 未配置')
        const preview = judgePreview(run.evidence, taskType)
        const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Score only the supplied evidence. Return JSON: {dimensions:{dimensionId:0-100},notes:string}. Do not infer missing evidence.' }, { role: 'user', content: JSON.stringify(preview) }] }) })
        if (!response.ok) throw new Error(`LLM Judge 请求失败 (${response.status})`)
        const payload = await response.json() as any; evaluation = judgeEvaluation(taskType, JSON.parse(payload.choices?.[0]?.message?.content || '{}'))
      } else evaluation = deterministicEvaluation(taskType, run.evidence)
      await state.saveEvaluation(ref, evaluation); return json(res, evaluation, 201)
    }
    if (url.pathname === '/api/outcomes' && req.method === 'POST') {
      if (!originOk(req)) return json(res, { error: '无效来源' }, 403)
      const body = await readJson(req); const ref = refOf(body.ref); const run = await resolveRun(ref)
      const status = ['success', 'partial', 'failed', 'unknown'].includes(body.status) ? body.status : 'unknown'
      const outcome: RunOutcome = { status, source: 'user', note: typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined, evidence: [...(run.outcome.evidence || []), { type: 'user_confirmation', status: status === 'success' ? 'passed' : status === 'failed' ? 'failed' : 'unknown', label: 'User outcome label' }] }
      await state.saveOutcome(ref, outcome); return json(res, outcome, 201)
    }
    if (url.pathname === '/api/task-groups' && req.method === 'GET') return json(res, await state.groups())
    if (url.pathname === '/api/task-groups' && req.method === 'POST') { if (!originOk(req)) return json(res, { error: '无效来源' }, 403); const body = await readJson(req); return json(res, await state.createGroup({ title: String(body.title || ''), taskType: body.taskType, confirmedRuns: Array.isArray(body.confirmedRuns) ? body.confirmedRuns.map(refOf) : [] }), 201) }
    const groupMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)(?:\/(runs|reliability|suggestions|diagnostics))?(?:\/([^/]+))?$/)
    if (groupMatch) {
      const [, id, operation, key] = groupMatch
      if (operation === 'reliability' && req.method === 'GET') return json(res, await reliability(id))
      if (operation === 'diagnostics' && req.method === 'GET') return json(res, await taskDiagnostics(id))
      if (operation === 'suggestions' && req.method === 'POST') { if (!originOk(req)) return json(res, { error: '无效来源' }, 403); return json(res, await refreshSuggestions(id)) }
      if (!operation && req.method === 'PATCH') { if (!originOk(req)) return json(res, { error: '无效来源' }, 403); const body = await readJson(req); return json(res, await state.patchGroup(id, { title: typeof body.title === 'string' ? body.title : undefined, taskType: body.taskType, baselineRun: body.baselineRun ? refOf(body.baselineRun) : undefined })) }
      if (operation === 'runs' && req.method === 'POST') { if (!originOk(req)) return json(res, { error: '无效来源' }, 403); const body = await readJson(req); return json(res, await state.addRun(id, refOf(body.ref || body))) }
      if (operation === 'runs' && key && req.method === 'DELETE') { if (!originOk(req)) return json(res, { error: '无效来源' }, 403); return json(res, await state.removeRun(id, decodeURIComponent(key))) }
    }
    if (url.pathname === '/api/comparisons' && req.method === 'POST') {
      if (!originOk(req)) return json(res, { error: '无效来源' }, 403); const body = await readJson(req)
      const baselineInput = refOf(body.baseline || {})
      const candidateInput = refOf(body.candidate || {})
      const baseline = baselineInput.turnId ? baselineInput : await latestRef(baselineInput.source, baselineInput.sessionId)
      const candidate = candidateInput.turnId ? candidateInput : await latestRef(candidateInput.source, candidateInput.sessionId)
      const group = body.evalTaskId ? await state.group(String(body.evalTaskId)) : null
      const controlled = Boolean(group && group.confirmedRuns.some(ref => runKey(ref) === runKey(baseline)) && group.confirmedRuns.some(ref => runKey(ref) === runKey(candidate)))
      return json(res, compareRuns(await resolveRun(baseline), await resolveRun(candidate), controlled, group?.title))
    }
    if (url.pathname === '/api/comparisons/export' && req.method === 'POST') {
      if (!originOk(req)) return json(res, { error: '无效来源' }, 403)
      const body = await readJson(req)
      if (body.format != null && !['html', 'report-json', 'bundle-json'].includes(body.format)) throw new Error('不支持的导出格式')
      const format = (body.format || 'html') as 'html' | 'report-json' | 'bundle-json'
      const baselineInput = refOf(body.baseline || {})
      const candidateInput = refOf(body.candidate || {})
      if (!baselineInput.sessionId || !candidateInput.sessionId) throw new Error('必须提供 baseline 和 candidate Session')
      const baseline = baselineInput.turnId ? baselineInput : await latestRef(baselineInput.source, baselineInput.sessionId)
      const candidate = candidateInput.turnId ? candidateInput : await latestRef(candidateInput.source, candidateInput.sessionId)
      const group = body.evalTaskId ? await state.group(String(body.evalTaskId)) : null
      const controlled = Boolean(group && group.confirmedRuns.some(ref => runKey(ref) === runKey(baseline)) && group.confirmedRuns.some(ref => runKey(ref) === runKey(candidate)))
      const optimizationGoal = ['balanced', 'quality', 'cost', 'speed', 'reliability'].includes(body.optimizationGoal) ? body.optimizationGoal : undefined
      const result = compareRuns(await resolveRun(baseline), await resolveRun(candidate), controlled, group?.title, optimizationGoal)
      if (format === 'bundle-json') {
        const { comparisonReport: _comparisonReport, ...bundle } = result
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="comparison-bundle.json"', 'cache-control': 'no-store' }); return res.end(JSON.stringify(bundle))
      }
      const report = sanitizeComparisonReport(result.comparisonReport)
      if (format === 'report-json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="comparison-report.json"', 'cache-control': 'no-store' }); return res.end(JSON.stringify(report, null, 2))
      }
      const shortId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'session'
      const now = new Date(); const stamp = now.toISOString().slice(0, 16).replace(/-/g, '').replace('T', '-').replace(':', '')
      const filename = 'agent-workbench-comparison-' + shortId(baseline.sessionId) + '-vs-' + shortId(candidate.sessionId) + '-' + stamp + '.html'
      const html = renderComparisonHtml(report)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': 'attachment; filename="' + filename + '"', 'cache-control': 'no-store' }); return res.end(html)
    }
    if (url.pathname === '/api/comparisons/validate' && req.method === 'POST') {
      if (!originOk(req)) return json(res, { error: '无效来源' }, 403)
      const body = await readJson(req)
      return json(res, validateComparisonReport(body.report))
    }
    if (url.pathname.startsWith('/api/')) return json(res, { error: '未找到 API 路径' }, 404)
    await staticFile(res, url.pathname)
  } catch (error) { json(res, { error: error instanceof Error ? error.message : '服务错误' }, 400) }
})

server.listen(port, '127.0.0.1', () => console.log(`Agent Workbench running at http://127.0.0.1:${port}`))
