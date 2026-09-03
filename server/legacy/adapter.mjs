import fs from 'node:fs/promises'
import path from 'node:path'
import { markRetryClusters, stepVerdict, toolVerdict } from './verdict.mjs'
import { createSessionAdapter } from './session-data.mjs'

const sessionData = createSessionAdapter()

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RESULT = 5000

export function isUuid(value) { return typeof value === 'string' && UUID_RE.test(value) }

function timestampOf(event) {
  const value = Date.parse(event?.timestamp ?? '')
  return Number.isFinite(value) ? value : 0
}

function asText(value, output = []) {
  if (value == null) return output.join('')
  if (typeof value === 'string') { output.push(value); return output.join('') }
  if (Array.isArray(value)) { for (const item of value) asText(item, output); return output.join('') }
  if (typeof value === 'object') {
    if (value.type === 'input_text' || value.type === 'text' || value.type === 'output_text') {
      if (typeof value.text === 'string') output.push(value.text)
    } else {
      for (const item of Object.values(value)) asText(item, output)
    }
  }
  return output.join('')
}

function hasError(value) {
  if (value == null) return false
  if (Array.isArray(value)) return value.some(hasError)
  if (typeof value === 'object') {
    if (value.isError === true || value.error === true) return true
    return Object.values(value).some(hasError)
  }
  return false
}

function hasNonZeroExit(text) {
  return /(?:exit(?:_code| code)?|status)[^\d]{0,8}(?:[=: ]+)([1-9]\d*)/i.test(text)
    || /__EXIT__=[1-9]\d*/.test(text)
}

function compactArgs(input) {
  if (typeof input !== 'string') return JSON.stringify(input ?? '')
  try {
    const value = JSON.parse(input)
    if (value && typeof value === 'object') {
      if (typeof value.command === 'string') return value.command
      if (typeof value.file_path === 'string') return value.file_path
      if (typeof value.pattern === 'string') return `pattern=${value.pattern}${value.path ? ` path=${value.path}` : ''}`
      if (typeof value.query === 'string') return value.query
    }
  } catch {}
  return input
}

function classifyToolName(name) {
  const normalized = String(name ?? '').toLowerCase()
  if (normalized === 'apply_patch' || /(?:write|edit|todo)/.test(normalized)) return 'write'
  if (normalized.includes('web__run') || /(?:grep|read|search|list|find|glob|image)/.test(normalized)) return 'search'
  if (normalized === 'exec' || /(?:shell|bash|command|terminal)/.test(normalized)) return 'command'
  return normalized
}

function parsedOperations(item) {
  const parsed = Array.isArray(item?.parsed_cmd) ? item.parsed_cmd : []
  return parsed.length ? parsed.map((entry, index) => ({
    id: `${item.id ?? 'command'}:${index}`,
    name: entry.type ?? 'command',
    args: entry.cmd ?? entry.path ?? entry.pattern ?? asText(item.command),
  })) : [{ id: item?.id, name: 'command', args: asText(item?.command) }]
}

function nestedToolNames(input) {
  return [...String(input ?? '').matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1])
}

function classifyTool(tool) {
  const result = tool.resFull ?? tool.res ?? ''
  const verdict = toolVerdict({
    name: classifyToolName(tool.name),
    res: result,
    err: tool.err || hasNonZeroExit(result),
  })
  return { v: verdict.v, why: verdict.why }
}

function eventKey(event) {
  const payload = event.payload ?? {}
  if (event.type === 'response_item') return payload.id ?? `${payload.type}:${payload.call_id ?? ''}:${event.timestamp}`
  if (event.type === 'event_msg') {
    if (payload.type === 'user_message') return `user:${payload.client_id ?? event.timestamp}`
    if (payload.type === 'token_count') {
      const total = payload.info?.total_token_usage?.total_tokens ?? ''
      return `token:${event.timestamp}:${total}`
    }
    if (payload.type === 'task_started' || payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      return `${payload.type}:${payload.turn_id ?? event.timestamp}`
    }
  }
  return payload.id ?? payload.call_id ?? payload.item?.id ?? `${event.type}:${event.timestamp}:${JSON.stringify(payload).slice(0, 160)}`
}

function isCanonical(event) {
  const payload = event.payload ?? {}
  if (event.type === 'response_item') {
    if (payload.type === 'message' && !['assistant', 'user'].includes(payload.role)) return false
    return ['message', 'reasoning', 'custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output'].includes(payload.type)
  }
  if (event.type === 'event_msg') {
    return ['user_message', 'task_started', 'task_complete', 'turn_aborted', 'token_count', 'item_completed', 'mcp_tool_call_end', 'web_search_end', 'patch_apply_end', 'image_generation_end', 'context_compacted', 'sub_agent_activity'].includes(payload.type)
  }
  return ['session_meta', 'turn_context', 'compacted'].includes(event.type)
}

