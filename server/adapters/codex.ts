import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
// @ts-expect-error ponytail: legacy compatibility seam stays JS until its public contract is retired.
import { createSessionAdapter } from '../legacy/session-data.mjs'
import { analyzeRun, currentSessionStatus, turnsFor } from '../run-analysis.js'
import { detectSessionFormat, parseDshSession, parseJsonl } from '../imports.js'
import type { RunAnalysis, SessionDescriptor, SessionSnapshot, TurnDescriptor } from '../types.js'

const sessionData = createSessionAdapter()
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i
const MAX_ANALYSIS_BYTES = Math.max(8 * 1024 * 1024, Number(process.env.AGENT_WORKBENCH_MAX_ANALYSIS_BYTES || 8 * 1024 * 1024))
const MAX_IMPORT_BYTES = 32 * 1024 * 1024

async function firstLine(file: string) {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0])
  } finally { await handle.close() }
}

async function headEvents(file: string) {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(512 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).slice(1).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  } finally { await handle.close() }
}

const textOf = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') return typeof (value as { text?: unknown }).text === 'string' ? String((value as { text: string }).text) : ''
  return String(value)
}
const titleOf = (event: any) => {
  const payload = event.payload || {}
  const value = payload.type === 'user_message' ? textOf(payload.message) : payload.item?.type === 'UserMessage' ? textOf(payload.item.content) : ''
  const marker = '## My request:'
  return (value.includes(marker) ? value.slice(value.indexOf(marker) + marker.length) : value).replace(/\s+local_image\S.*$/s, '').replace(/\s+/g, ' ').trim()
}

function withImportTurn(events: any[]) {
  if (events.some(event => event.type === 'event_msg' && event.payload?.type === 'task_started')) return events
  const index = events.findIndex(event => event.type === 'response_item' || (event.type === 'event_msg' && ['user_message', 'agent_message', 'item_completed'].includes(event.payload?.type)))
  if (index < 0) return events
  const event = events[index]
  return [...events.slice(0, index), { timestamp: event.timestamp || new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'import-turn-1' } }, ...events.slice(index)]
}

async function walk(dir: string, into: string[]) {
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(file, into)
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) into.push(file)
  }
}

async function tailEvents(file: string) {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat(); const size = Math.min(stat.size, 512 * 1024); const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, Math.max(0, stat.size - size))
    return buffer.toString('utf8').split(/\r?\n/).slice(1).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  } finally { await handle.close() }
}

async function readAnalysisWindow(file: string, size: number) {
  if (size <= MAX_ANALYSIS_BYTES) return { text: await fs.readFile(file, 'utf8'), truncated: false }
  const header = JSON.stringify(await firstLine(file))
  const tailSize = Math.max(1024, MAX_ANALYSIS_BYTES - Buffer.byteLength(header) - 1)
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(tailSize); const start = Math.max(0, size - tailSize)
    const { bytesRead } = await handle.read(buffer, 0, tailSize, start)
    const tail = buffer.subarray(0, bytesRead).toString('utf8'); const firstNewline = tail.indexOf('\n')
    return { text: `${header}\n${firstNewline >= 0 ? tail.slice(firstNewline + 1) : ''}`, truncated: true }
  } finally { await handle.close() }
}

import type { AgentAdapter, AdapterDetectionResult } from './base.js'

export class CodexAdapter implements AgentAdapter {
  readonly source = 'codex' as const
  readonly label = 'Codex'
  readonly defaultRoot: string
  readonly root: string
  private catalog = new Map<string, SessionDescriptor>()
  private scannedAt = 0

