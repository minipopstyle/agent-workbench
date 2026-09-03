import { buildMaze } from './adapter.mjs'

const RETRY_WINDOW_MS = 120_000

const textOf = value => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') return typeof value.text === 'string' ? value.text : Object.values(value).map(textOf).join('')
  return String(value)
}

const timeOf = event => {
  const value = Number(event?.payload?.item?.completed_at_ms ?? event?.payload?.completed_at_ms ?? Date.parse(event?.timestamp ?? ''))
  return Number.isFinite(value) ? value : 0
}

const compactInput = value => {
  if (typeof value !== 'string') return textOf(value)
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object') return parsed.command || parsed.file_path || parsed.query || parsed.pattern || value
  } catch {}
  return value
}

const categoryOf = (name, type = '', args = '') => {
  const typed = String(type).toLowerCase()
  if (/write|edit/.test(typed)) return 'Write'
  if (/search|find|grep|glob/.test(typed)) return 'Search'
  if (/read|list/.test(typed)) return 'Read'
  const named = String(name || '').toLowerCase()
  if (/^(apply_patch|write|edit)$/.test(named)) return 'Write'
  if (/^(search|find|grep|glob)$/.test(named)) return 'Search'
  if (/^(read|list|view)$/.test(named)) return 'Read'
  if (/^(bash|shell|exec|exec_command|deferexecutetool)$/.test(named)) return 'Shell'
  const value = `${name || ''} ${args || ''}`.toLowerCase()
  if (/browser|web__|web_search/.test(value)) return 'Web'
  if (/apply_patch|write|edit|filechange/.test(value)) return 'Write'
  if (/(?:^|[;&|\s])(rg|grep|find|fd)(?:\s|$)|search|glob/.test(value)) return 'Search'
  if (/(?:^|[;&|\s])(cat|sed|head|tail|less|pwd|ls)(?:\s|$)|read|view|list_files/.test(value)) return 'Read'
  if (/command|exec|bash|shell|terminal/.test(value)) return 'Shell'
  if (/subagent|thread_spawn|collaboration|agent/.test(value)) return 'Agent'
  return 'Other'
}

