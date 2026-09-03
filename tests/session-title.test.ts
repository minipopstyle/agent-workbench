import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionTitle } from '../src/api.ts'

test('session title follows the Sessions page fallback order', () => {
  const base = { source: 'codex' as const, parentId: null, projectPath: null, model: null, startedAt: '', updatedAt: '', status: 'complete' as const, childCount: 0 }

  assert.equal(sessionTitle({ ...base, id: 'one', displayTitle: '会话标题', name: '原始标题' }), '会话标题')
  assert.equal(sessionTitle({ ...base, id: 'two', name: '原始标题' }), '原始标题')
  assert.equal(sessionTitle({ ...base, id: '123456789' }), 'Session 12345678')
  assert.equal(sessionTitle({ ...base, id: 'three', displayTitle: '将 trace 列表的会话改成和 session 页面会话标题一样的字段' }, 20), '将 trace 列表的会话改成和 ses…')
})
