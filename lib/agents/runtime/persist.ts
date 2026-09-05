// Persists agent traces, scouting run state, and grounded research facts.
//
// DEGRADES GRACEFULLY: if migration 011 has not been applied, every write
// reports `migrationMissing` instead of throwing. Migrations here are applied by
// hand (see CLAUDE.md), so the pipeline must not hard-depend on schema the
// operator may not have run yet — same contract as lib/scouting/persist.ts.

import { createServiceClient } from '@/lib/supabase/server'
import type { AgentResult } from './types'
import type { ResearchClaim } from '@/lib/research/types'

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache/i.test(message)
}

// ─── Scouting runs ───────────────────────────────────────────────────────────

export interface StartRunParams {
  userId: string
  label: string
  mission: unknown
  budget: unknown
  /**
   * Which product this run belongs to (migration 014). Set IN THE INSERT: a
   * row inserted with the column default and re-labelled a moment later is,
   * for that moment, a running run of the wrong kind — which is how an inline
   * package run once looked like an active People Scout.
   */
  kind?: string
}

export async function startScoutingRun(p: StartRunParams): Promise<{ runId: string | null; migrationMissing: boolean; error?: string }> {
  const supabase = createServiceClient()
  const insert = async (withKind: boolean) =>
    supabase
      .from('scouting_runs')
      .insert({
        user_id: p.userId,
        label: p.label,
        mission: p.mission as never,
        budget: p.budget as never,
        status: 'running',
        ...(withKind && p.kind ? { kind: p.kind } : {}),
      } as never)
      .select('id')
      .single()

  let { data, error } = await insert(true)
  // A database predating migration 014 has no `kind`; the run still exists.
  if (error && p.kind && /column .* does not exist|schema cache/i.test(error.message)) ({ data, error } = await insert(false))
  if (error) {
    return { runId: null, migrationMissing: isMissingSchema(error.message), error: error.message }
  }
  return { runId: (data as { id: string }).id, migrationMissing: false }
}

/**
 * A FENCE for writers that belong to one worker invocation.
 *
 * A durable run can be executed by several invocations in turn (a leg hands
 * the row back to the queue at its deadline and the next worker claims it).
 * A late write from an earlier leg — a finish that lands after the platform
 * has already frozen and thawed it, a queued heartbeat — must not touch the
 * row the next leg now owns. Passing the worker id the leg was claimed with
 * makes the write match nothing once the row has moved on.
 */
export interface RunWriteGuard {
  workerId?: string | null
  /** Only rows in one of these statuses are written. */
  statuses?: string[]
}

