export type SessionStatus = 'live' | 'complete' | 'aborted' | 'unknown'
export type RunSource = 'codex' | 'claude' | 'workbuddy' | 'import'
export type TaskType = 'generic' | 'coding' | 'content'
export type SessionTitleSource = 'native' | 'first_user_message' | 'fallback_id'
export type SessionFormat = 'codex' | 'deepseek-harness' | 'unknown'

export interface NormalizedMessage {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'plugin'
  text: string
  time?: number
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
}

export interface NormalizedToolCall {
  id: string
  name: string
  arguments?: unknown
  result?: unknown
  startTime?: number
  endTime?: number
  durationMs?: number
  isError?: boolean
}

export interface NormalizedStep {
  turn: number
  step: number
  startTime?: number
  endTime?: number
  durationMs?: number
  status?: 'completed' | 'unfinished'
}

export interface NormalizedTurn {
  turn: number
  startTime?: number
  endTime?: number
  status?: 'completed' | 'interrupted' | 'failed'
  messages: NormalizedMessage[]
  tools: NormalizedToolCall[]
  steps: NormalizedStep[]
}

export interface NormalizedTrace {
  id: string
  title?: string
  source: { format: Exclude<SessionFormat, 'unknown'>; provider?: string; model?: string; sessionId?: string; importedFileName?: string; contextWindow?: number; models?: Array<{ provider?: string; model: string; time?: number; turn?: number }> }
  createdAt?: number
  cwd?: string
  status: 'completed' | 'interrupted' | 'failed' | 'unknown'
  turns: NormalizedTurn[]
  stats: { inputTokens: number; outputTokens: number; cacheReadTokens: number; toolCalls: number; toolResults: number; userMessages: number; assistantMessages: number; durationMs?: number; ignoredEventCount?: number }
  rawEventCount: number
}

export interface ParseDiagnostics {
  format: SessionFormat
  rawEvents: number
  recognizedEvents: number
  ignoredEvents: number
  malformedLines: number
  turns: number
  messages: number
  toolCalls: number
  warnings: string[]
}

export interface RunRef { source: RunSource; sessionId: string; turnId: string }

export interface SessionDescriptor {
  id: string
  source: RunSource
  parentId: string | null
  projectPath: string | null
  model: string | null
  effort?: string | null
  startedAt: string
  updatedAt: string
  status: SessionStatus
  childCount: number
  turnCount?: number
  latestTurnId?: string | null
  file?: string
  name?: string
  displayTitle?: string
  nativeTitle?: string | null
  titleSource?: SessionTitleSource
  additionalModelCount?: number
  projectName?: string | null
  nativeSessionId?: string | null
  sourceFormat?: SessionFormat
  provider?: string | null
  importedFileName?: string | null
  contextWindow?: number | null
  models?: Array<{ provider?: string; model: string; time?: number; turn?: number }>
}

export interface TurnDescriptor {
  ref: RunRef
  title: string | null
  model: string | null
  effort: string | null
  status: SessionStatus
  startedAt: string
  endedAt: string | null
  durationMs: number
}

export interface PromptFootprintItem {
  category: 'system' | 'developer' | 'skills' | 'tools' | 'permissions' | 'environment' | 'apps' | 'userHistory'
  characters: number
  utf8Bytes: number
  estimatedTokens: number
  known: boolean
}

export interface ObservableMetrics {
  durationMs: number
  ttftMs: number | null
  tokens: { input: number | null; cachedInput: number | null; uncachedInput: number | null; output: number | null; reasoning: number | null; total: number | null }
  context: { peakRatio: number | null; compactions: number; points: Array<{ atMs: number; ratio: number; compacted: boolean }> }
  tools: Array<{ id: string; name: string; label: string; category: string; transport?: 'native' | 'shell' | 'mcp' | 'web' | 'agent'; server?: string; startMs: number; endMs: number; durationMs: number; status: 'success' | 'failed'; args: string; result: string; flags: string[]; recovery: string | null }>
  toolSummary: { total: number; succeeded: number; failed: number; retryCount: number; parallelRate: number | null; concentration: number | null; wallMs: number; cumulativeMs: number }
  agents: { observed: number; ids: string[] }
  trajectory: { repeatedActions: number; mechanicalRetries: number; adaptiveRecoveries: number; loops: number; wasteActionIds: string[]; coverage: number }
  promptFootprint: PromptFootprintItem[]
  harnessActivity: { modelCalls: number; reasoningItems: number; assistantMessages: number; toolDiscoveries: number; webSearches: number; mcpCalls: number; mcpServers: string[]; skillsUsed: string[] }
}

