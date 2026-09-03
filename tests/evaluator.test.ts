import assert from 'node:assert/strict'
import test from 'node:test'
import { deterministicEvaluation, judgePreview, manualEvaluation } from '../server/evaluator.ts'

const evidence = { goal: 'Build the project', finalOutput: 'Done', artifacts: [], validations: [{ kind: 'test' as const, label: 'npm test', passed: true, detail: 'ok' }, { kind: 'build' as const, label: 'npm run build', passed: true, detail: 'ok' }, { kind: 'lint' as const, label: 'npm run lint', passed: true, detail: 'ok' }] }

test('deterministic coding evaluation stays partial when correctness evidence is missing', () => {
  const evaluation = deterministicEvaluation('coding', evidence)
  assert.equal(evaluation.status, 'partial')
  assert.equal(evaluation.overall, null)
  assert.equal(evaluation.dimensions.find(item => item.id === 'tests')?.score, 100)
})

test('manual evaluation calculates an overall only when every rubric dimension is supplied', () => {
  const evaluation = manualEvaluation('generic', { correctness: 80, completeness: 90, instruction: 100, grounding: 70 }, 'reviewed')
  assert.equal(evaluation.status, 'complete')
  assert.equal(evaluation.overall, 85)
})

test('judge preview redacts credentials before explicit user confirmation', () => {
  const preview = judgePreview({ ...evidence, finalOutput: 'Bearer abcdefghijklmnopqrstuvwxyz' }, 'generic')
  assert.ok(!preview.finalOutput.includes('abcdefghijklmnopqrstuvwxyz'))
  assert.ok(preview.finalOutput.includes('<redacted>'))

  const privatePreview = judgePreview({ ...evidence, goal: 'open /Users/alice/project with api_key=secret-value and ghp_example_token' }, 'generic')
  assert.doesNotMatch(privatePreview.goal, /alice|secret-value|ghp_/)
})
