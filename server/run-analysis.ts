// @ts-expect-error ponytail: retained Legacy V2 adapter is intentionally untyped during migration.
import { buildTrajectoryV2 } from './legacy/v2-data.mjs'
import type { BehavioralSignal, EvalEvidence, ObservableMetrics, OutcomeEvidence, RunAnalysis, RunOutcome, PromptFootprintItem, RunRef, SessionDescriptor, SessionStatus, TurnDescriptor } from './types.js'

type Event = { timestamp?: string; type?: string; payload?: Record<string, any> }
const RETRY_WINDOW_MS = 120_000
const categories: PromptFootprintItem['category'][] = ['system', 'developer', 'skills', 'tools', 'permissions', 'environment', 'apps', 'userHistory']

const timeOf = (event: Event) => {
  const p = event.payload || {}
  const value = Number(p.item?.completed_at_ms ?? p.completed_at_ms ?? p.item?.started_at_ms ?? p.started_at_ms ?? Date.parse(event.timestamp || ''))
  return Number.isFinite(value) ? value : 0
}
const textOf = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') return typeof (value as { text?: unknown }).text === 'string' ? String((value as { text: string }).text) : Object.values(value as Record<string, unknown>).map(textOf).join('')
  return String(value)
}
const normal = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
const commandOf = (value: unknown) => {
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (typeof value !== 'string') return textOf(value)
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return textOf((parsed as Record<string, unknown>).cmd ?? (parsed as Record<string, unknown>).command ?? value) } catch { /* command is already plain text */ }
  return value
}
const targetOf = (args: string) => {
  try { const parsed = JSON.parse(args); if (parsed && typeof parsed === 'object') { const value = (parsed as Record<string, unknown>).file_path || (parsed as Record<string, unknown>).path || (parsed as Record<string, unknown>).query || (parsed as Record<string, unknown>).pattern; if (typeof value === 'string') return normal(value) } } catch { /* command-style arguments */ }
  return normal(args).match(/(?:\.?\/?[\w@][\w./-]*\.[\w-]+)(?:[:\d-]+)?/)?.[0] || normal(args)
}
const eventType = (event: Event) => String(event.payload?.type || '')
const isTerminal = (event: Event) => /^(task_complete|turn_aborted)$/.test(eventType(event))
const outputText = (event: Event) => {
  const p = event.payload || {}
  return event.type === 'response_item' && p.type === 'message' ? textOf(p.content) : eventType(event) === 'agent_message' ? textOf(p.message) : ''
}
const userText = (event: Event) => eventType(event) === 'user_message' ? textOf(event.payload?.message) : event.payload?.item?.type === 'UserMessage' ? textOf(event.payload?.item?.content) : ''
const goalText = (event: Event) => {
  const value = userText(event); const marker = '## My request:'; const goal = value.includes(marker) ? value.slice(value.indexOf(marker) + marker.length) : value
  return goal.replace(/\s+local_image\S.*$/s, '').trim()
}
const validationKinds = (command: string): EvalEvidence['validations'][number]['kind'][] => {
  const value = normal(command)
  const kinds: EvalEvidence['validations'][number]['kind'][] = []
  if (/(?:^|\s)(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|cargo\s+test\b|swift\s+test\b|go\s+test\b|pytest\b|vitest\b|jest\b|(?:node|tsx)\s+--test\b|xcodebuild\b.*\btest\b)/.test(value)) kinds.push('test')
  if (/(?:^|\s)(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|cargo\s+build\b|swift\s+build\b|go\s+build\b|vite\s+build\b|tsc\s+-b\b)/.test(value)) kinds.push('build')
  if (/(?:^|\s)(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b|oxlint\b|eslint\b|swiftlint\b|cargo\s+clippy\b|ruff\s+check\b)/.test(value)) kinds.push('lint')
  return kinds
}
const validationKey = (kind: string, command: string) => `${kind}:${normal(command).replace(/^(?:\/\S+\/)?(?:zsh|bash)\s+-lc\s+/, '')}`

function statusOf(events: Event[]): SessionStatus {
  const last = [...events].reverse().find(event => eventType(event) === 'task_started' || isTerminal(event))
  if (!last) return 'unknown'
  return eventType(last) === 'task_complete' ? 'complete' : eventType(last) === 'turn_aborted' ? 'aborted' : 'live'
}