function makeRow(step, turn, start) {
  return {
    step,
    turn: Math.max(turn, 1),
    s: start,
    e: start,
    tools: [],
    rz: 0,
    rzTxt: '',
    rzTxtFull: '',
    rzTok: null,
    outTok: null,
    v: 'answer',
    _pending: new Map(),
  }
}

export function buildMaze(events, sessionMeta) {
  const usable = events.slice().sort((a, b) => timestampOf(a) - timestampOf(b))
  const firstUser = usable.find((event) => (event.type === 'event_msg' && event.payload?.type === 'user_message') || event.payload?.item?.type === 'UserMessage')
  const anchor = timestampOf(firstUser ?? usable[0]) || Date.now()
  const rel = (time) => Math.max(0, Math.round(((time - anchor) / 100)) / 10)
  const rows = []
  const pending = new Map()
  let turn = 0
  let step = 0
  let current = null
  let lastToken = null
  let totalTokens = null
  let model = null
  let ttftMs = null
  let completed = false
  const modernItems = usable.some((event) => event.type === 'event_msg' && event.payload?.type === 'item_completed' && ['CommandExecution', 'DynamicToolCall'].includes(event.payload?.item?.type))
  const turnById = new Map()
  const outerCalls = usable.filter((event) => event.type === 'response_item' && event.payload?.type === 'custom_tool_call').map((event) => ({ time: timestampOf(event), name: event.payload?.name, input: String(event.payload?.input ?? ''), nested: nestedToolNames(event.payload?.input) }))
  const outerNameAt = (time, command) => {
    const before = outerCalls.filter((call) => call.time <= time && time - call.time < 60000)
    const call = before.findLast((candidate) => command && candidate.input.includes(command)) ?? before.at(-1)
    return call?.nested.includes('exec_command') || call?.name === 'exec' ? 'exec_command' : (call?.nested.length === 1 ? call.nested[0] : call?.name ?? null)
  }

  const ensureRow = (time, forceNew = false) => {
    if (current && !forceNew) return current
    current = makeRow(++step, turn, rel(time))
    rows.push(current)
    return current
  }

  for (const event of usable) {
    const time = timestampOf(event)
    const relative = rel(time)
    const payload = event.payload ?? {}
    if (event.type === 'session_meta') {
      model = payload.model ?? model
      continue
    }
    if (event.type === 'turn_context') { model = payload.model ?? model; continue }
    if (event.type === 'event_msg') {
      if (payload.type === 'user_message') {
        turn += 1
        current = null
      } else if (payload.type === 'item_completed') {
        const item = payload.item ?? {}
        if (item.type === 'UserMessage') {
          turn = Math.max(turn + 1, 1)
          if (payload.turn_id) turnById.set(payload.turn_id, turn)
          current = null
        } else if (modernItems && ['CommandExecution', 'DynamicToolCall'].includes(item.type)) {
          const started = Number(item.started_at_ms ?? payload.started_at_ms ?? time) || time
          const ended = Number(item.completed_at_ms ?? payload.completed_at_ms ?? time) || time
          const row = makeRow(++step, turnById.get(payload.turn_id) ?? Math.max(turn, 1), rel(started))
          const full = asText(item.formatted_output ?? item.aggregated_output ?? item.stdout ?? item.result ?? '').replace(/\s+/g, ' ').trim()
          const operations = item.type === 'CommandExecution' ? parsedOperations(item) : [{ id: item.id, name: `${item.namespace ?? 'mcp'}__${item.tool ?? item.name ?? 'tool'}`, args: compactArgs(item.arguments ?? item.input) }]
          const types = [...new Set(operations.map(operation => operation.name === 'unknown' ? 'command' : operation.name))]
          const baseName = item.type === 'CommandExecution' ? (outerNameAt(started, operations[0]?.args) ?? 'exec_command') : operations[0].name
          const tool = {
            k: 't', name: baseName, type: types.join(' / '), s: rel(started), e: rel(ended), args: operations.map(operation => operation.args).filter(Boolean).join('\n').slice(0, MAX_RESULT),
            res: full.slice(0, 380), resFull: full.slice(0, MAX_RESULT), err: Number(item.exit_code) !== 0 || item.success === false || /(?:failed|error)/i.test(String(item.status ?? '')), dur: Math.round(Math.max(0, rel(ended) - rel(started)) * 10) / 10, v: 'ok', callId: item.id,
          }
          const verdictType = ['write', 'search', 'read', 'command'].find(type => types.includes(type)) ?? types[0]
          const verdict = classifyTool({ ...tool, name: verdictType }); tool.v = verdict.v; tool.why = verdict.why; row.tools.push(tool)
          row.e = Math.max(row.s, rel(ended)); rows.push(row); current = row
        }
      } else if (payload.type === 'task_started') {
        if (typeof payload.time_to_first_token_ms === 'number') ttftMs = payload.time_to_first_token_ms
      } else if (payload.type === 'task_complete') {
        completed = true
        if (typeof payload.time_to_first_token_ms === 'number') ttftMs = payload.time_to_first_token_ms
        if (current) current.e = Math.max(current.e, relative)
      } else if (payload.type === 'turn_aborted') {
        completed = true
        if (current) current.e = Math.max(current.e, relative)
      } else if (payload.type === 'token_count') {
        lastToken = payload.info?.last_token_usage ?? null
        const cumulative = payload.info?.total_token_usage?.total_tokens
        if (typeof cumulative === 'number') totalTokens = cumulative
        if (current && lastToken) {
          if (typeof lastToken.reasoning_output_tokens === 'number') current.rzTok = lastToken.reasoning_output_tokens
          if (typeof lastToken.output_tokens === 'number') current.outTok = lastToken.output_tokens
        }
      }
      continue
    }
    if (event.type !== 'response_item') continue
    if (payload.type === 'reasoning') {
      const row = ensureRow(time, Boolean(current?.tools.length || current?.rzTxt))
      const summary = asText(payload.summary ?? payload.encrypted_content ?? '')
      row.rz += 1
      row.rzTxt += summary
      row.e = Math.max(row.e, relative)
    } else if (payload.type === 'message' && payload.role === 'assistant') {
      const row = ensureRow(time)
      const text = asText(payload.content ?? payload.output ?? '').replace(/\s+/g, ' ').trim()
      if (text) {
        row.label = text.slice(0, 240)
        row.labelFull = text.slice(0, MAX_RESULT)
      }
      row.e = Math.max(row.e, relative)
    } else if ((payload.type === 'function_call' || (payload.type === 'custom_tool_call' && !modernItems))) {
      const row = ensureRow(time)
      const tool = {
        k: 't',
        name: payload.name ?? '?',
        s: relative,
        e: null,
        args: compactArgs(payload.input ?? payload.arguments),
        res: '',
        resFull: '',
        err: false,
        dur: 0,
        v: 'ok',
        callId: payload.call_id,
      }
      row.tools.push(tool)
      if (payload.call_id) pending.set(payload.call_id, { tool, row })
      row.e = Math.max(row.e, relative)
    } else if (payload.type === 'function_call_output' || (payload.type === 'custom_tool_call_output' && !modernItems)) {
      const item = pending.get(payload.call_id)
      if (!item) continue
      pending.delete(payload.call_id)
      const full = asText(payload.output).replace(/\s+/g, ' ').trim()
      item.tool.e = relative
      item.tool.dur = Math.round(Math.max(0, relative - item.tool.s) * 10) / 10
      item.tool.resFull = full.slice(0, MAX_RESULT)
      item.tool.res = full.slice(0, 380)
      item.tool.err = hasError(payload.output) || hasNonZeroExit(full)
      const verdict = classifyTool({ ...item.tool, resFull: full })
      item.tool.v = verdict.v
      item.tool.why = verdict.why
      item.row.e = Math.max(item.row.e, relative)
    }
  }

  for (const row of rows) {
    const normalized = row.rzTxt.replace(/\s+/g, ' ').trim()
    row.rzTxt = normalized.slice(0, 240)
    row.rzTxtFull = normalized.slice(0, 2000)
    for (const tool of row.tools) {
      if (tool.e === null) {
        tool.v = 'ok'
        tool.why = { k: 'pendingTools' }
      }
    }
    markRetryClusters(row.tools.filter((tool) => tool.e !== null))
    const settled = row.tools.filter((tool) => tool.e !== null)
    const verdict = stepVerdict(settled)
    row.v = verdict === null ? 'answer' : verdict.v
    row.why = verdict?.why ?? { k: 'noTools' }
    if (verdict?.why2) row.why2 = verdict.why2
    delete row._pending
  }

  const main = []
  const detours = []
  let lastMain = null
  for (const row of rows) {
    if (row.v === 'ok' || row.v === 'answer') {
      main.push(row)
      lastMain = row
    } else {
      detours.push({ ...row, attach: lastMain?.step ?? 0 })
    }
  }
  const T = Math.max(...rows.map((row) => row.e), 0.1)
  const stats = {
    steps: rows.length,
    tools: rows.reduce((sum, row) => sum + row.tools.length, 0),
    rz: rows.reduce((sum, row) => sum + row.rz, 0),
    rzTok: rows.some((row) => row.rzTok !== null) ? rows.reduce((sum, row) => sum + (row.rzTok ?? 0), 0) : null,
    outTok: rows.some((row) => row.outTok !== null) ? rows.reduce((sum, row) => sum + (row.outTok ?? 0), 0) : null,
    T,
    main: main.length,
    detours: detours.length,
    ttftMs,
    totalTokens,
  }
  const metrics = sessionData.metrics(usable, 0, sessionMeta?.id ?? sessionMeta?.session_id)
  model = metrics.identity.model ?? model ?? metrics.identity.provider
  const lane = { key: 'l1', model, rows, main, detours, preWindow: 0, stats, metrics }
  return {
    data: { Tmax: Math.max(T, 460), lanes: rows.length ? [lane] : [] },
    status: completed ? 'complete' : 'live',
    lastToken,
  }
}

