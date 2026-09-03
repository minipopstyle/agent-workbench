import type { AgentAdapter, AdapterDetectionResult } from './base.js'
import { CodexAdapter } from './codex.js'
import { WorkBuddyAdapter } from './workbuddy.js'
import { ClaudeAdapter } from './claude.js'
import type { RunRef, RunSource, SessionDescriptor, SessionSnapshot, TurnDescriptor, RunAnalysis } from '../types.js'

export class AdapterRegistry {
  private adapters = new Map<RunSource, AgentAdapter>()

  constructor() {
    this.register(new CodexAdapter())
    this.register(new WorkBuddyAdapter())
    this.register(new ClaudeAdapter())
  }

  register(adapter: AgentAdapter) {
    this.adapters.set(adapter.source, adapter)
  }

  get(source: RunSource): AgentAdapter | undefined {
    return this.adapters.get(source)
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  async detectAll(): Promise<Array<AdapterDetectionResult & { id: RunSource; label: string }>> {
    const results = await Promise.all(
      this.all().map(async adapter => {
        const detection = await adapter.detect()
        return {
          id: adapter.source,
          label: adapter.label,
          ...detection,
        }
      })
    )
    return results
  }

  async discoverAll(force = false): Promise<SessionDescriptor[]> {
    const lists = await Promise.all(this.all().map(a => a.discover(force).catch(() => [])))
    return lists.flat().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  async discoverSource(source: RunSource, force = false): Promise<SessionDescriptor[]> {
    const adapter = this.get(source)
    if (!adapter) return []
    return (await adapter.discover(force)).toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  async snapshot(source: RunSource, id: string): Promise<SessionSnapshot> {
    const adapter = this.get(source)
    if (!adapter) throw new Error(`未找到数据源适配器: ${source}`)
    return adapter.snapshot(id)
  }

  async turns(source: RunSource, id: string): Promise<TurnDescriptor[]> {
    const adapter = this.get(source)
    if (!adapter) throw new Error(`未找到数据源适配器: ${source}`)
    return adapter.turns(id)
  }

  async run(ref: RunRef): Promise<RunAnalysis> {
    const adapter = this.get(ref.source)
    if (!adapter) throw new Error(`未找到数据源适配器: ${ref.source}`)
    return adapter.run(ref.sessionId, ref.turnId)
  }
}