export type SignalSeverity = 'info' | 'low' | 'medium' | 'high'
export type BehavioralSignalType = 'repeated_read' | 'repeated_tool_call' | 'retry' | 'mechanical_retry' | 'adaptive_recovery' | 'loop' | 'backtrack' | 'context_spike' | 'context_reset' | 'compaction' | 'slow_tool' | 'tool_failure' | 'tool_concentration' | 'redundant_step'
export interface BehavioralSignal {
  id: string
  type: BehavioralSignalType
  severity: SignalSeverity
  startStep?: number
  endStep?: number
  evidence: { eventIds?: string[]; callIds?: string[]; toolNames?: string[]; message?: string }
  metrics?: Record<string, number>
}

export type OutcomeStatus = 'success' | 'partial' | 'failed' | 'unknown'
export type OutcomeSource = 'observed' | 'user' | 'experimental_evaluator'
export type OutcomeEvidenceType = 'task_complete' | 'test' | 'build' | 'lint' | 'command' | 'artifact' | 'user_confirmation' | 'other'
export interface OutcomeEvidence { type: OutcomeEvidenceType; status: 'passed' | 'failed' | 'completed' | 'unknown'; label: string; value?: string | number; sourceEventId?: string }
export interface RunOutcome { status: OutcomeStatus; source: OutcomeSource; confidence?: number; note?: string; evidence?: OutcomeEvidence[] }

export interface HarnessIdentity { family: 'codex' | 'claude' | 'claude-code' | 'workbuddy' | 'deepseek-harness' | 'opencode' | 'openclaw' | 'other'; version?: string | null; source?: string | null }
export interface ModelIdentity { provider?: string | null; model: string | null; reasoningEffort?: string | null }
export interface EnvironmentIdentity { os: string | null; cwd: string | null; sandbox: string | null; source: RunSource }

export interface EvalEvidence {
  goal: string | null
  finalOutput: string | null
  validations: Array<{ kind: 'test' | 'build' | 'lint' | 'artifact' | 'other'; label: string; passed: boolean | null; detail: string }>
  artifacts: Array<{ label: string; kind: 'file-change' | 'other' }>
}

export interface EvaluationResult {
  evaluatorId: 'deterministic' | 'manual' | 'llm'
  rubricId: TaskType
  rubricVersion: 1
  status: 'partial' | 'complete' | 'failed'
  dimensions: Array<{ id: string; label: string; score: number | null; weight: number; note?: string }>
  overall: number | null
  notes: string | null
  createdAt: string
}

export interface RunIdentity {
  title: string | null
  model: string | null
  effort: string | null
  projectPath: string | null
  cliVersion: string | null
  startedAt: string
  endedAt: string | null
  status: SessionStatus
  harness: HarnessIdentity
  modelIdentity: ModelIdentity
  environment: EnvironmentIdentity
}

export interface AnalysisCoverage { malformedLines: number; tokenUsageKnown: boolean; promptFootprintKnown: boolean; toolPairingRatio: number; notes: string[] }

export interface RunAnalysis {
  schemaVersion: 1
  ref: RunRef
  identity: RunIdentity
  observable: ObservableMetrics
  evidence: EvalEvidence
  outcome: RunOutcome
  behavioralSignals: BehavioralSignal[]
  evaluation?: EvaluationResult
  coverage: AnalysisCoverage
  /** Compatibility projection consumed by the retained V2 report. */
  v2: Record<string, unknown>
}

export interface SessionSnapshot {
  descriptor: SessionDescriptor
  v2: Record<string, unknown>
  diagnostics: string[]
  runs?: TurnDescriptor[]
  normalized?: NormalizedTrace
  parseDiagnostics?: ParseDiagnostics
}

export interface TaskGroup {
  evalTaskId: string
  title: string
  taskType: TaskType
  confirmedRuns: RunRef[]
  suggestedRuns: RunRef[]
  baselineRun?: RunRef
  createdAt: string
  updatedAt: string
}

export interface SavedImport { snapshot: SessionSnapshot; analyses: RunAnalysis[]; savedAt: string }

export interface RuntimeCondition { field: string; baseline: string | null; candidate: string | null; changed: boolean }