export class TrajectoryParser {
  constructor(sessionId) {
    if (!isUuid(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    this.sessionId = sessionId
    this.reset()
  }

  reset() {
    this.buffer = ''
    this.offset = 0
    this.events = []
    this.keys = new Set()
    this.sessionMeta = null
    this.malformed = 0
  }

  ingest(chunk, { final = false } = {}) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = final ? '' : (lines.pop() ?? '')
    for (const raw of lines) {
      const text = raw.trim()
      if (!text) continue
      let event
      try { event = JSON.parse(text) } catch { this.malformed += 1; continue }
      const key = eventKey(event)
      if (this.keys.has(key) || !isCanonical(event)) continue
      this.keys.add(key)
      if (event.type === 'session_meta') {
        const payload = event.payload ?? {}
        if (payload.id === this.sessionId || payload.session_id === this.sessionId) this.sessionMeta = payload
      }
      this.events.push(event)
    }
    if (final && this.buffer.trim()) {
      try {
        const event = JSON.parse(this.buffer)
        const key = eventKey(event)
        if (!this.keys.has(key) && isCanonical(event)) this.events.push(event)
      } catch { this.malformed += 1 }
      this.buffer = ''
    }
    return this.snapshot()
  }

  snapshot() {
    const result = buildMaze(this.events, this.sessionMeta)
    if (result.data.lanes[0]) result.data.lanes[0].metrics.coverage.malformedLines = this.malformed
    const diagnostics = this.malformed ? `${this.malformed} 行 JSONL 无法解析，已跳过` : undefined
    return {
      sessionId: this.sessionId,
      status: result.status,
      updatedAt: Date.now(),
      data: result.data,
      diagnostics,
    }
  }
}

async function firstLine(file) {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const line = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0]
    return JSON.parse(line)
  } finally { await handle.close() }
}

