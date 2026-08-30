import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema, loadEvidenceBank } from '@/lib/career/evidence/store'
import { buildConsolidationPlan } from '@/lib/career/evidence/consolidate'
import {
  applyConsolidation, keepSeparate, loadSuppressedPairs, mergePair, resolveConflict,
} from '@/lib/career/evidence/consolidate-apply'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { guardPlan } from './guard'
import type { EvidenceBank, EvidenceConflict, MergeConfidence, MergeEntityType } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

const MIGRATION_015_MESSAGE = 'Apply supabase/migrations/015_evidence_canonical.sql in the Supabase SQL editor first'

const ENTITY_TYPES: MergeEntityType[] = ['experience', 'fact', 'metric', 'project']
const ACTIONS = ['merge', 'keep_separate', 'merge_all_high', 'resolve_conflict'] as const
type Action = (typeof ACTIONS)[number]
const CONFIDENCES: MergeConfidence[] = ['HIGH', 'POSSIBLE', 'CONFLICT']

interface ReviewBody {
  action: Action
  pair?: { entity_type: MergeEntityType; keep_id: string; merge_id: string }
  /** keep_separate: the proposal's confidence/rule, so the audit row keeps why the pair was proposed. */
  confidence?: MergeConfidence
  rule?: string
  allowPossible?: boolean
  conflict_id?: string
  value?: string
}

/** Hand validation in the repo's style (no Zod in package.json). */
function parseBody(raw: unknown): { body: ReviewBody } | { error: string } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const action = String(b.action ?? '') as Action
  if (!ACTIONS.includes(action)) return { error: `action must be one of ${ACTIONS.join(', ')}` }
  const body: ReviewBody = { action, allowPossible: b.allowPossible === true }
  if (action === 'merge' || action === 'keep_separate') {
    const p = (b.pair && typeof b.pair === 'object' ? b.pair : {}) as Record<string, unknown>
    const entity_type = String(p.entity_type ?? '') as MergeEntityType
    if (!ENTITY_TYPES.includes(entity_type)) return { error: 'pair.entity_type is invalid' }
    if (typeof p.keep_id !== 'string' || !p.keep_id || typeof p.merge_id !== 'string' || !p.merge_id) return { error: 'pair.keep_id and pair.merge_id are required' }
    if (p.keep_id === p.merge_id) return { error: 'pair.keep_id and pair.merge_id must differ' }
    body.pair = { entity_type, keep_id: p.keep_id, merge_id: p.merge_id }
    if (typeof b.confidence === 'string' && CONFIDENCES.includes(b.confidence as MergeConfidence)) body.confidence = b.confidence as MergeConfidence
    if (typeof b.rule === 'string' && b.rule.trim()) body.rule = b.rule.trim().slice(0, 80)
  }
  if (action === 'resolve_conflict') {
    if (typeof b.conflict_id !== 'string' || !b.conflict_id) return { error: 'conflict_id is required' }
    if (typeof b.value !== 'string' || !b.value) return { error: 'value is required ("keep_both" or one candidate value)' }
    body.conflict_id = b.conflict_id
    body.value = b.value
  }
  return { body }
}

/**
 * Keep-separate that preserves the audit trail: an existing suggestion row
 * only changes status/resolved_at (its confidence/rule say why the engine
 * proposed the pair); a new row is stamped with the proposal's confidence and
 * rule when the tab sends them.
 * TODO(wave2): move into consolidate-apply.keepSeparate, which today always writes POSSIBLE/user.
 */
async function keepSeparatePreservingAudit(userId: string, body: ReviewBody): Promise<{ ok: boolean; error: string | null }> {
  const pair = body.pair!
  const supabase = createServiceClient()
  const key = { user_id: userId, entity_type: pair.entity_type, keep_id: pair.keep_id, merge_id: pair.merge_id }
  const { data: existing, error: findError } = await supabase
    .from('evidence_merge_suggestions').select('id').match(key).maybeSingle()
  if (findError) return { ok: false, error: findError.message }
  const resolved_at = new Date().toISOString()
  if (existing) {
    const { error } = await supabase.from('evidence_merge_suggestions')
      .update({ status: 'kept_separate', resolved_at } as never).eq('id', (existing as { id: string }).id).eq('user_id', userId)
    return { ok: !error, error: error?.message ?? null }
  }
  const r = await keepSeparate(userId, pair)
  if (!r.ok || (!body.confidence && !body.rule)) return r
  const patch: Record<string, string> = {}
  if (body.confidence) patch.confidence = body.confidence
  if (body.rule) patch.rule = body.rule
  const { error } = await supabase.from('evidence_merge_suggestions').update(patch as never).match(key)
  return { ok: !error, error: error?.message ?? null }
}

