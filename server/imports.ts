import type { NormalizedMessage, NormalizedStep, NormalizedToolCall, NormalizedTrace, NormalizedTurn, ParseDiagnostics, SessionDescriptor, SessionFormat, SessionStatus } from './types.js'

type DshEvent = Record<string, any>
type CanonicalEvent = { timestamp: string; type: string; payload?: Record<string, any> }

export function parseJsonl(text: string) {
  const events: unknown[] = []
  const warnings: string[] = []
  let malformedLines = 0
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    try { events.push(JSON.parse(line)) }
    catch (error) { malformedLines++; warnings.push(`第 ${index + 1} 行 JSON 无法解析：${error instanceof Error ? error.message : '未知错误'}`) }
  })
  return { events, malformedLines, warnings }
}

export function detectSessionFormat(events: unknown[]): SessionFormat {
  const records = events.filter((event): event is DshEvent => Boolean(event && typeof event === 'object'))
  if (records.some(event => event.type === 'session' && typeof event.id === 'string' && event.id.toLowerCase().startsWith('session-'))) return 'deepseek-harness'
  const dshTypes = new Set(['session/title', 'request/context', 'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result'])
  if (records.some(event => event.type === 'session') && records.filter(event => dshTypes.has(String(event.type))).length >= 2) return 'deepseek-harness'
  const codexTypes = new Set(['session_meta', 'turn_context', 'event_msg', 'response_item'])
  if (records.some(event => codexTypes.has(String(event.type)))) return 'codex'
  return 'unknown'
}

const textOf = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') {
    const object = value as Record<string, any>
    if (typeof object.text === 'string') return object.text
    for (const key of ['content', 'message', 'tool-result', 'output', 'result']) if (key in object) return textOf(object[key])
    return Object.values(object).map(textOf).join('')
  }
  return ''
}

export function extractTextContent(value: unknown) { return textOf(value) }

const numberOf = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const timeOf = (event: DshEvent, fallback: number) => {
  const candidate = event.time ?? event.timestamp ?? event.createdAt ?? event.data?.time ?? event.data?.createdAt
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate < 1_000_000_000_000 ? candidate * 1000 : candidate
  if (typeof candidate === 'string') { const parsed = Date.parse(candidate); if (Number.isFinite(parsed)) return parsed }
  return fallback
}
const iso = (value: number) => new Date(value).toISOString()
const eventData = (event: DshEvent) => event.data && typeof event.data === 'object' ? event.data as Record<string, any> : event
const turnNumber = (data: Record<string, any>, fallback?: number) => {
  const value = Number(data.turn ?? data.turnNumber ?? fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback || 1
}
const turnId = (turn: number) => `turn-${turn}`
const parseArguments = (value: unknown) => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) }
  catch { return value }
}
const errorOf = (value: unknown) => {
  if (value === true) return true
  if (!value || typeof value !== 'object') return false
  const object = value as Record<string, any>
  return object.isError === true || object.is_error === true || object.error === true || object.status === 'error' || object.status === 'failed'
}

export interface DshImportResult {
  trace: NormalizedTrace
  descriptor: SessionDescriptor
  events: CanonicalEvent[]
  diagnostics: ParseDiagnostics
}

export function validateImportedSnapshot(snapshot: { descriptor?: SessionDescriptor; normalized?: NormalizedTrace; runs?: unknown[]; v2?: unknown }) {
  const trace = snapshot.normalized
  if (!snapshot.descriptor?.id) return { valid: false, message: '文件已读取，但未解析出有效 Trace 数据。' }
  if (trace && (!trace.id || !trace.source || trace.source.format !== 'deepseek-harness')) return { valid: false, message: '已识别 Session，但规范化 Trace 元数据不完整。' }
  const hasTraceData = trace
    ? Boolean(Array.isArray(trace.turns) && (trace.turns.length || trace.stats?.userMessages || trace.stats?.assistantMessages || trace.stats?.toolCalls))
    : Boolean(snapshot.runs?.length)
  return hasTraceData ? { valid: true as const } : { valid: false as const, message: trace ? '已识别 DeepSeek Harness Session，但未解析出有效对话轨迹。' : '文件已读取，但未解析出有效 Trace 数据。' }
}