type Segment = { turnId: string; start: number; end: number; finishedAt: number | null; status: SessionStatus; events: Event[]; goal: string | null; model: string | null; effort: string | null }

export function segmentRuns(events: Event[]): Segment[] {
  const ordered = [...events].sort((a, b) => timeOf(a) - timeOf(b))
  const starts = ordered.map((event, index) => ({ event, index })).filter(({ event }) => eventType(event) === 'task_started')
  if (!starts.length) return []
  return starts.map(({ event, index }, sequence) => {
    const start = timeOf(event)
    const next = starts[sequence + 1] ? timeOf(starts[sequence + 1].event) : Number.POSITIVE_INFINITY
    const turnId = String(event.payload?.turn_id || `turn-${sequence + 1}`)
    const within = ordered.filter(candidate => timeOf(candidate) >= start && timeOf(candidate) < next)
    const terminal = within.find(candidate => isTerminal(candidate) && (!candidate.payload?.turn_id || candidate.payload.turn_id === turnId))
    const context = [...ordered.slice(0, index + 1), ...within].filter(candidate => candidate.type === 'turn_context').at(-1)?.payload || {}
    const goal = [...ordered.slice(0, index + 1)].reverse().map(goalText).find(Boolean) || within.map(goalText).find(Boolean) || null
    const end = terminal ? timeOf(terminal) : Math.max(start, ...within.map(timeOf))
    return { turnId, start, end, finishedAt: terminal ? end : null, status: terminal ? (eventType(terminal) === 'turn_aborted' ? 'aborted' : 'complete') : 'live', events: within, goal, model: context.model || null, effort: context.effort || null }
  })
}

export function turnsFor(events: Event[], source: RunRef['source'], sessionId: string): TurnDescriptor[] {
  return segmentRuns(events).map(segment => ({
    ref: { source, sessionId, turnId: segment.turnId }, title: segment.goal, model: segment.model, effort: segment.effort,
    status: segment.status, startedAt: new Date(segment.start).toISOString(), endedAt: segment.finishedAt ? new Date(segment.finishedAt).toISOString() : null, durationMs: Math.max(0, segment.end - segment.start),
  }))
}

function footprint(events: Event[]): PromptFootprintItem[] {
  const counts = new Map(categories.map(category => [category, { characters: 0, utf8Bytes: 0, known: false }]))
  const add = (category: PromptFootprintItem['category'], text: string) => {
    if (!text) return
    const item = counts.get(category)!
    item.characters += [...text].length; item.utf8Bytes += Buffer.byteLength(text); item.known = true
  }
  const hasResponseToolOutput = events.some(event => event.type === 'response_item' && /^(?:function_call_output|custom_tool_call_output)$/.test(String(event.payload?.type)))
  for (const event of events) {
    const p = event.payload || {}; const kind = eventType(event)
    if (kind === 'user_message') add('userHistory', textOf(p.message))
    else if (event.type === 'response_item' && /^(?:function_call_output|custom_tool_call_output)$/.test(String(p.type))) add('tools', textOf(p.output))
    else if (event.type === 'response_item' && p.type === 'message') add('userHistory', textOf(p.content))
    else if (!hasResponseToolOutput && kind === 'item_completed' && /(?:CommandExecution|DynamicToolCall)/.test(String(p.item?.type))) add('tools', textOf(p.item?.formatted_output ?? p.item?.aggregated_output ?? p.item?.result))
    else if (event.type === 'turn_context') {
      add('environment', JSON.stringify({ cwd: p.cwd, sandbox: p.sandbox_mode, model: p.model, effort: p.effort, collaboration: p.collaboration_mode }))
      add('permissions', JSON.stringify({ approval: p.approval_policy, reviewer: p.approvals_reviewer, policy: p.permission_profile }))
    } else if (event.type === 'session_meta') {
      add('developer', textOf(p.base_instructions?.text ?? p.base_instructions))
      add('environment', JSON.stringify({ cwd: p.cwd, cli_version: p.cli_version, context_window: p.context_window })); add('apps', textOf(p.apps || p.plugins))
    } else if (event.type === 'world_state') {
      const state = p.state || p
      add('skills', textOf(state.host_skills?.body))
      add('permissions', JSON.stringify(state.permissions || ''))
      add('environment', JSON.stringify(state.environments || ''))
      if (typeof state.apps_instructions === 'string') add('apps', state.apps_instructions)
    }
  }
  return categories.map(category => {
    const item = counts.get(category)!
    return { category, ...item, estimatedTokens: item.utf8Bytes ? Math.ceil(item.utf8Bytes / 4) : 0 }
  })
}

