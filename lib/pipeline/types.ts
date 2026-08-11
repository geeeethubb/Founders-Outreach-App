// Pipeline run and task state.
//
// Runs are durable Postgres rows advanced by an idempotent worker tick — not
// long HTTP handlers, not an external queue. See docs/ARCHITECTURE.md ADR-005
// and docs/PIPELINE.md. Scaffolding only; the runner lands in Phase 4.

// ─── Stages ──────────────────────────────────────────────────────────────────

export type PipelineStage =
  | 'opportunity_strategy'
  | 'company_discovery'
  | 'company_ranking'
  | 'people_discovery'
  | 'people_ranking'
  | 'research'
  | 'positioning'
  | 'outreach'
  | 'quality_control'
  | 'human_approval'
  | 'send'
  | 'response_tracking'
  | 'learning'

/** Execution order. A run advances to N+1 only when stage N has no open tasks. */
export const PIPELINE_STAGES: PipelineStage[] = [
  'opportunity_strategy',
  'company_discovery',
  'company_ranking',
  'people_discovery',
  'people_ranking',
  'research',
  'positioning',
  'outreach',
  'quality_control',
  'human_approval',
  'send',
  'response_tracking',
  'learning',
]

export const STAGE_LABELS: Record<PipelineStage, string> = {
  opportunity_strategy: 'Opportunity Strategy',
  company_discovery: 'Company Discovery',
  company_ranking: 'Company Ranking',
  people_discovery: 'People Discovery',
  people_ranking: 'People Ranking',
  research: 'Research',
  positioning: 'Positioning',
  outreach: 'Outreach',
  quality_control: 'Quality Control',
  human_approval: 'Human Approval',
  send: 'Send',
  response_tracking: 'Response Tracking',
  learning: 'Learning',
}

/**
 * Stages 6–9 are per-person and safe to run concurrently across targets.
 * Stages 1–5 are ordered because each consumes the previous stage's full output.
 */
export const CONCURRENT_STAGES: PipelineStage[] = [
  'research',
  'positioning',
  'outreach',
  'quality_control',
]

// ─── Run state ───────────────────────────────────────────────────────────────

export type RunStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'awaiting_approval'   // the normal, intended stop
  | 'awaiting_input'      // discovery found nothing usable
  | 'sending'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'

export interface PipelineRun {
  id: string
  user_id: string
  mission_id: string
  status: RunStatus
  current_stage: PipelineStage | null
  stage_state: Record<string, StageProgress>
  error: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface StageProgress {
  total: number
  succeeded: number
  failed: number
  skipped: number
}

// ─── Task state ──────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'skipped'             // a SUCCESS: the pipeline deliberately declined this target

export type TaskTargetType = 'company' | 'person' | 'draft' | null

export interface PipelineTask {
  id: string
  run_id: string
  stage: PipelineStage
  target_type: TaskTargetType
  target_id: string | null
  status: TaskStatus
  attempts: number
  max_attempts: number
  /** Lease expiry. An expired lease returns the task to `pending` — this is how
   *  the system recovers from a crashed or timed-out worker with no supervisor. */
  lease_until: string | null
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  skipped_reason: string | null
  created_at: string
  updated_at: string
}

/** A task is finished when it will never run again, whatever the outcome. */
export const TERMINAL_TASK_STATUSES: TaskStatus[] = [
  'succeeded',
  'failed_permanent',
  'skipped',
]

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export interface TickOptions {
  run_id?: string        // omit to service any active run
  max_tasks?: number     // batch size per tick
  lease_seconds?: number
}

export interface TickResult {
  claimed: number
  succeeded: number
  failed: number
  skipped: number
  stage_advanced: boolean
  run_status: RunStatus | null
}

/**
 * Exponential backoff with jitter, for `failed_retryable` tasks.
 * Jitter prevents a provider outage from producing a synchronized retry stampede
 * when many tasks fail at the same instant.
 */
export function retryDelaySeconds(attempt: number): number {
  const base = Math.min(300, 10 * Math.pow(2, attempt))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}