export function parseDshSession(events: unknown[], options: { importId?: string; fileName?: string; malformedLines?: number; warnings?: string[] } = {}): DshImportResult {
  const records = events.filter((event): event is DshEvent => Boolean(event && typeof event === 'object'))
  const firstSession = records.find(event => event.type === 'session') || {}
  const nativeSessionId = typeof firstSession.id === 'string' ? firstSession.id : undefined
  const importId = options.importId || nativeSessionId || 'import-session'
  const fileName = options.fileName || 'session.jsonl'
  const createdAt = numberOf(firstSession.createdAt) || timeOf(firstSession, Date.now())
  const cwd = typeof firstSession.cwd === 'string' ? firstSession.cwd : undefined
  const canonical: CanonicalEvent[] = [{ timestamp: iso(createdAt), type: 'session_meta', payload: { id: importId, source_format: 'deepseek-harness', dsh_session_id: nativeSessionId, cwd, agent_preset: firstSession.agentPreset } }]
  const turns = new Map<number, NormalizedTurn>()
  const tools = new Map<string, NormalizedToolCall>()
  const steps = new Map<string, NormalizedStep>()
  const models: Array<{ provider?: string; model: string; time?: number; turn?: number }> = []
  const seenModels = new Set<string>()
  const warnings = [...(options.warnings || [])]
  let title: string | undefined
  let provider: string | undefined
  let model: string | undefined
  let contextWindow: number | undefined
  let currentTurn = 0
  let firstTime = createdAt
  let lastTime = createdAt
  let recognizedEvents = 0
  let ignoredEvents = 0
  let userMessages = 0
  let assistantMessages = 0
  let toolResults = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let generatedToolIndex = 0

  const addModel = (nextProvider: unknown, nextModel: unknown, at: number, turn?: number) => {
    if (typeof nextModel !== 'string' || !nextModel.trim()) return
    const value = nextModel.trim(); const key = `${String(nextProvider || '')}:${value}`
    if (seenModels.has(key)) return
    seenModels.add(key); models.push({ provider: typeof nextProvider === 'string' ? nextProvider : undefined, model: value, time: at, turn })
    if (!model) model = value
    if (!provider && typeof nextProvider === 'string') provider = nextProvider
  }
  const ensureTurn = (turn: number, at: number) => {
    let normalized = turns.get(turn)
    if (!normalized) {
      normalized = { turn, startTime: at, messages: [], tools: [], steps: [] }
      turns.set(turn, normalized)
      canonical.push({ timestamp: iso(at), type: 'turn_context', payload: { model: model || null, model_provider: provider || null, cwd, turn_id: turnId(turn) } })
      canonical.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId(turn) } })
    }
    currentTurn = turn
    return normalized
  }
  const ensureStep = (turn: number, step: number, at: number) => {
    const key = `${turn}:${step}`
    let normalized = steps.get(key)
    if (!normalized) {
      normalized = { turn, step, startTime: at, status: 'unfinished' }
      steps.set(key, normalized); turns.get(turn)?.steps.push(normalized)
    }
    return normalized
  }
  const addWarning = (message: string) => { if (warnings.length < 25) warnings.push(message) }

  for (const event of records) {
    const at = timeOf(event, lastTime || createdAt)
    firstTime = Math.min(firstTime, at); lastTime = Math.max(lastTime, at)
    const data = eventData(event)
    const type = String(event.type || '')
    switch (type) {
      case 'session':
        recognizedEvents++
        break
      case 'session/title':
        recognizedEvents++
        if (typeof data.title === 'string' && data.title.trim()) title = data.title.trim()
        break
      case 'request/context': {
        recognizedEvents++
        const nextProvider = data.provider ?? data.source?.provider
        const nextModel = data.model ?? data.modelName
        if (!provider && typeof nextProvider === 'string') provider = nextProvider
        if (typeof data.contextWindow === 'number') contextWindow = data.contextWindow
        addModel(nextProvider, nextModel, at, currentTurn || undefined)
        if (currentTurn) canonical.push({ timestamp: iso(at), type: 'turn_context', payload: { model: model || null, model_provider: provider || null, cwd, turn_id: turnId(currentTurn) } })
        break
      }
      case 'turn/start': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn + 1); ensureTurn(turn, at)
        break
      }
      case 'turn/end': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn); const normalized = ensureTurn(turn, at); const interrupted = data.reason?.kind === 'interrupted' || data.reason?.kind === 'abort' || data.reason?.kind === 'aborted'; const failed = data.reason?.kind === 'failed' || errorOf(data.reason)
        normalized.endTime = at; normalized.status = interrupted ? 'interrupted' : failed ? 'failed' : 'completed'
        canonical.push({ timestamp: iso(at), type: 'event_msg', payload: { type: interrupted || failed ? 'turn_aborted' : 'task_complete', turn_id: turnId(turn) } })
        break
      }
      case 'session/end': {
        recognizedEvents++
        if (currentTurn) {
          const normalized = ensureTurn(currentTurn, at)
          if (!normalized.endTime) { normalized.endTime = at; normalized.status = 'completed'; canonical.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId(currentTurn) } }) }
        }
        break
      }
      case 'step/start': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn); ensureTurn(turn, at); ensureStep(turn, Number(data.step) || 1, at)
        break
      }
      case 'step/end': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn); const step = ensureStep(turn, Number(data.step) || 1, at); step.endTime = at; step.durationMs = Math.max(0, at - (step.startTime || at)); step.status = 'completed'
        break
      }
      case 'user/message': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn); const normalized = ensureTurn(turn, at); const sourceKind = data.source?.kind || data.role || 'user'; const role: NormalizedMessage['role'] = sourceKind === 'user' ? 'user' : 'plugin'; const message: NormalizedMessage = { id: data.id || event.id, role, text: extractTextContent(data.content), time: at }
        normalized.messages.push(message)
        if (role === 'user') { userMessages++; canonical.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'user_message', message: message.text, turn_id: turnId(turn) } }) }
        break
      }
      case 'assistant/message': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn); const normalized = ensureTurn(turn, at); const messageData = data.message || data; const usage = data.usage || messageData.usage || {}; const message: NormalizedMessage = { id: messageData.id || event.id, role: 'assistant', text: extractTextContent(messageData.content), time: at, usage: { inputTokens: numberOf(usage.inputTokens) ?? undefined, outputTokens: numberOf(usage.outputTokens) ?? undefined, cacheReadTokens: numberOf(usage.cacheReadTokens) ?? undefined } }
        normalized.messages.push(message); assistantMessages++
        const input = numberOf(usage.inputTokens) || 0; const output = numberOf(usage.outputTokens) || 0; const cached = numberOf(usage.cacheReadTokens) || 0; inputTokens += input; outputTokens += output; cacheReadTokens += cached
        addModel(data.provider ?? messageData.provider, data.model ?? messageData.model, at, turn)
        canonical.push({ timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'assistant', content: message.text, id: message.id } }); canonical.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'agent_message', message: message.text, turn_id: turnId(turn) } })
        if (input || output || cached) canonical.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', turn_id: turnId(turn), info: { last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached, total_tokens: input + output }, model_context_window: contextWindow } } })
        break
      }
      case 'tool/call': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn); const normalizedTurn = ensureTurn(turn, at); const stepNumber = Number(data.step) || 1; ensureStep(turn, stepNumber, at); const id = String(data.callId || data.call_id || data.id || `${turnId(turn)}-tool-${++generatedToolIndex}`); const tool: NormalizedToolCall = { id, name: String(data.name || data.tool || 'tool'), arguments: parseArguments(data.arguments ?? data.input), startTime: at }; normalizedTurn.tools.push(tool); tools.set(id, tool); canonical.push({ timestamp: iso(at), type: 'response_item', payload: { type: 'function_call', call_id: id, name: tool.name, arguments: typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments ?? {}) } })
        break
      }
      case 'tool/result': {
        recognizedEvents++
        const turn = turnNumber(data, currentTurn); const normalizedTurn = ensureTurn(turn, at); const source = data.message?.source || data.source || {}; const id = String(source.callId || source.call_id || data.callId || data.call_id || data.id || ''); const tool = tools.get(id)
        if (tool) { tool.result = extractTextContent(data.message?.content ?? data.content ?? data.result ?? data.output); tool.endTime = at; tool.durationMs = Math.max(0, at - (tool.startTime || at)); tool.isError = errorOf(data) || errorOf(data.message) }
        toolResults++; canonical.push({ timestamp: iso(at), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: extractTextContent(data.message?.content ?? data.content ?? data.result ?? data.output), status: errorOf(data) || errorOf(data.message) ? 'failed' : 'success' } }); void normalizedTurn
        break
      }
      case 'assistant/chunk':
      case 'text-chunks':
      case 'tool-call-chunks':
      case 'request/header':
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
      case 'agent-preset/selected':
      case 'agent/inbox/spliced':
      case 'session/title-llm-request':
      case 'job':
      case 'session/end-seed':
        recognizedEvents++; ignoredEvents++
        break
      default:
        ignoredEvents++; addWarning(`忽略未知事件：${type || '未命名事件'}`)
    }
    lastTime = Math.max(lastTime, at)
  }

  const normalizedTurns = [...turns.values()].sort((a, b) => a.turn - b.turn)
  Object.assign(canonical[0].payload!, { model: model || null, model_provider: provider || null, context_window: contextWindow || null })
  for (const turn of normalizedTurns) {
    if (turn.endTime == null && turn.steps.length) for (const step of turn.steps) if (step.endTime == null) step.status = 'unfinished'
    for (const step of turn.steps) if (step.endTime == null) step.status = 'unfinished'
  }
  const status: NormalizedTrace['status'] = normalizedTurns.some(turn => turn.status === 'interrupted') ? 'interrupted' : normalizedTurns.some(turn => turn.status === 'failed') ? 'failed' : normalizedTurns.length && normalizedTurns.every(turn => turn.status === 'completed') ? 'completed' : 'unknown'
  const trace: NormalizedTrace = { id: nativeSessionId || importId, title, source: { format: 'deepseek-harness', provider, model, sessionId: nativeSessionId, importedFileName: fileName, contextWindow, models: models.length ? models : undefined }, createdAt, cwd, status, turns: normalizedTurns, stats: { inputTokens, outputTokens, cacheReadTokens, toolCalls: [...tools.values()].length, toolResults, userMessages, assistantMessages, durationMs: Math.max(0, lastTime - firstTime), ignoredEventCount: ignoredEvents }, rawEventCount: records.length }
  const sessionStatus: SessionStatus = status === 'completed' ? 'complete' : status === 'interrupted' || status === 'failed' ? 'aborted' : 'unknown'
  const descriptor: SessionDescriptor = { id: importId, source: 'import', parentId: null, projectPath: cwd || null, model: model || null, startedAt: iso(firstTime), updatedAt: iso(lastTime), status: sessionStatus, childCount: 0, turnCount: normalizedTurns.length || undefined, latestTurnId: normalizedTurns.at(-1) ? turnId(normalizedTurns.at(-1)!.turn) : null, name: title || `DeepSeek Harness ${nativeSessionId?.slice(0, 8) || importId.slice(0, 8)}`, titleSource: title ? 'native' : 'fallback_id', nativeSessionId: nativeSessionId || null, sourceFormat: 'deepseek-harness', provider: provider || null, importedFileName: fileName, contextWindow: contextWindow || null, models: models.length ? models : undefined }
  const diagnostics: ParseDiagnostics = { format: 'deepseek-harness', rawEvents: records.length, recognizedEvents, ignoredEvents, malformedLines: options.malformedLines || 0, turns: normalizedTurns.length, messages: userMessages + assistantMessages, toolCalls: tools.size, warnings }
  return { trace, descriptor, events: canonical, diagnostics }
}
