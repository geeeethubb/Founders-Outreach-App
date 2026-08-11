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
}

export async function startScoutingRun(p: StartRunParams): Promise<{ runId: string | null; migrationMissing: boolean; error?: string }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('scouting_runs')
    .insert({
      user_id: p.userId,
      label: p.label,
      mission: p.mission as never,
      budget: p.budget as never,
      status: 'running',
    })
    .select('id')
    .single()

  if (error) {
    return { runId: null, migrationMissing: isMissingSchema(error.message), error: error.message }
  }
  return { runId: data.id as string, migrationMissing: false }
}

export async function updateScoutingRun(
  runId: string,
  patch: { status?: string; strategy?: unknown; stats?: unknown; error?: string | null; completed?: boolean }
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('scouting_runs')
    .update({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.strategy !== undefined ? { strategy: patch.strategy as never } : {}),
      ...(patch.stats !== undefined ? { stats: patch.stats as never } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.completed ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq('id', runId)

  return error ? { ok: false, error: error.message } : { ok: true }
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
