// Dependency-free Codex rollout normalizer.  Kept as a factory so the same
// source can be evaluated in the sandboxed upload iframe.
export function createSessionAdapter() {
  const MAX_POINTS = 80
  const idOf = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : null
  const timeOf = event => {
    const value = Number(event?.payload?.item?.completed_at_ms ?? event?.payload?.completed_at_ms ?? Date.parse(event?.timestamp ?? ''))
    return Number.isFinite(value) ? value : 0
  }
  const textOf = value => {
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(textOf).join('')
    if (typeof value === 'object') return typeof value.text === 'string' ? value.text : Object.values(value).map(textOf).join('')
    return String(value)
  }
  const statusFailed = value => value === false || /(?:fail|error|abort|cancel)/i.test(String(value ?? ''))
  const category = (name, item = {}) => {
    const n = String(name || '').toLowerCase()
    const p = String(item?.parsed_cmd?.type || '').toLowerCase()
    if (/web_search|web__|browser/.test(n)) return 'web'
    if (/mcp|dynamictool/.test(n) || item.namespace) return 'mcp'
    if (/image|media|audio|video/.test(n)) return 'media'
    if (/subagent|thread_spawn|collaboration|agent|request_user_input|ask_user/.test(n)) return 'collaboration'
    if (/apply_patch|write|edit|filechange/.test(n) || p === 'write') return 'write'
    if (/read|view|list_files/.test(n) || p === 'read' || p === 'list_files') return 'read'
    if (/search|find|grep|glob/.test(n) || p === 'search') return 'search'
    if (/command|exec|bash|shell|terminal/.test(n) || p === 'command') return 'command'
    return 'other'
  }
  const parsedOperations = item => {
    const parsed = Array.isArray(item?.parsed_cmd) ? item.parsed_cmd : []
    return parsed.length ? parsed : [{ type: 'command', cmd: textOf(item?.command) }]
  }
  const nestedToolNames = input => [...String(input ?? '').matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1])
  const tool = (name, id, start, end, success, detail = {}) => ({
    id: id || `${name}:${start}:${end}`, name: name || '?', category: category(name, detail), start: start || end || 0,
    end: end || start || 0, duration: Number.isFinite(detail.duration_ms) ? detail.duration_ms : Math.max(0, (end || start || 0) - (start || end || 0)), failed: statusFailed(success) || Number(detail.exit_code) !== 0 || detail.isError === true,
    success: !statusFailed(success) && Number(detail.exit_code) === 0 && detail.isError !== true, wrapper: detail.wrapper === true, categories: detail.categories || null, types: detail.types || null,
  })
  const empty = () => ({
    identity: { sessionId: null, startedAt: null, model: null, provider: null, effort: null, cliVersion: null, originator: null, compHash: null, toolManifestHash: null },
    timing: { turns: 0, modelCalls: 0, activeMs: 0, elapsedMs: 0, averageTtftMs: null, toolWallMs: 0, toolCumulativeMs: 0 },
    tokens: { input: null, cachedInput: null, cacheWriteInput: null, uncachedInput: null, output: null, reasoningOutput: null, visibleOutput: null, total: null },
    context: { windowTokens: null, peakRatio: null, endRatio: null, compactions: 0, points: [] },
    tools: { total: 0, succeeded: 0, failed: 0, retries: 0, byName: {}, byCategory: {} },
    subagents: { total: 0, explicit: 0, system: 0, failed: 0, tokens: 0, tools: 0, toolFailures: 0, activeMs: 0, loaded: 0, expected: 0 }, quality: null,
    coverage: { malformedLines: 0, modelKnown: false, tokenUsageKnown: false, toolPairingRatio: 1, subagentRatio: 1, live: true },
  })
  const addTool = (metrics, entry) => {
    const tools = metrics.tools; tools.total += 1
    if (entry.failed) tools.failed += 1; else tools.succeeded += 1
    metrics.timing.toolCumulativeMs += entry.duration
    const add = (bucket, key, category = null, duration = entry.duration) => {
      const x = bucket[key] || (bucket[key] = { total: 0, succeeded: 0, failed: 0, retries: 0, durationMs: 0, ...(category ? { category } : {}) })
      if (category && x.category !== category) x.category = [...new Set(`${x.category || ''} / ${category}`.split(' / ').filter(Boolean))].join(' / ')
      x.total++; x.durationMs += duration; if (entry.failed) x.failed++; else x.succeeded++
    }
    const categories = [...new Set(entry.categories || [entry.category])]
    const types = [...new Set(entry.types || categories)]
    add(tools.byName, entry.name, categories.join(' / '))
    const byName = tools.byName[entry.name]
    byName.byType ||= {}
    categories.forEach(category => {
      add(tools.byCategory, category, category, entry.duration / categories.length)
    })
    types.forEach(type => add(byName.byType, type, type, entry.duration / types.length))
  }
  const retryKey = entry => `${entry.category}:${entry.name}`
  const finalizeTools = (metrics, entries) => {
    const seen = new Map(); let paired = 0
    for (const entry of entries) {
      if (seen.has(entry.id)) continue
      // item_completed is the authoritative inner tool record; do not count its outer exec wrapper too.
      if (entry.wrapper && entries.some(x => !x.wrapper && x.start >= entry.start && x.end <= entry.end)) continue
      seen.set(entry.id, entry); addTool(metrics, entry); if (entry.end > entry.start) paired++
    }
    const lastByKey = new Map()
    for (const entry of seen.values()) {
      const previous = lastByKey.get(retryKey(entry)); if (previous?.failed && entry.start - previous.end < 120000) {
        metrics.tools.retries++; const b = metrics.tools.byName[entry.name]; if (b) b.retries++; for (const category of new Set(entry.categories || [entry.category])) { const c = metrics.tools.byCategory[category]; if (c) c.retries++ } for (const type of new Set(entry.types || entry.categories || [entry.category])) { const typed = b?.byType?.[type]; if (typed) typed.retries++ }
      }
      lastByKey.set(retryKey(entry), entry)
    }
    metrics.coverage.toolPairingRatio = seen.size ? paired / seen.size : 1
    const intervals = [...seen.values()].filter(x => x.end > x.start).map(x => [x.start, x.end]).sort((a,b) => a[0]-b[0])
    let end = -Infinity; for (const [s,e] of intervals) { if (e > end) { metrics.timing.toolWallMs += e - Math.max(s, end); end = e } }
  }
  const parse = text => {
    const events = []; let malformed = 0
    for (const line of String(text || '').split(/\r?\n/)) { if (!line.trim()) continue; try { events.push(JSON.parse(line)) } catch { malformed++ } }
    return { events, malformed }
  }
  const metrics = (events, malformed = 0, sessionId = null) => {
    const m = empty(), calls = [], ttf = [], tools = [], starts = [], ends = []; let totalUsage = null, window = null, started = null, completed = false
    const ordered = [...events].sort((a,b) => timeOf(a)-timeOf(b)), childIds = new Set()
    const hasCompletedTools = ordered.some(event => event.type === 'event_msg' && event.payload?.type === 'item_completed' && ['CommandExecution', 'DynamicToolCall'].includes(event.payload?.item?.type))
    const outerCalls = ordered.filter(event => event.type === 'response_item' && event.payload?.type === 'custom_tool_call').map(event => ({ time: timeOf(event), name: event.payload?.name, input: String(event.payload?.input ?? ''), nested: nestedToolNames(event.payload?.input) }))
    const outerNameAt = (time, command) => {
      const before = outerCalls.filter(call => call.time <= time && time - call.time < 60000)
      const call = before.findLast(candidate => command && candidate.input.includes(command)) || before.at(-1)
      return call?.nested.includes('exec_command') || call?.name === 'exec' ? 'exec_command' : (call?.nested.length === 1 ? call.nested[0] : call?.name || null)
    }
    for (const event of ordered) {
      const p = event.payload || {}; const at = timeOf(event); if (at && started == null) started = at
      if (event.type === 'session_meta') {
        m.identity.sessionId = idOf(p.id || p.session_id) || sessionId || m.identity.sessionId; m.identity.provider = p.model_provider || null
        m.identity.cliVersion = p.cli_version || null; m.identity.originator = p.originator || null
        m.identity.toolManifestHash = p.dynamic_tools ? String(p.dynamic_tools).slice(0, 64) : null
        m.identity.startedAt = event.timestamp || m.identity.startedAt
      } else if (event.type === 'turn_context') {
        m.identity.model = p.model || m.identity.model; m.identity.effort = p.effort || m.identity.effort; m.identity.compHash = p.comp_hash || m.identity.compHash
      } else if (event.type === 'event_msg') {
        if (p.type === 'user_message') m.timing.turns++
        if (p.type === 'task_started') { starts.push(at); window = p.model_context_window || window }
        if (p.type === 'task_complete' || p.type === 'turn_aborted') { ends.push(at); completed = true; if (Number.isFinite(p.time_to_first_token_ms)) ttf.push(p.time_to_first_token_ms) }
        if (p.type === 'context_compacted' || p.type === 'compaction') { m.context.compactions++; if (m.context.points.length) m.context.points.at(-1).compacted = true }
        if (p.type === 'sub_agent_activity' && idOf(p.agent_thread_id)) childIds.add(idOf(p.agent_thread_id))
        if (p.type === 'token_count') {
          const info = p.info || {}, last = info.last_token_usage, total = info.total_token_usage
          window = info.model_context_window || window
          if (last && Number.isFinite(last.input_tokens)) { calls.push(last); const ratio = window ? last.input_tokens / window : null; if (ratio != null) m.context.points.push({ call: calls.length, ratio, compacted: false }) }
          if (total && Number.isFinite(total.total_tokens)) totalUsage = total
        }
      } else if (event.type === 'compacted') { m.context.compactions++; if (m.context.points.length) m.context.points.at(-1).compacted = true }
      if (!hasCompletedTools && event.type === 'response_item' && p.type === 'custom_tool_call') tools.push(tool(p.name, p.call_id || p.id, at, at, true, { wrapper: true, parsed_cmd: { type: 'command' } }))
      if (!hasCompletedTools && event.type === 'response_item' && p.type === 'custom_tool_call_output') { const x = tools.find(v => v.id === p.call_id); if (x) { x.end = at; x.duration = Math.max(0, at-x.start); x.failed = /error|exit(?:_code)?[^0-9]*[1-9]/i.test(textOf(p.output)); x.success = !x.failed } }
      if (event.type === 'response_item' && p.type === 'function_call') tools.push(tool(p.name, p.call_id || p.id, at, at, true, { parsed_cmd: { type: category(p.name) } }))
      if (event.type === 'response_item' && p.type === 'function_call_output') { const x = tools.find(v => v.id === p.call_id); if (x) { x.end = at; x.duration = Math.max(0, at-x.start); x.failed = /error|exit(?:_code)?[^0-9]*[1-9]/i.test(textOf(p.output)); x.success = !x.failed } }
      if (event.type === 'event_msg' && p.type === 'item_completed') {
        const item = p.item || {}, kind = item.type || '', id = item.call_id || item.id || p.item_id
        if (kind === 'CommandExecution') {
          const operations = parsedOperations(item), start = item.started_at_ms || p.started_at_ms, end = item.completed_at_ms || p.completed_at_ms || at
          const name = outerNameAt(start, operations[0]?.cmd) || 'exec_command'
          const categories = operations.map(operation => category(name, { ...item, parsed_cmd: operation }))
          const types = operations.map(operation => operation.type === 'unknown' ? 'command' : (operation.type || 'command'))
          tools.push(tool(name, id, start, end, item.exit_code === 0 && item.status !== 'failed', { ...item, categories, types }))
        }
        else if (kind === 'DynamicToolCall') tools.push(tool(`${item.namespace || 'mcp'}__${item.tool || item.name || 'tool'}`, id, item.started_at_ms || p.started_at_ms, item.completed_at_ms || p.completed_at_ms || at, item.success !== false && item.status !== 'failed', item))
      }
      if (event.type === 'event_msg' && p.type === 'mcp_tool_call_end') tools.push(tool(`mcp__${p.invocation?.server || 'server'}__${p.invocation?.tool || 'tool'}`, p.call_id, at - (p.duration || 0), at, !p.isError && !p.error, p))
      if (event.type === 'event_msg' && p.type === 'web_search_end') tools.push(tool('web__search', p.call_id, at - (p.duration || 0), at, !p.isError && !p.error, p))
      if (event.type === 'event_msg' && p.type === 'patch_apply_end') tools.push(tool('apply_patch', p.call_id, at - (p.duration || 0), at, p.success !== false && p.status !== 'failed', p))
      if (event.type === 'event_msg' && (p.type === 'image_generation_end' || p.type === 'image_view')) tools.push(tool('media__image', p.call_id, at, at, p.status !== 'failed', p))
    }
    const last = calls.at(-1) || null
    if (totalUsage || last) {
      const u = totalUsage || last; const n = k => Number.isFinite(u[k]) ? u[k] : 0
      m.tokens.input = n('input_tokens'); m.tokens.cachedInput = n('cached_input_tokens'); m.tokens.cacheWriteInput = n('cache_write_input_tokens'); m.tokens.output = n('output_tokens'); m.tokens.reasoningOutput = n('reasoning_output_tokens'); m.tokens.total = Number.isFinite(u.total_tokens) ? u.total_tokens : m.tokens.input + m.tokens.output
      m.tokens.uncachedInput = Math.max(0, m.tokens.input - m.tokens.cachedInput - m.tokens.cacheWriteInput); m.tokens.visibleOutput = Math.max(0, m.tokens.output - m.tokens.reasoningOutput); m.coverage.tokenUsageKnown = true
    }
    m.context.windowTokens = window || null; const points = m.context.points; if (points.length > MAX_POINTS) m.context.points = points.filter((_,i) => i % Math.ceil(points.length/MAX_POINTS) === 0 || i === points.length-1)
    if (points.length) { m.context.peakRatio = Math.max(...points.map(x=>x.ratio)); m.context.endRatio = points.at(-1).ratio }
    m.subagents.expected = childIds.size; m.timing.modelCalls = calls.length; m.timing.averageTtftMs = ttf.length ? ttf.reduce((a,b)=>a+b,0)/ttf.length : null; m.timing.elapsedMs = started && (ends.at(-1) || ordered.at(-1) && timeOf(ordered.at(-1))) ? Math.max(0, (ends.at(-1) || timeOf(ordered.at(-1))) - started) : 0
    m.timing.activeMs = m.timing.elapsedMs; finalizeTools(m, tools); m.coverage.malformedLines = malformed; m.coverage.modelKnown = Boolean(m.identity.model); m.coverage.live = !completed
    return m
  }
  const mergeChildren = (main, children, expected = children.length) => {
    const out = JSON.parse(JSON.stringify(main)); const loaded = children.length, intervals = []
    expected = Math.max(expected, out.subagents.expected || 0); out.subagents.loaded = loaded; out.subagents.expected = expected; out.coverage.subagentRatio = expected ? loaded / expected : 1
    for (const child of children) { const kind = child.kind === 'thread_spawn' ? 'explicit' : 'system'; out.subagents.total++; out.subagents[kind]++; out.subagents.failed += child.metrics.coverage.live ? 0 : 0; out.subagents.tokens += child.metrics.tokens.total || 0; out.subagents.tools += child.metrics.tools.total; out.subagents.toolFailures += child.metrics.tools.failed; intervals.push([0, child.metrics.timing.activeMs || 0]) }
    intervals.sort((a,b)=>a[0]-b[0]); let end = 0; for (const [s,e] of intervals) if (e > end) { out.subagents.activeMs += e-Math.max(end,s); end=e }
    return out
  }
  return { parse, metrics, mergeChildren, category, idOf, textOf }
}