export async function updateScoutingRun(
  runId: string,
  patch: {
    status?: string
    strategy?: unknown
    stats?: unknown
    error?: string | null
    completed?: boolean
    /** Migration 013. Which sources this run was allowed to use. */
    searchMode?: string
    /** Migration 013. Why external discovery did or did not run. */
    internalDecision?: unknown
  },
  guard: RunWriteGuard = {}
): Promise<{ ok: boolean; matched?: boolean; error?: string }> {
  const supabase = createServiceClient()
  let q = supabase
    .from('scouting_runs')
    .update({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.strategy !== undefined ? { strategy: patch.strategy as never } : {}),
      ...(patch.stats !== undefined ? { stats: patch.stats as never } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.searchMode !== undefined ? { search_mode: patch.searchMode } : {}),
      ...(patch.internalDecision !== undefined ? { internal_decision: patch.internalDecision as never } : {}),
      ...(patch.completed ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq('id', runId)
  if (guard.workerId) q = q.eq('worker_id', guard.workerId)
  if (guard.statuses && guard.statuses.length) q = q.in('status', guard.statuses)
  const { data, error } = await q.select('id')

  // A run predating migration 013 must still be updatable. The columns are
  // additive, so a missing one degrades to "the decision was not recorded"
  // rather than to a failed run.
  if (error && /column .* does not exist|schema cache/i.test(error.message) && (patch.searchMode !== undefined || patch.internalDecision !== undefined)) {
    const { searchMode: _a, internalDecision: _b, ...rest } = patch
    if (Object.keys(rest).length === 0) return { ok: true }
    return updateScoutingRun(runId, rest, guard)
  }

  if (error) return { ok: false, error: error.message }
  // A guarded write that matched nothing is not an error, but the caller must
  // know: the row has moved on to another worker or a terminal state.
  const matched = (data?.length ?? 0) > 0
  return { ok: matched || (!guard.workerId && !guard.statuses), matched }
}

// ─── Agent runs ──────────────────────────────────────────────────────────────

/**
 * Records one agent invocation. `input_refs` holds ROW IDS, never payloads —
 * a trace that is expensive to write is a trace that eventually is not written.
 */
export async function recordAgentRun<T>(
  userId: string,
  runId: string | null,
  result: AgentResult<T>,
  opts: { inputRefs?: Record<string, unknown>; output?: unknown } = {}
): Promise<{ agentRunId: string | null; migrationMissing: boolean; error?: string }> {
  const supabase = createServiceClient()
  const t = result.trace

  const { data, error } = await supabase
    .from('agent_runs')
    .insert({
      user_id: userId,
      run_id: runId,
      agent_id: t.agent_id,
      prompt_version: t.prompt_version,
      model: t.model,
      model_role: t.model_role,
      provider_id: t.provider_id,
      status: result.status,
      input_refs: (opts.inputRefs ?? {}) as never,
      output: (opts.output ?? result.output) as never,
      tools_called: t.tools_called as never,
      tokens_in: t.tokens_in,
      tokens_out: t.tokens_out,
      cost_usd: Number(t.cost_usd.toFixed(6)),
      latency_ms: t.latency_ms,
      error: result.error,
    })
    .select('id')
    .single()

  if (error) {
    return { agentRunId: null, migrationMissing: isMissingSchema(error.message), error: error.message }
  }
  return { agentRunId: data.id as string, migrationMissing: false }
}

// ─── Research facts ──────────────────────────────────────────────────────────

export interface PersistFactsParams {
  userId: string
  runId: string | null
  companyId?: string | null
  contactId?: string | null
  subjectLabel: string
  agentRunId?: string | null
  claims: ResearchClaim[]
}

/**
 * Writes claims. A FACT without a source_url is rejected by a DB CHECK
 * constraint, so this is where grounding stops being advisory. We do not
 * pre-filter those rows away: a rejection is a signal worth surfacing.
 */
export async function persistResearchFacts(
  p: PersistFactsParams
): Promise<{ inserted: number; rejected: number; migrationMissing: boolean; errors: string[] }> {
  if (p.claims.length === 0) return { inserted: 0, rejected: 0, migrationMissing: false, errors: [] }

  const supabase = createServiceClient()
  const rows = p.claims.map((c) => ({
    user_id: p.userId,
    run_id: p.runId,
    company_id: p.companyId ?? null,
    contact_id: p.contactId ?? null,
    subject_label: p.subjectLabel,
    claim: c.claim,
    type: c.type,
    source_url: c.source_url ?? null,
    source_title: c.source_title ?? null,
    confidence: c.confidence ?? null,
    relevance: c.relevance ?? null,
    agent_run_id: p.agentRunId ?? null,
  }))

  const { data, error } = await supabase.from('research_facts').insert(rows).select('id')

  if (error) {
    if (isMissingSchema(error.message)) {
      return { inserted: 0, rejected: 0, migrationMissing: true, errors: [error.message] }
    }
    // A constraint violation kills the whole batch, so retry row by row to find
    // out exactly which claims were unsourceable rather than losing all of them.
    let inserted = 0
    let rejected = 0
    const errors: string[] = []
    for (const row of rows) {
      const { error: rowErr } = await supabase.from('research_facts').insert(row)
      if (rowErr) {
        rejected++
        if (errors.length < 5) errors.push(`${row.claim.slice(0, 60)}: ${rowErr.message.slice(0, 90)}`)
      } else {
        inserted++
      }
    }
    return { inserted, rejected, migrationMissing: false, errors }
  }

  return { inserted: data?.length ?? rows.length, rejected: 0, migrationMissing: false, errors: [] }
}
