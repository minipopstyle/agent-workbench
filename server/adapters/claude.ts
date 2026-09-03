import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentAdapter, AdapterDetectionResult } from './base.js'
import { analyzeRun, turnsFor } from '../run-analysis.js'
import type {
  RunAnalysis,
  SessionDescriptor,
  SessionSnapshot,
  TurnDescriptor,
} from '../types.js'

async function walkClaude(dir: string, into: string[]) {
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkClaude(full, into)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) into.push(full)
  }
}

function claudeContent(event: any) { return event.content || event.message?.content }
function claudeUsage(event: any) { return event.usage || event.message?.usage }
function isClaudeUserPrompt(event: any) {
  const content = claudeContent(event)
  if (event.type !== 'user' || (event.role || event.message?.role) !== 'user') return false
  if (Array.isArray(content) && content.some((item: any) => item.type === 'tool_result')) return false
  if (event.userType === 'external' || event.origin?.kind === 'human') return true
  return typeof content === 'string' ? Boolean(content.trim()) : Array.isArray(content) && content.some((item: any) => item.type === 'text')
}

function normalizeClaudeEvents(rawContent: string): any[] {
  const lines = rawContent.split(/\r?\n/).filter(Boolean)
  const rawEvents: any[] = []
  for (const line of lines) {
    try { rawEvents.push(JSON.parse(line)) } catch { /* skip */ }
  }

  const normalized: any[] = []
  let currentTurnId = ''
  let userTurnCount = 0
  let latestModel = 'claude-3-7-sonnet'
  let latestCwd = ''
  let lastTimestamp = ''
  const tokenUsageSnapshots = new Set<string>()

  for (let i = 0; i < rawEvents.length; i++) {
    const event = rawEvents[i]
    const sourceTimestamp = event.timestamp || event.created_at || (event.message?.created_at ? new Date(event.message.created_at).toISOString() : '')
    const ts = sourceTimestamp || lastTimestamp || new Date().toISOString()
    if (sourceTimestamp) lastTimestamp = sourceTimestamp
    if (event.cwd) latestCwd = event.cwd
    if (event.model || event.message?.model) latestModel = event.model || event.message?.model

    const role = event.role || event.message?.role
    const content = claudeContent(event)

    if (isClaudeUserPrompt(event)) {
      if (currentTurnId) {
        normalized.push({
          timestamp: ts,
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: currentTurnId },
        })
      }
      userTurnCount++
      currentTurnId = String(event.uuid || event.id || `turn-${userTurnCount}`)

      const userText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((c: any) => c.text || '').join('\n')
          : String(content || '')

      normalized.push({
        timestamp: ts,
        type: 'turn_context',
        payload: { model: latestModel, cwd: latestCwd, turn_id: currentTurnId },
      })
      normalized.push({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'user_message', message: userText, turn_id: currentTurnId },
      })
      normalized.push({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: currentTurnId },
      })
    } else if (role === 'assistant' || Array.isArray(content)) {
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'thinking') {
            normalized.push({
              timestamp: ts,
              type: 'response_item',
              payload: { type: 'reasoning', summary: item.thinking || item.text || '' },
            })
          } else if (item.type === 'text') {
            normalized.push({
              timestamp: ts,
              type: 'response_item',
              payload: { type: 'message', content: item.text },
            })
            normalized.push({
              timestamp: ts,
              type: 'event_msg',
              payload: { type: 'agent_message', message: item.text },
            })
          } else if (item.type === 'tool_use') {
            normalized.push({
              timestamp: ts,
              type: 'response_item',
              payload: {
                type: 'function_call',
                call_id: item.id || randomUUID(),
                name: item.name || 'tool',
                arguments: typeof item.input === 'string' ? item.input : JSON.stringify(item.input || {}),
              },
            })
          } else if (item.type === 'tool_result') {
            normalized.push({
              timestamp: ts,
              type: 'response_item',
              payload: {
                type: 'function_call_output',
                call_id: item.tool_use_id || item.id || randomUUID(),
                output: typeof item.content === 'string' ? item.content : JSON.stringify(item.content || ''),
                status: item.is_error ? 'failed' : 'success',
              },
            })
          }
        }
      } else if (typeof content === 'string') {
        normalized.push({
          timestamp: ts,
          type: 'response_item',
          payload: { type: 'message', content },
        })
        normalized.push({
          timestamp: ts,
          type: 'event_msg',
          payload: { type: 'agent_message', message: content },
        })
      }
    }

    const usage = claudeUsage(event)
    const messageId = event.message?.id || event.uuid || event.id || ''
    const usageKey = `${currentTurnId}:${messageId}:${usage?.input_tokens}:${usage?.cache_read_input_tokens}:${usage?.cache_creation_input_tokens}:${usage?.output_tokens}`
    if (currentTurnId && usage && messageId && !tokenUsageSnapshots.has(usageKey)) {
      tokenUsageSnapshots.add(usageKey)
      const cached = Number(usage.cache_read_input_tokens) || 0
      const cacheWrite = Number(usage.cache_creation_input_tokens) || 0
      const uncached = Number(usage.input_tokens) || 0
      const output = Number(usage.output_tokens) || 0
      const contextWindow = Number(event.model_context_window || event.context_window || event.message?.model_context_window || event.message?.context_window) || undefined
      normalized.push({
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          turn_id: currentTurnId,
          info: { last_token_usage: { input_tokens: uncached + cached + cacheWrite, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, total_tokens: uncached + cached + cacheWrite + output }, model_context_window: contextWindow },
        },
      })
    }
  }

  if (currentTurnId) {
    normalized.push({
      timestamp: lastTimestamp || new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: currentTurnId },
    })
  }

  return normalized
}

