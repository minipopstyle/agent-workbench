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

const contextWindowFor = (model: string) => ({ 'glm-5.2': 1_000_000 }[model.trim().toLowerCase()])

async function walkWorkbuddy(dir: string, into: string[]) {
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkWorkbuddy(full, into)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) into.push(full)
  }
}

function normalizeWorkbuddyEvents(rawLines: string[]): any[] {
  const rawEvents: any[] = []
  for (const line of rawLines) {
    try { rawEvents.push(JSON.parse(line)) } catch { /* skip */ }
  }

  const normalized: any[] = []
  let currentTurnId = ''
  let userTurnCount = 0
  let latestModel = 'auto'
  let latestCwd = ''
  let lastTimestamp = ''
  let contextSignature = ''
  const tokenUsageSnapshots = new Set<string>()

  for (let i = 0; i < rawEvents.length; i++) {
    const event = rawEvents[i]
    const ts = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()
    if (event.cwd) latestCwd = event.cwd
    if (event.providerData?.model) latestModel = event.providerData.model

    if (event.type === 'message' && event.role === 'user') {
      if (currentTurnId) {
        normalized.push({
          timestamp: lastTimestamp || ts,
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: currentTurnId },
        })
      }
      userTurnCount++
      currentTurnId = String(event.id || `turn-${userTurnCount}`)

      const userText = Array.isArray(event.content)
        ? event.content.map((c: any) => c.text || '').join('\n')
        : String(event.content || '')

      normalized.push({
        timestamp: ts,
        type: 'turn_context',
        payload: { model: latestModel, cwd: latestCwd, turn_id: currentTurnId },
      })
      contextSignature = `${currentTurnId}:${latestModel}:${latestCwd}`
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
    } else if (event.type === 'function_call') {
      const callId = event.callId || event.id || randomUUID()
      normalized.push({
        timestamp: ts,
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: callId,
          name: event.name || 'tool',
          arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments || {}),
        },
      })
    } else if (event.type === 'function_call_result') {
      const callId = event.callId || event.id || randomUUID()
      normalized.push({
        timestamp: ts,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output: typeof event.output === 'string' ? event.output : JSON.stringify(event.output || ''),
          status: event.status === 'error' ? 'failed' : 'success',
        },
      })
    } else if (event.type === 'message' && event.role === 'assistant') {
      const text = Array.isArray(event.content)
        ? event.content.map((c: any) => c.text || '').join('\n')
        : String(event.content || '')
      normalized.push({
        timestamp: ts,
        type: 'response_item',
        payload: { type: 'message', content: text },
      })
      normalized.push({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'agent_message', message: text },
      })
    } else if (event.type === 'reasoning') {
      const text = Array.isArray(event.content)
        ? event.content.map((c: any) => c.text || '').join('\n')
        : String(event.content || event.rawContent || '')
      normalized.push({
        timestamp: ts,
        type: 'response_item',
        payload: { type: 'reasoning', content: text },
      })
    }

    if (currentTurnId && event.providerData?.model) {
      const signature = `${currentTurnId}:${latestModel}:${latestCwd}`
      if (signature !== contextSignature) {
        normalized.push({ timestamp: ts, type: 'turn_context', payload: { model: latestModel, cwd: latestCwd, turn_id: currentTurnId } })
        contextSignature = signature
      }
    }

    const usage = event.providerData?.usage
    const requestId = String(event.providerData?.conversationRequestId || event.providerData?.messageId || event.providerData?.traceId || '')
    const usageSnapshot = `${currentTurnId}:${requestId}:${usage?.inputTokens}:${usage?.outputTokens}:${usage?.totalTokens}`
    if (currentTurnId && usage && requestId && !tokenUsageSnapshots.has(usageSnapshot)) {
      tokenUsageSnapshots.add(usageSnapshot)
      const cached = (usage.inputTokensDetails || []).reduce((total: number, item: any) => total + Number(item.cached_tokens ?? item.cachedTokens ?? 0), 0)
      const reasoning = (usage.outputTokensDetails || []).reduce((total: number, item: any) => total + Number(item.reasoning_tokens ?? item.reasoningTokens ?? 0), 0)
      const contextWindow = Number(event.providerData?.contextWindow ?? event.providerData?.context_window ?? contextWindowFor(latestModel)) || undefined
      normalized.push({
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          turn_id: currentTurnId,
          info: { last_token_usage: { input_tokens: Number(usage.inputTokens) || 0, cached_input_tokens: cached, output_tokens: Number(usage.outputTokens) || 0, reasoning_output_tokens: reasoning, total_tokens: Number(usage.totalTokens) || 0 }, model_context_window: contextWindow },
        },
      })
    }
    lastTimestamp = ts
  }

  if (currentTurnId) {
    const lastTs = rawEvents.at(-1)?.timestamp ? new Date(rawEvents.at(-1).timestamp).toISOString() : new Date().toISOString()
    normalized.push({
      timestamp: lastTs,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: currentTurnId },
    })
  }

  return normalized
}

