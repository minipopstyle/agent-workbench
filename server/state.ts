import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EvaluationResult, RunOutcome, RunRef, SavedImport, TaskGroup, TaskType } from './types.js'
import { runKey } from './run-analysis.js'

type SavedState = { schemaVersion: 1; groups: TaskGroup[]; evaluations: Record<string, EvaluationResult>; outcomes: Record<string, RunOutcome>; imports: Record<string, SavedImport> }
const empty = (): SavedState => ({ schemaVersion: 1, groups: [], evaluations: {}, outcomes: {}, imports: {} })

export class LocalState {
  private value: SavedState = empty()
  private loaded = false
  readonly dir: string
  readonly file: string
  readonly backup: string

  constructor(root = path.join(os.homedir(), '.agent-workbench')) { this.dir = root; this.file = path.join(root, 'state-v1.json'); this.backup = `${this.file}.bak` }

  async load() {
    if (this.loaded) return this.value
    const read = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8')) as SavedState
    try { this.value = await read(this.file) }
    catch { try { this.value = await read(this.backup) } catch { this.value = empty() } }
    if (this.value.schemaVersion !== 1 || !Array.isArray(this.value.groups) || !this.value.evaluations) this.value = empty()
    this.value.imports ||= {}; this.value.outcomes ||= {}
    this.loaded = true
    return this.value
  }

  private async save() {
    await this.load(); await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const data = JSON.stringify(this.value, null, 2)
    const temp = `${this.file}.${process.pid}.tmp`
    try { await fs.copyFile(this.file, this.backup) } catch { /* first write */ }
    await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, this.file); await fs.chmod(this.file, 0o600)
  }

  async groups() { return (await this.load()).groups }
  async group(id: string) { return (await this.load()).groups.find(group => group.evalTaskId === id) || null }
  async createGroup(input: { title: string; taskType?: TaskType; confirmedRuns?: RunRef[] }) {
    const now = new Date().toISOString(); const group: TaskGroup = { evalTaskId: randomUUID(), title: input.title.trim() || 'Untitled task', taskType: input.taskType || 'generic', confirmedRuns: input.confirmedRuns || [], suggestedRuns: [], createdAt: now, updatedAt: now }
    ;(await this.load()).groups.push(group); await this.save(); return group
  }
  async patchGroup(id: string, input: Partial<Pick<TaskGroup, 'title' | 'taskType' | 'baselineRun' | 'suggestedRuns'>>) {
    const group = await this.group(id); if (!group) throw new Error('未找到任务组')
    Object.assign(group, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), { updatedAt: new Date().toISOString() })
    if (group.baselineRun && !group.confirmedRuns.some(run => runKey(run) === runKey(group.baselineRun!))) group.baselineRun = undefined
    await this.save(); return group
  }
  async addRun(id: string, ref: RunRef) {
    const group = await this.group(id); if (!group) throw new Error('未找到任务组')
    if (!group.confirmedRuns.some(run => runKey(run) === runKey(ref))) group.confirmedRuns.push(ref)
    group.suggestedRuns = group.suggestedRuns.filter(run => runKey(run) !== runKey(ref)); group.updatedAt = new Date().toISOString(); await this.save(); return group
  }
  async removeRun(id: string, key: string) {
    const group = await this.group(id); if (!group) throw new Error('未找到任务组')
    group.confirmedRuns = group.confirmedRuns.filter(run => runKey(run) !== key)
    if (group.baselineRun && runKey(group.baselineRun) === key) group.baselineRun = undefined
    group.updatedAt = new Date().toISOString(); await this.save(); return group
  }
  async evaluation(ref: RunRef) { return (await this.load()).evaluations[runKey(ref)] || null }
  async saveEvaluation(ref: RunRef, evaluation: EvaluationResult) { (await this.load()).evaluations[runKey(ref)] = evaluation; await this.save(); return evaluation }
  async outcome(ref: RunRef) { return (await this.load()).outcomes[runKey(ref)] || null }
  async saveOutcome(ref: RunRef, outcome: RunOutcome) { (await this.load()).outcomes[runKey(ref)] = outcome; await this.save(); return outcome }
  async saveImport(id: string, imported: SavedImport) { (await this.load()).imports[id] = imported; await this.save(); return imported }
  async savedImport(id: string) { return (await this.load()).imports[id] || null }
  async savedImports() { return Object.entries((await this.load()).imports).map(([id, value]) => ({ id, snapshot: value.snapshot, savedAt: value.savedAt })) }
}