function harnessActivity(events: Event[], tools: ObservableMetrics['tools'], modelCalls: number): ObservableMetrics['harnessActivity'] {
  const unique = (types: string[]) => new Set(events.filter(event => types.includes(eventType(event)) || types.includes(String(event.payload?.type))).map(event => String(event.payload?.call_id || event.payload?.id || `${event.timestamp}:${eventType(event)}`))).size
  const mcpEvents = events.filter(event => eventType(event) === 'mcp_tool_call_end')
  const mcpServers = [...new Set(mcpEvents.map(event => String(event.payload?.invocation?.server || '')).filter(Boolean))]
  const skills = new Set<string>()
  for (const tool of tools) for (const match of tool.args.matchAll(/(?:^|[/\s"'])skills\/([^/\s"']+)\/SKILL\.md/gi)) skills.add(match[1])
  return {
    modelCalls,
    reasoningItems: events.filter(event => event.type === 'response_item' && event.payload?.type === 'reasoning').length,
    assistantMessages: events.filter(event => event.type === 'response_item' && event.payload?.type === 'message').length,
    toolDiscoveries: unique(['tool_search_call']),
    webSearches: unique(['web_search_call', 'web_search_end']),
    mcpCalls: Math.max(mcpEvents.length, tools.filter(tool => tool.transport === 'mcp').length),
    mcpServers,
    skillsUsed: [...skills],
  }
}

function trajectory(tools: ObservableMetrics['tools']) {
  const failures = tools.filter(tool => tool.status === 'failed')
  const waste = new Set<string>(); let repeated = 0; let mechanical = 0; let adaptive = 0
  const signature = (tool: ObservableMetrics['tools'][number]) => `${normal(tool.name)}:${normal(tool.args).slice(0, 500)}`
  const action = tools.map(signature)
  tools.forEach((tool, index) => {
    const prior = tools.slice(Math.max(0, index - 5), index)
    if (prior.some(previous => signature(previous) === signature(tool))) { tool.flags.push('repeated'); waste.add(tool.id); repeated++ }
    const failed = prior.reverse().find(previous => previous.status === 'failed' && tool.startMs - previous.endMs <= RETRY_WINDOW_MS)
    if (!failed) return
    const same = normal(failed.name) === normal(tool.name) && normal(failed.args) === normal(tool.args)
    const sameTarget = targetOf(failed.args) === targetOf(tool.args)
    if (same) { tool.flags.push('mechanical-retry'); waste.add(tool.id); mechanical++ }
    if (!same && sameTarget && tool.status === 'success') { failed.recovery = 'strategy_changed'; tool.recovery = 'recovered'; tool.flags.push('adaptive-recovery'); adaptive++ }
  })
  let loops = 0
  for (let width = 1; width <= 3; width++) for (let at = 0; at + width * 3 <= action.length; at++) {
    const pattern = action.slice(at, at + width).join('|')
    if ([1, 2].every(repeat => action.slice(at + repeat * width, at + (repeat + 1) * width).join('|') === pattern)) {
      loops++; tools.slice(at, at + width * 3).forEach(tool => { tool.flags.push('loop'); waste.add(tool.id) }); at += width * 3 - 1
    }
  }
  return { repeatedActions: repeated, mechanicalRetries: mechanical, adaptiveRecoveries: adaptive, loops, wasteActionIds: [...waste], coverage: tools.length ? 1 : 0, failures: failures.length }
}

function evidenceOf(events: Event[], goal: string | null): EvalEvidence {
  const finalOutput = [...events].reverse().filter(event => event.type === 'response_item' && event.payload?.type === 'message').map(outputText).find(Boolean) || [...events].reverse().map(outputText).find(Boolean) || null
  const validations: EvalEvidence['validations'] = []
  const artifacts: EvalEvidence['artifacts'] = []
  const calls = new Map<string, string>()
  const modernCommands = events.some(event => eventType(event) === 'item_completed' && event.payload?.item?.type === 'CommandExecution')
  for (const event of events) {
    const p = event.payload || {}; const item = p.item || {}; const command = commandOf(item.command || item.parsed_cmd || p.input || '')
    if (!modernCommands && event.type === 'response_item' && /(?:function|custom)_tool_call$/.test(String(p.type)) && p.call_id && command) calls.set(String(p.call_id), command)
    if (!modernCommands && event.type === 'response_item' && /(?:function|custom)_tool_call_output$/.test(String(p.type))) {
      const paired = calls.get(String(p.call_id || ''))
      const kinds = paired ? validationKinds(paired) : []
      if (paired && kinds.length) {
        const exitCode = p.exit_code ?? p.exitCode
        const passed = exitCode == null ? null : Number(exitCode) === 0 ? true : kinds.length === 1 ? false : null
        kinds.forEach(kind => validations.push({ kind, label: paired.slice(0, 160), passed, detail: textOf(p.output).slice(0, 500) }))
      }
    }
    if (/apply_patch/i.test(command) || /^(?:write|edit)$/i.test(String(p.name || item.type || ''))) artifacts.push({ label: /apply_patch/i.test(command) ? 'apply_patch' : String(p.name || item.type), kind: 'file-change' })
    if (!(eventType(event) === 'item_completed' && item.type === 'CommandExecution')) continue
    const kinds = validationKinds(command)
    if (!kinds.length) continue
    const passed = item.exit_code == null ? null : Number(item.exit_code) === 0
    kinds.forEach(kind => validations.push({ kind, label: command.slice(0, 160), passed: passed === false && kinds.length > 1 ? null : passed, detail: textOf(item.formatted_output || item.aggregated_output || '').slice(0, 500) }))
  }
  return { goal, finalOutput, validations, artifacts: [...new Map(artifacts.map(artifact => [artifact.label, artifact])).values()] }
}

function outcomeOf(events: Event[], evidence: EvalEvidence): RunOutcome {
  const observed: OutcomeEvidence[] = []
  if (events.some(event => eventType(event) === 'task_complete')) observed.push({ type: 'task_complete', status: 'completed', label: 'Task completed' })
  const latest = new Map<string, EvalEvidence['validations'][number]>()
  evidence.validations.forEach(validation => latest.set(validationKey(validation.kind, validation.label), validation))
  for (const validation of latest.values()) observed.push({ type: validation.kind, status: validation.passed === true ? 'passed' : validation.passed === false ? 'failed' : 'unknown', label: validation.label, value: validation.detail || undefined })
  for (const artifact of evidence.artifacts) observed.push({ type: 'artifact', status: 'completed', label: artifact.label })
  const validations = observed.filter(item => item.type === 'test' || item.type === 'build' || item.type === 'lint')
  const completed = observed.some(item => item.type === 'task_complete')
  const hasFailure = validations.some(item => item.status === 'failed')
  const status = completed && hasFailure ? 'partial' : hasFailure ? 'failed' : validations.some(item => item.status === 'passed') ? 'success' : 'unknown'
  return { status, source: 'observed', evidence: observed }
}

function signalsOf(observable: ObservableMetrics): BehavioralSignal[] {
  const signals: BehavioralSignal[] = []
  const add = (type: BehavioralSignal['type'], severity: BehavioralSignal['severity'], message: string, tools: ObservableMetrics['tools'] = [], metrics?: Record<string, number>) => signals.push({ id: `${type}-${signals.length + 1}`, type, severity, startStep: tools.length ? observable.tools.indexOf(tools[0]) + 1 : undefined, endStep: tools.length ? observable.tools.indexOf(tools.at(-1)!) + 1 : undefined, evidence: { callIds: tools.map(tool => tool.id), toolNames: [...new Set(tools.map(tool => tool.name))], message }, metrics })
  const repeated = observable.tools.filter(tool => tool.flags.includes('repeated'))
  if (repeated.length) add(repeated.some(tool => tool.category === 'Read' || /read|cat|sed|head|tail/i.test(`${tool.name} ${tool.args}`)) ? 'repeated_read' : 'repeated_tool_call', repeated.length >= 3 ? 'medium' : 'low', `${repeated.length} repeated tool call${repeated.length === 1 ? '' : 's'} observed.`, repeated, { count: repeated.length })
  const mechanical = observable.tools.filter(tool => tool.flags.includes('mechanical-retry'))
  if (mechanical.length) add('mechanical_retry', mechanical.length >= 3 ? 'high' : 'medium', `${mechanical.length} same-call retr${mechanical.length === 1 ? 'y' : 'ies'} after failure.`, mechanical, { count: mechanical.length })
  const recovered = observable.tools.filter(tool => tool.flags.includes('adaptive-recovery'))
  if (recovered.length) add('adaptive_recovery', 'info', `${recovered.length} changed-strategy recover${recovered.length === 1 ? 'y' : 'ies'} observed.`, recovered, { count: recovered.length })
  const looped = observable.tools.filter(tool => tool.flags.includes('loop'))
  if (looped.length) add('loop', looped.length >= 6 ? 'high' : 'medium', `${looped.length} steps participate in a repeated sequence.`, looped, { count: looped.length })
  const writes = observable.tools.filter(tool => tool.category === 'Write')
  const revisits = observable.tools.filter(tool => tool.category === 'Read' && writes.some(write => write.startMs < tool.startMs && targetOf(write.args) === targetOf(tool.args)))
  if (revisits.length) add('backtrack', 'low', `${revisits.length} prior target revisit${revisits.length === 1 ? '' : 's'} after a write observed.`, revisits, { count: revisits.length })
  if (observable.toolSummary.concentration != null && observable.tools.length >= 6 && observable.toolSummary.concentration >= 0.7) add('tool_concentration', 'low', 'Most tool calls are concentrated in one tool family.', [], { concentration: observable.toolSummary.concentration })
  if (repeated.length >= 2) add('redundant_step', 'low', `${repeated.length} steps duplicate a recent action.`, repeated, { count: repeated.length })
  const failures = observable.tools.filter(tool => tool.status === 'failed')
  if (failures.length) add('tool_failure', failures.length >= 3 ? 'high' : 'medium', `${failures.length} tool failure${failures.length === 1 ? '' : 's'} observed.`, failures, { count: failures.length })
  const slow = observable.tools.filter(tool => tool.durationMs >= Math.max(10_000, observable.toolSummary.cumulativeMs / Math.max(1, observable.tools.length) * 3))
  if (slow.length) add('slow_tool', 'low', `${slow.length} unusually long tool call${slow.length === 1 ? '' : 's'} observed.`, slow, { count: slow.length })
  const points = observable.context.points
  if (points.some((point, index) => index && point.ratio - points[index - 1].ratio >= 0.2)) add('context_spike', 'medium', 'Context pressure rose by at least 20 percentage points between observations.')
  if (points.some((point, index) => index && points[index - 1].ratio - point.ratio >= 0.2)) add('context_reset', 'info', 'Context pressure dropped by at least 20 percentage points between observations.')
  if (observable.context.compactions) add('compaction', 'info', `${observable.context.compactions} context compaction event${observable.context.compactions === 1 ? '' : 's'} observed.`, [], { count: observable.context.compactions })
  return signals
}

function wallTime(tools: ObservableMetrics['tools']) {
  const intervals = tools.filter(tool => tool.endMs > tool.startMs).map(tool => [tool.startMs, tool.endMs] as const).sort((a, b) => a[0] - b[0])
  let end = -Infinity; let total = 0
  for (const [start, finish] of intervals) if (finish > end) { total += finish - Math.max(start, end); end = finish }
  return total
}

function fallbackTools(events: Event[], start: number): ObservableMetrics['tools'] {
  const calls = new Map<string, ObservableMetrics['tools'][number]>()
  for (const event of events) {
    const p = event.payload || {}; const at = Math.max(0, timeOf(event) - start)
    if (event.type === 'response_item' && /(?:function|custom)_tool_call$/.test(String(p.type))) {
      const args = textOf(p.input ?? p.arguments); const name = String(p.name || 'tool'); const command = targetOf(args)
      calls.set(String(p.call_id || p.id || calls.size), { id: String(p.call_id || p.id || calls.size), name, label: name === 'exec' ? command.split(/\s+/)[0] || name : name, category: /\b(cat|sed|head|tail|ls)\b/i.test(command) ? 'Read' : /\b(rg|grep|find)\b/i.test(command) ? 'Search' : 'Other', startMs: at, endMs: at, durationMs: 0, status: 'success', args, result: '', flags: [], recovery: null })
    }
    if (event.type === 'response_item' && /(?:function|custom)_tool_call_output$/.test(String(p.type))) {
      const tool = calls.get(String(p.call_id || '')); if (!tool) continue
      tool.endMs = at; tool.durationMs = Math.max(0, at - tool.startMs); tool.result = textOf(p.output); tool.status = /^error\b/i.test(tool.result) || Number(p.exit_code) > 0 ? 'failed' : 'success'
    }
  }
  return [...calls.values()]
}

export function analyzeRun(events: Event[], descriptor: SessionDescriptor, ref: RunRef, malformedLines = 0): RunAnalysis {
  const segment = segmentRuns(events).find(item => item.turnId === ref.turnId)
  if (!segment) throw new Error('未找到 Turn')
  const sessionMetaEvent = events.find(event => event.type === 'session_meta')
  const sessionMeta = sessionMetaEvent?.payload || {}
  const staticEvents = events.filter(event => (event.type === 'session_meta' || event.type === 'world_state') && timeOf(event) <= segment.start)
  const v2 = buildTrajectoryV2([sessionMetaEvent, ...segment.events].filter(Boolean), sessionMeta, []) as Record<string, any>
  const baseTools = ((v2.tools || []).map((tool: any) => ({ ...tool, status: tool.status === 'failed' || /^error\b/i.test(textOf(tool.result)) ? 'failed' : 'success', flags: [] as string[], recovery: tool.recovery || null })) as ObservableMetrics['tools'])
  if (!baseTools.length) baseTools.push(...fallbackTools(segment.events, segment.start))
  const mcp = new Map(segment.events.filter(event => eventType(event) === 'mcp_tool_call_end').map(event => [String(event.payload?.call_id || ''), event.payload?.invocation || {}]))
  baseTools.forEach(tool => {
    const invocation = mcp.get(tool.id)
    if (invocation) { tool.transport = 'mcp'; tool.server = String(invocation.server || '') || undefined }
    else tool.transport = /^mcp__/.test(tool.name) ? 'mcp' : /web|browser/i.test(`${tool.name} ${tool.category}`) ? 'web' : tool.category === 'Shell' ? 'shell' : tool.category === 'Agent' ? 'agent' : 'native'
  })
  const result = trajectory(baseTools)
  const calls = (v2.modelCalls || []) as Array<{ atMs: number; input: number; cachedInput: number; uncachedInput: number; visibleOutput: number; reasoningOutput: number; total: number; contextRatio: number | null; compacted: boolean }>
  const contextCalls = calls.filter(call => call.contextRatio != null)
  const sum = (key: keyof typeof calls[number]) => calls.reduce((total, call) => total + (typeof call[key] === 'number' ? Number(call[key]) : 0), 0)
  const tokenKnown = calls.length > 0
  const complete = segment.status !== 'live'
  const durationMs = Math.max(0, segment.end - segment.start)
  const tools = baseTools.map(tool => ({ ...tool, startMs: Math.max(0, tool.startMs), endMs: Math.max(0, tool.endMs) }))
  const summary = { total: tools.length, succeeded: tools.filter(tool => tool.status === 'success').length, failed: tools.filter(tool => tool.status === 'failed').length, retryCount: result.mechanicalRetries, parallelRate: tools.length ? tools.filter((tool, index) => tools.some((other, otherIndex) => otherIndex !== index && other.startMs < tool.endMs && other.endMs > tool.startMs)).length / tools.length : null, concentration: tools.length ? Object.values(tools.reduce<Record<string, number>>((all, tool) => ({ ...all, [tool.name]: (all[tool.name] || 0) + 1 }), {})).reduce((total, count) => total + (count / tools.length) ** 2, 0) : null, wallMs: wallTime(tools), cumulativeMs: tools.reduce((total, tool) => total + tool.durationMs, 0) }
  const promptFootprint = footprint([...staticEvents, ...segment.events])
  const ttft = segment.events.find(event => isTerminal(event))?.payload?.time_to_first_token_ms
  const observable: ObservableMetrics = {
    durationMs, ttftMs: Number.isFinite(ttft) ? Number(ttft) : null,
    tokens: { input: tokenKnown ? sum('input') : null, cachedInput: tokenKnown ? sum('cachedInput') : null, uncachedInput: tokenKnown ? sum('uncachedInput') : null, output: tokenKnown ? sum('visibleOutput') + sum('reasoningOutput') : null, reasoning: tokenKnown ? sum('reasoningOutput') : null, total: tokenKnown ? sum('total') : null },
    context: { peakRatio: contextCalls.length ? Math.max(...contextCalls.map(call => Number(call.contextRatio))) : null, compactions: calls.filter(call => call.compacted).length, points: contextCalls.map(call => ({ atMs: call.atMs, ratio: Number(call.contextRatio), compacted: call.compacted })) },
    tools, toolSummary: summary, agents: { ids: [...new Set(segment.events.filter(event => eventType(event) === 'sub_agent_activity').map(event => String(event.payload?.agent_thread_id || '')).filter(Boolean))], observed: 0 }, trajectory: result, promptFootprint, harnessActivity: harnessActivity(segment.events, tools, calls.length),
  }
  observable.agents.observed = observable.agents.ids.length
  v2.session = { ...(v2.session || {}), id: descriptor.id, status: segment.status, model: segment.model || descriptor.model, effort: segment.effort || null, startedAt: new Date(segment.start).toISOString(), updatedAt: new Date(segment.end).toISOString(), durationMs }
  v2.tools = tools; v2.metrics = { ...(v2.metrics || {}), totalTokens: observable.tokens.total, contextPeakRatio: observable.context.peakRatio, toolCalls: summary.total, toolFailures: summary.failed }
  const harnessFamily = sessionMeta.source_format === 'deepseek-harness' ? 'deepseek-harness' : ref.source === 'workbuddy' ? 'workbuddy' : ref.source === 'claude' ? 'claude' : ref.source === 'codex' ? 'codex' : 'other'
  const provider = sessionMeta.model_provider || sessionMeta.provider || (ref.source === 'codex' ? 'openai' : null)
  const evidence = evidenceOf(segment.events, segment.goal)
  return {
    schemaVersion: 1, ref,
    identity: { title: segment.goal, model: segment.model || descriptor.model, effort: segment.effort || descriptor.effort || null, projectPath: descriptor.projectPath, cliVersion: sessionMeta.cli_version || null, startedAt: new Date(segment.start).toISOString(), endedAt: complete ? new Date(segment.end).toISOString() : null, status: segment.status, harness: { family: harnessFamily, version: sessionMeta.cli_version || null, source: ref.source }, modelIdentity: { provider, model: segment.model || descriptor.model, reasoningEffort: segment.effort || descriptor.effort || null }, environment: { os: process.platform === 'darwin' ? 'macOS' : process.platform || null, cwd: String(segment.events.find(event => event.type === 'turn_context')?.payload?.cwd || sessionMeta.cwd || descriptor.projectPath || '') || null, sandbox: String(segment.events.find(event => event.type === 'turn_context')?.payload?.sandbox_mode || '') || null, source: ref.source } },
    observable, evidence, outcome: outcomeOf(segment.events, evidence), behavioralSignals: signalsOf(observable), coverage: { malformedLines, tokenUsageKnown: tokenKnown, promptFootprintKnown: promptFootprint.some(item => item.known), toolPairingRatio: tools.length ? tools.filter(tool => tool.durationMs > 0 || tool.result).length / tools.length : 1, notes: complete ? [] : ['当前 Turn 仍在运行，指标会随日志追加更新。'] }, v2,
  }
}

export function currentSessionStatus(events: Event[]): SessionStatus { return statusOf(events) }
export function runKey(ref: RunRef) { return `${ref.source}:${ref.sessionId}:${ref.turnId}` }
export function suggestedTaskSimilarity(a: string | null, b: string | null) {
  const grams = (value: string) => new Set([...normal(value)].flatMap((_, index, all) => index + 3 <= all.length ? [all.slice(index, index + 3).join('')] : []))
  const left = grams(a || ''), right = grams(b || ''); const union = new Set([...left, ...right]).size
  return union ? [...left].filter(value => right.has(value)).length / union : 0
}