export class WorkBuddyAdapter implements AgentAdapter {
  readonly source = 'workbuddy' as const
  readonly label = 'WorkBuddy'
  readonly defaultRoot: string
  readonly root: string
  private catalog = new Map<string, SessionDescriptor>()
  private scannedAt = 0
  private snapshotCache = new Map<string, { mtimeMs: number; size: number; snapshot: SessionSnapshot; analyses: Map<string, RunAnalysis>; events: any[] }>()

  constructor(root?: string) {
    this.defaultRoot = path.join(os.homedir(), '.workbuddy')
    this.root = root || process.env.WORKBUDDY_SESSIONS_ROOT || this.defaultRoot
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
    const projectsDir = path.join(this.root, 'projects')
    await walkWorkbuddy(projectsDir, files)

    const all: SessionDescriptor[] = []
    for (const file of files) {
      try {
        const stat = await fs.stat(file)
        const content = await fs.readFile(file, 'utf8')
        const lines = content.split(/\r?\n/).filter(Boolean)
        if (!lines.length) continue

        let id = path.basename(file, '.jsonl').toLowerCase()
        let cwd: string | null = null
        let model: string | null = null
        let title: string | null = null
        let firstPrompt: string | null = null
        const models = new Set<string>()
        let startedAt = stat.birthtime.toISOString()
        let updatedAt = stat.mtime.toISOString()
        let userTurnCount = 0
        let latestTurnId: string | null = null

        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (event.sessionId) id = String(event.sessionId).toLowerCase()
            if (event.cwd && !cwd) cwd = String(event.cwd)
            if (event.type === 'ai-title' && event.aiTitle) title = String(event.aiTitle)
            if (event.providerData?.model) { models.add(String(event.providerData.model)); if (!model) model = String(event.providerData.model) }
            if (event.timestamp) {
              const ts = new Date(event.timestamp).toISOString()
              if (!startedAt) startedAt = ts
              updatedAt = ts
            }
            if (event.type === 'message' && event.role === 'user') {
              userTurnCount++
              latestTurnId = event.id || `turn-${userTurnCount}`
              if (!firstPrompt) firstPrompt = Array.isArray(event.content) ? event.content.map((item: any) => item.text || '').join('\n') : String(event.content || '')
            }
          } catch { /* skip line */ }
        }

        all.push({
          id,
          source: 'workbuddy',
          parentId: null,
          projectPath: cwd,
          model: model || 'auto',
          startedAt,
          updatedAt,
          status: 'complete',
          childCount: 0,
          turnCount: userTurnCount || 1,
          latestTurnId,
          file,
          name: title || firstPrompt || undefined,
          titleSource: title ? 'native' : firstPrompt ? 'first_user_message' : 'fallback_id',
          additionalModelCount: Math.max(0, models.size - 1),
        })
      } catch { /* skip error */ }
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
    if (!descriptor?.file) throw new Error('未找到 WorkBuddy Session 文件')

    const stat = await fs.stat(descriptor.file)
    const cached = this.snapshotCache.get(id)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.snapshot
    }

    const content = await fs.readFile(descriptor.file, 'utf8')
    const lines = content.split(/\r?\n/).filter(Boolean)
    const events = normalizeWorkbuddyEvents(lines)

    const turns = turnsFor(events, 'workbuddy', descriptor.id)
    const analyses = new Map<string, RunAnalysis>()
    for (const turn of turns) {
      const analysis = analyzeRun(events, descriptor, turn.ref, 0)
      analyses.set(turn.ref.turnId, analysis)
    }

    const latestTurn = turns.at(-1)
    const latestAnalysis = latestTurn ? analyses.get(latestTurn.ref.turnId) : undefined
    descriptor.model = latestAnalysis?.identity.model || descriptor.model
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

  async turns(id: string): Promise<TurnDescriptor[]> {
    return (await this.snapshot(id)).runs || []
  }

  async run(sessionId: string, turnId: string): Promise<RunAnalysis> {
    await this.snapshot(sessionId)
    const cached = this.snapshotCache.get(sessionId)
    let analysis = cached?.analyses.get(turnId)
    if (!analysis && cached) {
      const descriptor = this.catalog.get(sessionId) || cached.snapshot.descriptor
      analysis = analyzeRun(cached.events, descriptor, { source: 'workbuddy', sessionId, turnId }, 0)
      cached.analyses.set(turnId, analysis)
    }
    if (!analysis) throw new Error(`未找到 WorkBuddy Turn ${turnId}`)
    return analysis
  }
}
