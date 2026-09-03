import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createSessionAdapter } from '../server/legacy/session-data.mjs'
import { buildTrajectoryV2 } from '../server/legacy/v2-data.mjs'

test('Codex fixture builds a V2-compatible snapshot without rewriting the log', async () => {
  const text = await readFile(new URL('./sample-rollout.jsonl', import.meta.url), 'utf8')
  const parsed = createSessionAdapter().parse(text)
  const meta = parsed.events.find((event: { type?: string }) => event.type === 'session_meta')?.payload || {}
  const snapshot = buildTrajectoryV2(parsed.events, meta, [])
  assert.ok(snapshot.session.id)
  assert.ok(Array.isArray(snapshot.steps))
  assert.ok(Array.isArray(snapshot.tools))
})
