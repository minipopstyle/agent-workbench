import type { EvalEvidence, EvaluationResult, TaskType } from './types.js'
import { sanitizeText } from './comparison-report.js'

const rubrics: Record<TaskType, Array<[string, string, number]>> = {
  generic: [['correctness', '正确性', 40], ['completeness', '完整性', 25], ['instruction', '指令遵循', 20], ['grounding', '证据充分性', 15]],
  coding: [['correctness', '正确性', 50], ['tests', '测试', 25], ['verification', '构建与静态检查', 15], ['artifact', '产物有效性', 10]],
  content: [['faithfulness', '忠实度', 35], ['completeness', '完整性', 30], ['instruction', '指令遵循', 20], ['language', '语言质量', 15]],
}
export const evaluatorCatalog = Object.entries(rubrics).map(([id, dimensions]) => ({ id, version: 1, dimensions: dimensions.map(([key, label, weight]) => ({ id: key, label, weight })) }))
const validScore = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null

export function deterministicEvaluation(taskType: TaskType, evidence: EvalEvidence): EvaluationResult {
  const validationScore = (kind: string) => {
    const records = evidence.validations.filter(item => item.kind === kind)
    return records.length && records.every(item => item.passed === true) ? 100 : records.some(item => item.passed === false) ? 0 : null
  }
  const dimensions = rubrics[taskType].map(([id, label, weight]) => {
    const score = taskType === 'coding' && id === 'tests' ? validationScore('test') : taskType === 'coding' && id === 'verification' ? (() => { const values = [validationScore('build'), validationScore('lint')].filter((value): value is number => value != null); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null })() : null
    return { id, label, weight, score, note: score == null ? '缺少可验证的本地证据。' : '来自本地命令结果。' }
  })
  return finalize('deterministic', taskType, dimensions, null)
}

export function manualEvaluation(taskType: TaskType, values: Record<string, unknown>, notes: string | null): EvaluationResult {
  return finalize('manual', taskType, rubrics[taskType].map(([id, label, weight]) => { const note = values[`${id}Note`]; return { id, label, weight, score: validScore(values[id]), note: typeof note === 'string' ? note : undefined } }), notes)
}

export function finalize(evaluatorId: EvaluationResult['evaluatorId'], taskType: TaskType, dimensions: EvaluationResult['dimensions'], notes: string | null): EvaluationResult {
  const complete = dimensions.every(item => item.score != null)
  return { evaluatorId, rubricId: taskType, rubricVersion: 1, status: complete ? 'complete' : 'partial', dimensions, overall: complete ? dimensions.reduce((sum, item) => sum + (item.score || 0) * item.weight, 0) / 100 : null, notes, createdAt: new Date().toISOString() }
}

export function judgePreview(evidence: EvalEvidence, taskType: TaskType) {
  const redact = (value: string | null) => sanitizeText(value || '')
  return { taskType, goal: redact(evidence.goal), finalOutput: redact(evidence.finalOutput), validations: evidence.validations.map(item => ({ kind: item.kind, label: redact(item.label), passed: item.passed, detail: redact(item.detail) })) }
}

export function judgeEvaluation(taskType: TaskType, value: unknown): EvaluationResult {
  const object = typeof value === 'object' && value ? value as Record<string, unknown> : {}
  const scores = typeof object.dimensions === 'object' && object.dimensions ? object.dimensions as Record<string, unknown> : object
  return finalize('llm', taskType, rubrics[taskType].map(([id, label, weight]) => ({ id, label, weight, score: validScore(scores[id]), note: typeof object.notes === 'string' ? object.notes : undefined })), typeof object.notes === 'string' ? object.notes : null)
}
