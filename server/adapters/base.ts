import type { RunAnalysis, RunSource, SessionDescriptor, SessionSnapshot, TurnDescriptor } from '../types.js'

export interface AdapterDetectionResult {
  status: 'ready' | 'not_found' | 'error'
  sessionCount: number
  path: string
  error?: string
}

export interface AgentAdapter {
  readonly source: RunSource
  readonly label: string
  readonly defaultRoot: string
  customRoot?: string
  readonly root: string

  detect(): Promise<AdapterDetectionResult>
  discover(force?: boolean): Promise<SessionDescriptor[]>
  snapshot(id: string): Promise<SessionSnapshot>
  turns(id: string): Promise<TurnDescriptor[]>
  run(sessionId: string, turnId: string): Promise<RunAnalysis>
}