export const commandName = args => {
  const source = String(args || '').replace(/\/(?:zsh|bash)-lc(?=\S)/g, match => match + ' ')
  const known = source.match(/\b(apply_patch|rg|grep|find|fd|cat|sed|head|tail|pwd|ls|git|npm|pnpm|node|python3?|curl|open|kill)\b/i)
  return known?.[1] || source.trim().split(/\s+/)[0]?.replace(/^.*\//, '') || ''
}

const normal = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()

function rawCalls(events) {
  const calls = new Map()
  for (const event of events) {
    const p = event.payload || {}
    if (event.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const id = p.call_id || p.id
      if (id) calls.set(id, { args: compactInput(p.input ?? p.arguments), result: '' })
    }
    if (event.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const id = p.call_id
      if (id) calls.set(id, { ...(calls.get(id) || {}), result: textOf(p.output) })
    }
    if (event.type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item || {}
      const id = item.call_id || item.id || p.item_id
      if (!id) continue
      const args = item.arguments ?? item.input ?? item.command ?? (Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(x => x.cmd || x.path || x.pattern).join('\n') : '')
      const result = item.formatted_output ?? item.aggregated_output ?? item.stdout ?? item.result ?? ''
      calls.set(id, { args: compactInput(args), result: textOf(result) })
    }
  }
  return calls
}

function modelCalls(events, anchor) {
  const calls = []
  for (const event of events) {
    const p = event.payload || {}
    if (event.type === 'event_msg' && p.type === 'token_count') {
      const usage = p.info?.last_token_usage
      if (!usage || !Number.isFinite(usage.input_tokens)) continue
      const window = p.info?.model_context_window
      const input = Number(usage.input_tokens) || 0
      const cachedInput = Number(usage.cached_input_tokens) || 0
      const cacheWriteInput = Number(usage.cache_write_input_tokens) || 0
      const output = Number(usage.output_tokens) || 0
      const reasoningOutput = Number(usage.reasoning_output_tokens) || 0
      calls.push({
        index: calls.length + 1,
        atMs: Math.max(0, timeOf(event) - anchor),
        input,
        cachedInput,
        cacheWriteInput,
        uncachedInput: Math.max(0, input - cachedInput - cacheWriteInput),
        reasoningOutput,
        visibleOutput: Math.max(0, output - reasoningOutput),
        total: Number(usage.total_tokens) || input + output,
        contextRatio: window ? input / window : null,
        compacted: false,
      })
    }
    if ((event.type === 'event_msg' && /^(context_compacted|compaction)$/.test(p.type)) || event.type === 'compacted') {
      if (calls.length) calls.at(-1).compacted = true
    }
  }
  return calls
}

function markRecovery(tools) {
  let cluster = 0
  for (let index = 0; index < tools.length; index++) {
    const failed = tools[index]
    if (failed.status !== 'failed') continue
    const until = failed.endMs + RETRY_WINDOW_MS
    const recovered = tools.slice(index + 1).find(tool => tool.startMs <= until && tool.status === 'success')
    if (!recovered) continue
    cluster += 1
    const changed = failed.name !== recovered.name || normal(failed.args) !== normal(recovered.args)
    const recovery = changed ? 'strategy_changed' : 'same_retry'
    failed.retryClusterId = cluster
    failed.recovery = recovery
    recovered.retryClusterId = cluster
    recovered.recovery = 'recovered'
  }
}

function buildFindings({ tools, modelCalls, durationMs }) {
  const failed = tools.filter(tool => tool.status === 'failed')
  const recovered = tools.filter(tool => tool.recovery === 'recovered')
  const longest = tools.reduce((winner, tool) => !winner || tool.durationMs > winner.durationMs ? tool : winner, null)
  const contextCalls = modelCalls.filter(call => call.contextRatio != null)
  const peak = Math.max(0, ...contextCalls.map(call => call.contextRatio))
  const maxInput = Math.max(0, ...modelCalls.map(call => call.input || 0))
  const mostFailed = Object.entries(failed.reduce((all, tool) => ({ ...all, [tool.label || tool.name]: (all[tool.label || tool.name] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  const duration = Math.max(1, durationMs)
  const toolTime = tools.reduce((total, tool) => total + tool.durationMs, 0)
  const top = Object.entries(tools.reduce((all, tool) => ({ ...all, [tool.category]: (all[tool.category] || 0) + tool.durationMs }), {})).sort((a, b) => b[1] - a[1])[0]
  return [
    failed.length
      ? { kind: 'failure', title: '工具失败与重试', detail: `${failed.length} 次失败；失败最多：${mostFailed[0]}（${mostFailed[1]} 次）；${recovered.length} 次在 120 秒内恢复。` }
      : { kind: 'failure', title: '执行稳定', detail: '未检测到工具失败或重试链。' },
    longest
      ? { kind: 'time', title: '时间消耗分布', detail: `最长调用为 ${longest.label || longest.name}，耗时 ${(longest.durationMs / 1000).toFixed(1)} 秒；工具累计占会话 ${(toolTime / duration * 100).toFixed(0)}%。` }
      : { kind: 'time', title: '时间消耗分布', detail: '当前会话尚未产生已完成的工具调用。' },
    { kind: 'context', title: '上下文压力', detail: modelCalls.length ? `最大输入 Token ${maxInput.toLocaleString()}；${contextCalls.length ? `峰值上下文占用 ${(peak * 100).toFixed(1)}%，${peak >= .9 ? '已越过 90% 阈值。' : peak >= .7 ? '接近压缩阈值。' : '仍在安全区。'}` : '客户端未记录上下文窗口大小。'}` : '日志未提供逐次 Token 使用。' },
    { kind: 'recommendation', title: '建议行动', detail: failed.length ? `优先审查 ${top?.[0] || '失败'} 调用的失败链，并将策略变化固化为重试前置检查。` : '保留当前工具节奏作为稳定执行基线。' },
  ]
}

export function buildTrajectoryV2(events, sessionMeta, agents = []) {
  const ordered = [...events].sort((a, b) => timeOf(a) - timeOf(b))
  const legacy = buildMaze(ordered, sessionMeta)
  const lane = legacy.data.lanes[0]
  const anchorEvent = ordered.find(event => (event.type === 'event_msg' && event.payload?.type === 'user_message') || event.payload?.item?.type === 'UserMessage') || ordered[0]
  const anchor = timeOf(anchorEvent) || Date.now()
  const raw = rawCalls(ordered)
  let lastMain = null
  const steps = (lane?.rows || []).map((row, index) => {
    const branchFromStepId = row.v === 'ok' || row.v === 'answer' ? null : lastMain
    if (row.v === 'ok' || row.v === 'answer') lastMain = row.step
    return {
      id: `s${row.step}`,
      index: index + 1,
      turn: row.turn,
      startMs: Math.round(row.s * 1000),
      endMs: Math.round(row.e * 1000),
      durationMs: Math.max(0, Math.round((row.e - row.s) * 1000)),
      label: row.labelFull || row.rzTxtFull || row.tools?.[0]?.name || `步骤 ${row.step}`,
      reasoningCount: row.rz || 0,
      verdict: row.v,
      branchFromStepId: branchFromStepId ? `s${branchFromStepId}` : null,
    }
  })
  const tools = (lane?.rows || []).flatMap(row => row.tools.map((tool, index) => {
    const rawTool = raw.get(tool.callId) || {}
    const args = rawTool.args || tool.args || ''
    const result = rawTool.result || tool.resFull || tool.res || ''
    return {
      id: tool.callId || `${row.step}:${index}:${tool.name}`,
      stepId: `s${row.step}`,
      name: tool.name || '?',
      label: tool.name === 'exec_command' ? commandName(args) : tool.name,
      category: categoryOf(tool.name, tool.type, args),
      startMs: Math.round((tool.s ?? row.s) * 1000),
      endMs: Math.round((tool.e ?? row.e) * 1000),
      durationMs: Math.max(0, Math.round((tool.dur ?? Math.max(0, (tool.e ?? row.e) - (tool.s ?? row.s))) * 1000)),
      status: tool.err || tool.v === 'error' ? 'failed' : 'success',
      retryClusterId: null,
      recovery: null,
      args,
      result,
    }
  })).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  markRecovery(tools)
  const calls = modelCalls(ordered, anchor)
  const contextCalls = calls.filter(call => call.contextRatio != null)
  const metrics = lane?.metrics || null
  const durationMs = Math.max(0, ...steps.map(step => step.endMs), ...tools.map(tool => tool.endMs))
  return {
    version: 2,
    session: {
      id: metrics?.identity?.sessionId || sessionMeta?.id || sessionMeta?.session_id || null,
      status: legacy.status,
      model: metrics?.identity?.model || lane?.model || null,
      effort: metrics?.identity?.effort || null,
      startedAt: new Date(anchor).toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs,
    },
    steps,
    tools,
    modelCalls: calls,
    agents,
    findings: buildFindings({ tools, modelCalls: calls, durationMs }),
    metrics: {
      turns: Math.max(0, ...steps.map(step => step.turn)),
      modelCalls: calls.length,
      totalTokens: metrics?.tokens?.total ?? null,
      contextPeakRatio: contextCalls.length ? Math.max(...contextCalls.map(call => call.contextRatio)) : metrics?.context?.peakRatio ?? null,
      toolFailures: tools.filter(tool => tool.status === 'failed').length,
      toolCalls: tools.length,
    },
  }
}

export const escapeReportJson = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' }[character]))