async function loadOpenConflicts(userId: string): Promise<{ conflicts: EvidenceConflict[]; migrationMissing: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('evidence_conflicts')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
  if (error) return { conflicts: [], migrationMissing: isMissingSchema(error.message), error: error.message }
  return { conflicts: (data ?? []) as EvidenceConflict[], migrationMissing: false, error: null }
}

/** A conflict names a row by UUID; the card should name the thing. Bank is loaded with tombstones, so a merged row still resolves. */
function labelEntity(bank: EvidenceBank, c: EvidenceConflict): string | null {
  if (c.entity_type === 'experience') {
    const e = bank.experiences.find((x) => x.id === c.entity_id)
    return e ? `${e.title} — ${e.organization}` : null
  }
  if (c.entity_type === 'fact') return bank.facts.find((x) => x.id === c.entity_id)?.statement ?? null
  const m = bank.metrics.find((x) => x.id === c.entity_id)
  return m ? [m.value, m.context].filter(Boolean).join(' ') : null
}

/** The plan over the live bank, plus the open conflict rows. Read-only; safe before 015. */
export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { bank, migrationMissing, canonical, errors } = await loadEvidenceBank(user.id, { approvedOnly: false, includeTombstones: true })
    if (migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true, migration015: false }, { status: 409 })
    }
    const suppressed = canonical ? (await loadSuppressedPairs(user.id)).pairs : []
    const plan = guardPlan(buildConsolidationPlan(bank, { suppressed, migration015: canonical }), bank)
    const conflictRows = canonical ? await loadOpenConflicts(user.id) : { conflicts: [], migrationMissing: false, error: null }
    if (conflictRows.error && !conflictRows.migrationMissing) errors.push(`evidence_conflicts: ${conflictRows.error.slice(0, 120)}`)
    const conflicts = conflictRows.conflicts.map((c) => ({ ...c, entity_label: labelEntity(bank, c) }))

    return NextResponse.json({
      migration015: canonical,
      migrationMissing: false,
      generated_at: plan.generated_at,
      summary: plan.summary,
      suggestions: [...plan.experiences, ...plan.facts, ...plan.metrics],
      planConflicts: plan.conflicts,
      conflicts,
      suppressed: plan.suppressed,
      warnings: plan.warnings,
      errors,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to build review' }, { status: 500 })
  }
}

/**
 * One review action. Every write needs migration 015 (tombstones, suggestions,
 * conflicts live there), so a 014-only database gets a 400 with the message
 * the banner shows. CONFLICT proposals never merge here: `mergePair` skips
 * them and `applyConsolidation` only takes HIGH.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const parsed = parseBody(await request.json().catch(() => ({})))
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { body } = parsed

    const { bank, migrationMissing, canonical } = await loadEvidenceBank(user.id, { approvedOnly: false, includeTombstones: true })
    if (migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true }, { status: 409 })
    if (!canonical) return NextResponse.json({ error: MIGRATION_015_MESSAGE, migration015: false }, { status: 400 })

    if (body.action === 'merge' && body.pair) {
      const result = await mergePair(user.id, body.pair.entity_type, body.pair.keep_id, body.pair.merge_id, { allowPossible: body.allowPossible })
      return NextResponse.json({ result }, { status: result.errors.length && result.merged.length === 0 ? 500 : 200 })
    }
    if (body.action === 'keep_separate' && body.pair) {
      const r = await keepSeparatePreservingAudit(user.id, body)
      if (!r.ok) return NextResponse.json({ error: r.error ?? 'keep separate failed' }, { status: isMissingSchema(r.error ?? '') ? 400 : 500 })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'merge_all_high') {
      const { pairs } = await loadSuppressedPairs(user.id)
      // guardPlan demotes the HIGH pairs no unattended run may apply (edited rows, ambiguous qualifiers).
      const plan = guardPlan(buildConsolidationPlan(bank, { suppressed: pairs, migration015: true }), bank)
      const result = await applyConsolidation(user.id, plan, { backfill: false, reason: 'review tab: merge all high-confidence' })
      return NextResponse.json({ result }, { status: result.errors.length && result.merged.length === 0 ? 500 : 200 })
    }
    if (body.action === 'resolve_conflict' && body.conflict_id && body.value) {
      const r = await resolveConflict(user.id, body.conflict_id, body.value)
      if (!r.ok) return NextResponse.json({ error: r.error ?? 'resolve failed' }, { status: /not one of|not found/.test(r.error ?? '') ? 400 : 500 })
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Review action failed' }, { status: 500 })
  }
}
