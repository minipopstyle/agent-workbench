import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LocalState } from '../server/state.ts'

test('explicitly saved imports survive a LocalState reload without raw JSONL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-workbench-state-'))
  try {
    const first = new LocalState(root)
    await first.saveImport('import-1', { snapshot: { descriptor: { id: 'import-1', source: 'import', parentId: null, projectPath: null, model: null, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'complete', childCount: 0 }, v2: { normalized: true }, diagnostics: [] }, analyses: [], savedAt: '2026-01-01T00:00:00.000Z' })
    const second = new LocalState(root)
    assert.equal((await second.savedImport('import-1'))?.snapshot.descriptor.id, 'import-1')
    assert.equal((await stat(path.join(root, 'state-v1.json'))).mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('patching a baseline preserves omitted task group fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-workbench-state-'))
  try {
    const state = new LocalState(root); const ref = { source: 'codex' as const, sessionId: 'session', turnId: 'turn' }
    const group = await state.createGroup({ title: 'Keep this title', taskType: 'coding', confirmedRuns: [ref] })
    const updated = await state.patchGroup(group.evalTaskId, { baselineRun: ref })
    assert.equal(updated.title, 'Keep this title')
    assert.equal(updated.taskType, 'coding')
  } finally { await rm(root, { recursive: true, force: true }) }
})