  constructor(root?: string) {
    this.defaultRoot = path.join(os.homedir(), '.codex', 'sessions')
    this.root = root || process.env.CODEX_SESSIONS_ROOT || this.defaultRoot
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

  async discover(force = false) {
    if (!force && Date.now() - this.scannedAt < 5000 && this.catalog.size) return [...this.catalog.values()]
    const files: string[] = []
    await walk(this.root, files)
    const all: Array<SessionDescriptor & { isChild: boolean }> = []
    for (const file of files) {
      try {
        const event = await firstLine(file)
        const payload = event?.payload || {}
        const id = String(payload.id || payload.session_id || '').toLowerCase()
        if (!UUID.test(id)) continue
        const stat = await fs.stat(file)
        const head = await headEvents(file)
        const tail = await tailEvents(file)
        const turnContexts = tail.filter(event => event.type === 'turn_context')
        const latestContext = turnContexts.at(-1)?.payload || {}
        const starts = tail.filter(event => event.type === 'event_msg' && event.payload?.type === 'task_started')
        const name = [...head, ...tail].map(titleOf).find(Boolean)
        const models = new Set(turnContexts.map(event => String(event.payload?.model || '')).filter(Boolean))
        all.push({
          id, source: 'codex', parentId: typeof payload.parent_thread_id === 'string' ? payload.parent_thread_id.toLowerCase() : null,
          projectPath: typeof payload.cwd === 'string' ? payload.cwd : null, model: latestContext.model || payload.model || payload.model_provider || null, effort: latestContext.effort || null,
          startedAt: event.timestamp || stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString(), status: currentSessionStatus(tail), childCount: 0, turnCount: starts.length || undefined, latestTurnId: latestContext.turn_id || starts.at(-1)?.payload?.turn_id || null, file, name: name || undefined, titleSource: name ? 'first_user_message' : 'fallback_id', additionalModelCount: Math.max(0, models.size - 1),
          isChild: Boolean(payload.source && typeof payload.source === 'object' && payload.source.subagent),
        })
      } catch { /* malformed metadata is omitted from the catalog */ }
    }
    const counts = new Map<string, number>()
    all.forEach(item => { if (item.parentId) counts.set(item.parentId, (counts.get(item.parentId) || 0) + 1) })
    this.catalog = new Map(all.filter(item => !item.isChild).map(item => [item.id, { ...item, childCount: counts.get(item.id) || 0 }]))
    this.scannedAt = Date.now()
    return [...this.catalog.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private snapshotCache = new Map<string, { mtimeMs: number; size: number; snapshot: SessionSnapshot; analyses: Map<string, RunAnalysis>; events: any[]; malformed: number }>()

  async getFileMeta(id: string): Promise<{ file: string; mtimeMs: number; size: number } | null> {
    let descriptor = this.catalog.get(id)
    if (!descriptor?.file) {
      await this.discover()
      descriptor = this.catalog.get(id)
    }
    if (!descriptor?.file) return null
    try {
      const stat = await fs.stat(descriptor.file)
      return { file: descriptor.file, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return null
    }
  }

  async snapshot(id: string): Promise<SessionSnapshot> {
    const meta = await this.getFileMeta(id)
    if (!meta) throw new Error('未找到 Session 文件')
    const cached = this.snapshotCache.get(id)
    if (cached && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size) {
      return cached.snapshot
    }
    const descriptor = this.catalog.get(id); const loaded = await readAnalysisWindow(meta.file, meta.size)
    const { snapshot, analyses, events, malformed } = await this.snapshotWithRunsFromText(loaded.text, descriptor)
    if (loaded.truncated) snapshot.diagnostics.push(`大于 ${(MAX_ANALYSIS_BYTES / 1024 / 1024).toFixed(0)}MB 的日志仅分析最后一个安全窗口；较早 Turn 可重新导入单独分析。`)
    this.snapshotCache.set(id, { mtimeMs: meta.mtimeMs, size: meta.size, snapshot, analyses, events, malformed })
    return snapshot
  }

  async turns(id: string): Promise<TurnDescriptor[]> { return (await this.snapshot(id)).runs || [] }

  async run(id: string, turnId: string): Promise<RunAnalysis> {
    await this.snapshot(id)
    const cached = this.snapshotCache.get(id)
    let analysis = cached?.analyses.get(turnId)
    if (!analysis && cached) { analysis = analyzeRun(cached.events, cached.snapshot.descriptor, { source: 'codex', sessionId: id, turnId }, cached.malformed); cached.analyses.set(turnId, analysis) }
    if (!analysis) throw new Error('未找到 Turn')
    return analysis
  }

  async snapshotWithRunsFromText(text: string, base?: SessionDescriptor): Promise<{ snapshot: SessionSnapshot; analyses: Map<string, RunAnalysis>; events: any[]; malformed: number }> {
    const parsed = sessionData.parse(text)
    const events = withImportTurn(parsed.events)
    const meta = events.find((event: { type?: string }) => event.type === 'session_meta')?.payload || {}
    const id = String(meta.id || meta.session_id || base?.id || randomUUID()).toLowerCase()
    const descriptor: SessionDescriptor = base || {
      id, source: 'import', parentId: null, projectPath: null, model: meta.model || meta.model_provider || null,
      startedAt: events[0]?.timestamp || new Date().toISOString(), updatedAt: new Date().toISOString(), status: currentSessionStatus(events), childCount: 0, name: 'Imported trace',
    }
    const turns = turnsFor(events, descriptor.source, descriptor.id)
    const latestTurn = turns.at(-1)
    const analyses = new Map<string, RunAnalysis>(latestTurn ? [[latestTurn.ref.turnId, analyzeRun(events, descriptor, latestTurn.ref, parsed.malformed)]] : [])
    const latest = analyses.get(turns.at(-1)?.ref.turnId || '')
    descriptor.model ||= latest?.identity.model || null
    descriptor.effort ||= latest?.identity.effort || null
    descriptor.status = currentSessionStatus(events)
    descriptor.turnCount = turns.length
    descriptor.latestTurnId = turns.at(-1)?.ref.turnId || null
    return { snapshot: { descriptor, v2: latest?.v2 || { version: 2, session: { id: descriptor.id, status: descriptor.status } }, runs: turns, diagnostics: parsed.malformed ? [`忽略 ${parsed.malformed} 行无法解析的 JSONL`] : [] }, analyses, events, malformed: parsed.malformed }
  }

  async snapshotFromText(text: string, base?: SessionDescriptor): Promise<SessionSnapshot> { return (await this.snapshotWithRunsFromText(text, base)).snapshot }

  async importWithRuns(name: string, base64: string) {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error('导入文件超过 32MB')
    const zstd = bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd
    const text = new TextDecoder().decode(zstd ? zstdDecompressSync(bytes, { maxOutputLength: MAX_IMPORT_BYTES }) : bytes)
    const parsed = parseJsonl(text)
    const format = detectSessionFormat(parsed.events)
    if (format === 'deepseek-harness') {
      const importId = `import-${randomUUID()}`
      const dsh = parseDshSession(parsed.events, { importId, fileName: name, malformedLines: parsed.malformedLines, warnings: parsed.warnings })
      const turns = turnsFor(dsh.events, 'import', importId)
      const analyses = new Map<string, RunAnalysis>()
      for (const turn of turns) analyses.set(turn.ref.turnId, analyzeRun(dsh.events, dsh.descriptor, turn.ref, parsed.malformedLines))
      const latest = turns.at(-1)
      return {
        snapshot: { descriptor: { ...dsh.descriptor, turnCount: turns.length, latestTurnId: latest?.ref.turnId || null }, v2: latest ? analyses.get(latest.ref.turnId)?.v2 || { version: 2 } : { version: 2, session: { id: importId, status: dsh.descriptor.status } }, runs: turns, normalized: dsh.trace, parseDiagnostics: dsh.diagnostics, diagnostics: [parsed.malformedLines ? `忽略 ${parsed.malformedLines} 行无法解析的 JSONL` : '', dsh.diagnostics.ignoredEvents ? `已忽略 ${dsh.diagnostics.ignoredEvents} 个非核心事件` : ''].filter(Boolean) },
        analyses,
        events: dsh.events,
        malformed: parsed.malformedLines,
      }
    }
    if (format === 'unknown') throw new Error(parsed.events.length ? '暂不支持该 Session 格式' : 'JSONL 文件格式错误：未找到有效 JSON Event')
    const importedId = `import-${randomUUID()}`
    const base: SessionDescriptor = { id: importedId, source: 'import', parentId: null, projectPath: null, model: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'unknown', childCount: 0, name }
    return this.snapshotWithRunsFromText(text, base)
  }

  async importFile(name: string, base64: string) {
    return (await this.importWithRuns(name, base64)).snapshot
  }
}