export async function findSessionFile(root, sessionId, { includeSubagent = false } = {}) {
  if (!isUuid(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  const suffix = `-${sessionId}.jsonl`.toLowerCase()
  const candidates = []
  async function walk(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) candidates.push(full)
    }
  }
  await walk(root)
  for (const file of candidates.sort()) {
    try {
      const meta = await firstLine(file)
      const payload = meta.payload ?? {}
      const id = payload.id ?? payload.session_id
      const source = payload.source
      if (id === sessionId && (includeSubagent || !(source && typeof source === 'object' && source.subagent))) return file
    } catch {}
  }
  return null
}

/** Read-only local child discovery.  The small metadata first-line scan keeps
 * live polling independent of large rollout contents. */
export async function findSessionDescendants(root, parentId) {
  const metas = []
  async function walk(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const event = await firstLine(file); const p = event.payload ?? {}
          const id = p.id ?? p.session_id
          if (isUuid(id)) metas.push({ id: id.toLowerCase(), parentId: typeof p.parent_thread_id === 'string' ? p.parent_thread_id.toLowerCase() : null, source: p.source, file })
        } catch {}
      }
    }
  }
  await walk(root)
  const found = [], seen = new Set([parentId])
  for (let changed = true; changed;) {
    changed = false
    for (const meta of metas) if (meta.parentId && seen.has(meta.parentId) && !seen.has(meta.id)) { seen.add(meta.id); found.push(meta); changed = true }
  }
  return found
}

export async function readSessionMetrics(file, sessionId) {
  const text = await fs.readFile(file, 'utf8')
  const parsed = sessionData.parse(text)
  return sessionData.metrics(parsed.events, parsed.malformed, sessionId)
}

export function mergeSubagentMetrics(main, children, expected) { return sessionData.mergeChildren(main, children, expected) }

export async function readDelta(file, state) {
  const stat = await fs.stat(file)
  if (state.fileKey !== `${stat.dev}:${stat.ino}` || stat.size < state.offset) {
    state.fileKey = `${stat.dev}:${stat.ino}`
    state.offset = 0
    state.parser.reset()
  }
  if (stat.size > state.offset) {
    const handle = await fs.open(file, 'r')
    try {
      const length = stat.size - state.offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, state.offset)
      state.offset = stat.size
      state.parser.ingest(buffer.toString('utf8'))
    } finally { await handle.close() }
  }
  return state.parser.snapshot()
}