export class ClaudeAdapter implements AgentAdapter {
  readonly source = 'claude' as const
  readonly label = 'Claude'
  readonly defaultRoot: string
  readonly root: string
  private catalog = new Map<string, SessionDescriptor>()
  private scannedAt = 0
  private snapshotCache = new Map<string, { mtimeMs: number; size: number; snapshot: SessionSnapshot; analyses: Map<string, RunAnalysis>; events: any[] }>()

  constructor(root?: string) {
    this.defaultRoot = path.join(os.homedir(), '.claude')
    this.root = root || process.env.CLAUDE_SESSIONS_ROOT || this.defaultRoot
  }

  async detect(): Promise<AdapterDetectionResult> {
    try {
      const stat = await fs.stat(this.root)
      if (!stat.isDirectory()) return { status: 'not_found', sessionCount: 0, path: this.root }
      const sessions = await this.discover()
      return { status: 'ready', sessionCount: sessions.length, path: this.root }
    } catch (error) {
      return { status: 'not_found', sessionCount: 0, path: this.root, error: error instanceof Error ? error.message : '目录未找到' }
    }
  }

  async discover(force = false): Promise<SessionDescriptor[]> {
    if (!force && Date.now() - this.scannedAt < 5000 && this.catalog.size) return [...this.catalog.values()]
    const files: string[] = []
    await walkClaude(path.join(this.root, 'projects'), files)

    const all: SessionDescriptor[] = []
    for (const file of files) {
      try {
        const stat = await fs.stat(file)
        const events = (await fs.readFile(file, 'utf8')).split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
        const prompts = events.filter(isClaudeUserPrompt)
        if (!prompts.length) continue
        const latest = prompts.at(-1)
        const id = String(latest.sessionId || latest.session_id || path.basename(file, path.extname(file))).toLowerCase()
        const title = events.toReversed().find(event => event.type === 'ai-title' && event.aiTitle)?.aiTitle
        const firstPrompt = prompts.map(event => typeof claudeContent(event) === 'string' ? claudeContent(event) : Array.isArray(claudeContent(event)) ? claudeContent(event).map((item: any) => item.text || '').join('\n') : '').find(Boolean)
        const models = new Set(events.map(event => String(event.model || event.message?.model || '')).filter(Boolean))
        const model = events.find(event => event.model || event.message?.model)?.model || events.find(event => event.message?.model)?.message.model || 'claude-3-7-sonnet'
        const cwd = events.find(event => event.cwd)?.cwd || null
        all.push({
          id,
          source: 'claude',
          parentId: null,
          projectPath: cwd,
          model,
          startedAt: prompts[0].timestamp || stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          status: 'complete',
          childCount: 0,
          turnCount: prompts.length,
          latestTurnId: String(latest.uuid || latest.id || `turn-${prompts.length}`),
          file,
          name: title || firstPrompt || `Claude Session ${id.slice(0, 8)}`,
          titleSource: title ? 'native' : firstPrompt ? 'first_user_message' : 'fallback_id',
          additionalModelCount: Math.max(0, models.size - 1),
        })
      } catch { /* skip */ }
    }

    this.catalog = new Map(all.map(item => [item.id, item]))
    this.scannedAt = Date.now()
    return [...this.catalog.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async snapshot(id: string): Promise<SessionSnapshot> {
    let descriptor = this.catalog.get(id)
    if (!descriptor?.file) {
      await this.discover()
      descriptor = this.catalog.get(id)
    }
    if (!descriptor) {
      descriptor = {
        id,
        source: 'claude',
        parentId: null,
        projectPath: null,
        model: 'claude-3-7-sonnet',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'complete',
        childCount: 0,
        name: 'Claude Session',
      }
    }

    if (descriptor.file) {
      const stat = await fs.stat(descriptor.file)
      const cached = this.snapshotCache.get(id)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.snapshot
      }

      const content = await fs.readFile(descriptor.file, 'utf8')
      const events = normalizeClaudeEvents(content)
      const turns = turnsFor(events, 'claude', descriptor.id)
      const analyses = new Map<string, RunAnalysis>()
      for (const turn of turns) {
        const analysis = analyzeRun(events, descriptor, turn.ref, 0)
        analyses.set(turn.ref.turnId, analysis)
      }

      const latestTurn = turns.at(-1)
      const latestAnalysis = latestTurn ? analyses.get(latestTurn.ref.turnId) : undefined
      descriptor.turnCount = turns.length
      descriptor.latestTurnId = latestTurn?.ref.turnId || null

      const snapshot: SessionSnapshot = {
        descriptor,
        v2: latestAnalysis?.v2 || { version: 2, session: { id: descriptor.id, status: descriptor.status } },
        runs: turns,
        diagnostics: [],
      }

      this.snapshotCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, snapshot, analyses, events })
      return snapshot
    }

    return {
      descriptor,
      v2: { version: 2, session: { id: descriptor.id, status: descriptor.status } },
      runs: [],
      diagnostics: [],
    }
  }

  async turns(id: string): Promise<TurnDescriptor[]> {
    return (await this.snapshot(id)).runs || []
  }

  async run(sessionId: string, turnId: string): Promise<RunAnalysis> {
    await this.snapshot(sessionId)
    const cached = this.snapshotCache.get(sessionId)
    let analysis = cached?.analyses.get(turnId)
    if (!analysis && cached) {
      const descriptor = this.catalog.get(sessionId) || cached.snapshot.descriptor
      analysis = analyzeRun(cached.events, descriptor, { source: 'claude', sessionId, turnId }, 0)
      cached.analyses.set(turnId, analysis)
    }
    if (!analysis) throw new Error(`未找到 Claude Turn ${turnId}`)
    return analysis
  }
}
