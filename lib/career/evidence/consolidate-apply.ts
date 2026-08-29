// applyConsolidation — executes a ConsolidationPlan against the database.
//
// Requires migration 015: without it there is nowhere to write a tombstone,
// a snapshot or a suggestion, so the function returns an error result and
// touches nothing. Order of operations, chosen so a crash at any point leaves
// the bank readable and restorable:
//   1. snapshot (full bank incl. tombstones + every 015 table) — abort on failure
//   2. organizations, organization_id / organization_norm / title_norm
//   3. provenance backfill (sources, fact_sources, experience_sources)
//      (2 and 3 run only when opts.backfill !== false — the CLI full run;
//      a single review-tab merge touches nothing beyond its pair)
//   4. the selected merges via planMutations, reloading the bank after every
//      pair so a row tombstoned by one pair is never a target for the next
//      (children first, tombstones last; never a delete)
//   5. open suggestions for POSSIBLE / CONFLICT pairs (unique per pair; never
//      re-opens one the user resolved). Conflict rows are written only by a
//      merge (step 4) or for CONFLICT facts — a POSSIBLE pair's disagreement
//      stays in its suggestion signals.
//   6. canonical summaries for the experiences that changed
// Re-running over an already-consolidated bank is a no-op: tombstones are
// excluded from the plan, suggestions already exist, summaries already match.

import { createServiceClient } from '@/lib/supabase/server'
import type { EvidenceBank, MergeEntityType } from '../types'
import { buildConsolidationPlan, type PairRef } from './consolidate'
import { planMutations, type Mutation } from './consolidate-mutations'
import type { ApplyOptions, ConsolidationPlan, ConsolidationResult, MergeProposal } from './consolidate-types'
import { normalizeOrg, normalizeStatement, normalizeTitle } from './normalize'
import { findOrCreateSource, recordExperienceSources, recordFactSources, sourceKindFor, upsertConflict } from './sources'
import { insertRows, isMissingSchema, loadEvidenceBank, updateRow } from './store'
import { buildCanonicalSummary } from './summary'

type Pair = { entity_type: MergeEntityType; keep_id: string; merge_id: string }

/** Concurrent statement_norm updates per batch in the canonical-key step. */
const NORM_BATCH = 20

function emptyResult(): ConsolidationResult {
  return {
    snapshot_id: null, organizations_created: 0, organizations_updated: 0, statement_norms_backfilled: 0,
    sources_created: 0, fact_sources_created: 0,
    experience_sources_created: 0, merged: [], suggestions_written: 0, conflicts_written: 0,
    summaries_refreshed: 0, skipped: [], errors: [],
  }
}

async function loadFullBank(userId: string): Promise<{ bank: EvidenceBank; canonical: boolean; migrationMissing: boolean }> {
  const { bank, canonical, migrationMissing } = await loadEvidenceBank(userId, { approvedOnly: false, includeTombstones: true })
  return { bank, canonical, migrationMissing }
}

/** Pairs the user marked kept_separate; empty (and `migrationMissing`) before 015. */
export async function loadSuppressedPairs(userId: string): Promise<{ pairs: PairRef[]; migrationMissing: boolean }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('evidence_merge_suggestions')
    .select('entity_type, keep_id, merge_id')
    .eq('user_id', userId)
    .eq('status', 'kept_separate')
  if (error) return { pairs: [], migrationMissing: isMissingSchema(error.message) }
  return { pairs: (data ?? []) as PairRef[], migrationMissing: false }
}

export async function loadOpenSuggestions(userId: string): Promise<{ suggestions: Record<string, unknown>[]; migrationMissing: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('evidence_merge_suggestions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
  if (error) return { suggestions: [], migrationMissing: isMissingSchema(error.message), error: error.message }
  return { suggestions: (data ?? []) as Record<string, unknown>[], migrationMissing: false, error: null }
}

async function writeSnapshot(userId: string, bank: EvidenceBank, reason: string): Promise<{ id: string | null; error: string | null }> {
  const supabase = createServiceClient()
  const extra: Record<string, unknown[]> = {}
  for (const table of ['evidence_merge_suggestions', 'evidence_conflicts']) {
    const { data } = await supabase.from(table).select('*').eq('user_id', userId)
    extra[table] = data ?? []
  }
  const counts: Record<string, number> = {}
  for (const [k, v] of Object.entries(bank)) if (Array.isArray(v)) counts[k] = v.length
  const { data, error } = await supabase
    .from('evidence_snapshots')
    .insert({ user_id: userId, reason, counts, payload: { bank, ...extra } })
    .select('id')
    .single()
  if (error) return { id: null, error: error.message }
  return { id: String(data.id), error: null }
}

async function execute(userId: string, m: Mutation, result: ConsolidationResult): Promise<boolean> {
  if (m.table === 'evidence_conflicts') {
    const v = m.values as { entity_type: 'experience' | 'fact' | 'metric'; entity_id: string; field: string; candidates: { value: string; source_id: string | null; source_label: string }[] }
    const r = await upsertConflict(userId, { entity_type: v.entity_type, entity_id: v.entity_id, field: v.field, candidates: v.candidates })
    if (r.error) { result.errors.push(`conflict ${v.field}: ${r.error}`); return false }
    if (r.created) result.conflicts_written++
    return true
  }
  if (m.table === 'evidence_merge_suggestions') {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('evidence_merge_suggestions')
      .upsert({ ...m.values, resolved_at: new Date().toISOString() } as never, { onConflict: 'user_id,entity_type,keep_id,merge_id' })
    if (error) { result.errors.push(`suggestion: ${error.message}`); return false }
    result.suggestions_written++
    return true
  }
  if (m.op === 'insert') {
    const r = await insertRows(m.table, [{ ...m.values, user_id: userId }])
    if (r.error) { result.errors.push(`${m.table} insert: ${r.error}`); return false }
    return true
  }
  const r = await updateRow(m.table, userId, m.id as string, m.values)
  if (!r.ok) { result.errors.push(`${m.table} ${m.id}: ${r.error}`); return false }
  return true
}

function selectionFor(plan: ConsolidationPlan, opts: ApplyOptions): { chosen: Pair[]; skipped: ConsolidationResult['skipped'] } {
  const all = [...plan.experiences, ...plan.facts, ...plan.metrics]
  const skipped: ConsolidationResult['skipped'] = []
  const chosen: Pair[] = []
  const consider = (p: MergeProposal, explicit: boolean) => {
    if (p.confidence === 'CONFLICT') { skipped.push({ entity_type: p.entity_type, keep_id: p.keep_id, merge_id: p.merge_id, reason: 'CONFLICT pairs are never merged' }); return }
    if (p.confidence === 'POSSIBLE' && !(explicit && opts.allowPossible)) {
      skipped.push({ entity_type: p.entity_type, keep_id: p.keep_id, merge_id: p.merge_id, reason: explicit ? 'POSSIBLE needs allowPossible' : 'POSSIBLE — user decides' })
      return
    }
    chosen.push({ entity_type: p.entity_type, keep_id: p.keep_id, merge_id: p.merge_id })
  }
  if (opts.only?.length) {
    for (const o of opts.only) {
      const p = all.find((x) => x.entity_type === o.entity_type && x.keep_id === o.keep_id && x.merge_id === o.merge_id)
      if (!p) skipped.push({ ...o, reason: 'not in the plan' })
      else consider(p, true)
    }
  } else {
    for (const p of all) consider(p, false)
  }
  return { chosen, skipped }
}

export async function applyConsolidation(userId: string, plan: ConsolidationPlan, opts: ApplyOptions = {}): Promise<ConsolidationResult> {
  const result = emptyResult()
  const loaded = await loadFullBank(userId)
  if (loaded.migrationMissing) { result.errors.push('migration 014_career_os.sql has not been applied'); return result }
  if (!loaded.canonical) { result.errors.push('migration 015_evidence_canonical.sql has not been applied — nothing written'); return result }
  let bank = loaded.bank

  // 1. Snapshot first; nothing is written without one.
  if (!opts.skipSnapshot) {
    const snap = await writeSnapshot(userId, bank, opts.reason ?? 'consolidation')
    if (snap.error) { result.errors.push(`snapshot failed, aborting: ${snap.error}`); return result }
    result.snapshot_id = snap.id
  }

  const supabase = createServiceClient()
  if (opts.backfill !== false) {
  // 2. Organizations and canonical keys.
  const orgIdByKey = new Map<string, string>(bank.organizations.map((o) => [o.normalized_name, o.id]))
  for (const o of plan.organizations) {
    let id = o.existing_id ?? orgIdByKey.get(o.normalized_name) ?? null
    if (!id) {
      const ins = await insertRows('evidence_organizations', [{
        user_id: userId, canonical_name: o.canonical_name, normalized_name: o.normalized_name,
        aliases: o.aliases, kind: o.kind,
      }])
      if (ins.error) { result.errors.push(`organization ${o.canonical_name}: ${ins.error}`); continue }
      id = ins.ids[0]
      result.organizations_created++
    } else {
      // An existing organization learns new aliases and follows the kind
      // heuristic when it now says something else (an award-only org is
      // 'other', "Startup School" is a program). Nothing else is touched.
      const existing = bank.organizations.find((x) => x.id === id)
      if (existing) {
        const aliases = [...new Set([...(existing.aliases ?? []), ...o.aliases])].sort()
        const patch: Record<string, unknown> = {}
        if (aliases.length !== (existing.aliases ?? []).length) patch.aliases = aliases
        if (existing.kind !== o.kind) patch.kind = o.kind
        if (Object.keys(patch).length) {
          const r = await updateRow('evidence_organizations', userId, id, patch)
          if (r.ok) result.organizations_updated++
          else result.errors.push(`organization ${o.canonical_name}: ${r.error}`)
        }
      }
    }
    orgIdByKey.set(o.normalized_name, id)
    for (const eid of o.experience_ids) {
      const e = bank.experiences.find((x) => x.id === eid)
      if (!e) continue
      const patch: Record<string, unknown> = {}
      if (e.organization_id !== id) patch.organization_id = id
      if (e.organization_norm !== o.normalized_name) patch.organization_norm = o.normalized_name
      const tn = normalizeTitle(e.title)
      if (e.title_norm !== tn) patch.title_norm = tn
      if (Object.keys(patch).length) await updateRow('evidence_experiences', userId, eid, patch)
    }
  }
  // Facts get the same canonical-key treatment: statement_norm where it is
  // still null (rows written before 015, or through a 014-tolerant insert).
  // Only null rows, in small concurrent batches; never a rewrite.
  const missingNorm = bank.facts.filter((f) => f.statement_norm === null || f.statement_norm === undefined)
  for (let i = 0; i < missingNorm.length; i += NORM_BATCH) {
    const batch = missingNorm.slice(i, i + NORM_BATCH)
    const results = await Promise.all(batch.map((f) => updateRow('evidence_facts', userId, f.id, { statement_norm: normalizeStatement(f.statement) })))
    results.forEach((r, j) => {
      if (r.ok) result.statement_norms_backfilled++
      else result.errors.push(`statement_norm ${batch[j].id}: ${r.error}`)
    })
  }

  // 3. Provenance backfill.
  const sourceIds = new Map<string, string>()
  const sourceFor = async (label: string, kind: string): Promise<string | null> => {
    const k = `${kind}:${label}`
    if (sourceIds.has(k)) return sourceIds.get(k) as string
    const h = await findOrCreateSource(userId, { kind: kind as never, label })
    if (h.error || !h.id) { result.errors.push(`source ${label}: ${h.error}`); return null }
    if (h.created) result.sources_created++
    sourceIds.set(k, h.id)
    return h.id
  }
  for (const f of plan.provenance.facts_missing_provenance) {
    const fact = bank.facts.find((x) => x.id === f.fact_id)
    if (!fact) continue
    const sid = await sourceFor(f.source, sourceKindFor(fact.source))
    if (!sid) continue
    const r = await recordFactSources(userId, [{ fact_id: f.fact_id, source_id: sid, location: f.source_location, quote: fact.statement }])
    result.fact_sources_created += r.created
    if (r.error) result.errors.push(`fact_sources: ${r.error}`)
  }
  for (const e of plan.provenance.experiences_missing_provenance) {
    const exp = bank.experiences.find((x) => x.id === e.experience_id)
    if (!exp) continue
    const sid = await sourceFor(e.source, sourceKindFor(e.source))
    if (!sid) continue
    const r = await recordExperienceSources(userId, [{
      experience_id: e.experience_id, source_id: sid, title_as_written: exp.title,
      dates_as_written: [exp.start_date, exp.end_date].filter(Boolean).join(' – ') || null,
    }])
    result.experience_sources_created += r.created
    if (r.error) result.errors.push(`experience_sources: ${r.error}`)
  }
  }

  // 4. Merges — each pair against a bank reloaded after the previous one, so a
  // row tombstoned earlier in this run is seen as merged (planMutations then
  // emits nothing and the pair is skipped) rather than re-pointed onto.
  const { chosen, skipped } = selectionFor(plan, opts)
  result.skipped.push(...skipped)
  for (const pair of chosen) {
    bank = (await loadFullBank(userId)).bank
    const mutations = planMutations(plan, bank, [pair])
    if (mutations.length === 0) { result.skipped.push({ ...pair, reason: 'already merged (possibly earlier in this run) or rows missing' }); continue }
    let ok = true
    let repointed = 0
    for (const m of mutations) {
      if (!(await execute(userId, m, result))) { ok = false; break }
      if (m.kind === 'repoint') repointed++
    }
    if (ok) result.merged.push({ ...pair, repointed })
    else result.skipped.push({ ...pair, reason: 'write failed part-way; see errors and the snapshot' })
  }

  // 5. Open suggestions for what a human must decide.
  const { data: existingRows } = await supabase.from('evidence_merge_suggestions').select('entity_type, keep_id, merge_id, status').eq('user_id', userId)
  const existing = new Map((existingRows ?? []).map((r: { entity_type: string; keep_id: string; merge_id: string; status: string }) => [`${r.entity_type}:${r.keep_id}:${r.merge_id}`, r.status]))
  for (const p of [...plan.experiences, ...plan.facts, ...plan.metrics]) {
    if (p.confidence === 'HIGH') continue
    if (existing.has(`${p.entity_type}:${p.keep_id}:${p.merge_id}`)) continue
    if (existing.has(`${p.entity_type}:${p.merge_id}:${p.keep_id}`)) continue
    const ins = await insertRows('evidence_merge_suggestions', [{
      user_id: userId, entity_type: p.entity_type, keep_id: p.keep_id, merge_id: p.merge_id, confidence: p.confidence,
      rule: p.rule, signals: p.signals, why: p.why, data_preserved: p.data_preserved, risk: p.risk, status: 'open',
    }])
    if (ins.error) result.errors.push(`suggestion: ${ins.error}`)
    else result.suggestions_written++
    // Only CONFLICT facts get a conflict row here (two numbers for one claim,
    // both rows kept). A POSSIBLE experience pair's title/date disagreement
    // is not a conflict on the keep row — the rows are still separate.
    if (p.confidence !== 'CONFLICT') continue
    for (const c of p.conflicts) {
      const r = await upsertConflict(userId, c)
      if (r.created) result.conflicts_written++
    }
  }

  // 6. Summaries.
  bank = (await loadFullBank(userId)).bank
  const affected = new Set<string>(plan.summaries.map((s) => s.experience_id))
  for (const m of result.merged) {
    if (m.entity_type === 'experience') affected.add(m.keep_id)
    if (m.entity_type === 'fact') { const f = bank.facts.find((x) => x.id === m.keep_id); if (f?.experience_id) affected.add(f.experience_id) }
  }
  for (const id of affected) {
    const e = bank.experiences.find((x) => x.id === id)
    if (!e || e.status === 'merged' || e.edited_by_user) continue
    const { summary, fact_ids } = buildCanonicalSummary(bank, id)
    if (summary === (e.canonical_summary ?? '') && JSON.stringify(fact_ids) === JSON.stringify(e.summary_fact_ids ?? [])) continue
    const r = await updateRow('evidence_experiences', userId, id, { canonical_summary: summary || null, summary_fact_ids: fact_ids })
    if (r.ok) result.summaries_refreshed++
    else result.errors.push(`summary ${id}: ${r.error}`)
  }
  return result
}

// ─── Review-tab entry points ─────────────────────────────────────────────────

export async function mergePair(
  userId: string, entity_type: MergeEntityType, keep_id: string, merge_id: string, opts: { allowPossible?: boolean } = {}
): Promise<ConsolidationResult> {
  const { bank, canonical } = await loadFullBank(userId)
  if (!canonical) { const r = emptyResult(); r.errors.push('migration 015_evidence_canonical.sql has not been applied'); return r }
  const { pairs } = await loadSuppressedPairs(userId)
  const plan = buildConsolidationPlan(bank, { suppressed: pairs, migration015: true })
  return applyConsolidation(userId, plan, { only: [{ entity_type, keep_id, merge_id }], allowPossible: opts.allowPossible, backfill: false, reason: `merge ${entity_type} ${merge_id} → ${keep_id}` })
}

export async function keepSeparate(userId: string, pair: Pair): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('evidence_merge_suggestions').upsert({
    user_id: userId, entity_type: pair.entity_type, keep_id: pair.keep_id, merge_id: pair.merge_id,
    confidence: 'POSSIBLE', rule: 'user', status: 'kept_separate', resolved_at: new Date().toISOString(),
  } as never, { onConflict: 'user_id,entity_type,keep_id,merge_id' })
  return { ok: !error, error: error?.message ?? null }
}

const EXPERIENCE_FIELDS = new Set(['title', 'start_date', 'end_date', 'location'])

export async function resolveConflict(userId: string, conflictId: string, value: string | 'keep_both'): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.from('evidence_conflicts').select('*').eq('id', conflictId).eq('user_id', userId).maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? 'conflict not found' }
  const c = data as { entity_type: string; entity_id: string; field: string; candidates?: { value: string }[] }
  if (value !== 'keep_both') {
    const allowed = (c.candidates ?? []).map((x) => x.value)
    if (!allowed.includes(value)) return { ok: false, error: `value is not one of the recorded candidates: ${allowed.join(' | ')}` }
    if (c.entity_type === 'experience' && EXPERIENCE_FIELDS.has(c.field)) {
      const r = await updateRow('evidence_experiences', userId, c.entity_id, { [c.field]: value, edited_by_user: true })
      if (!r.ok) return r
    } else if (c.entity_type === 'fact' && c.field === 'value') {
      const r = await updateRow('evidence_facts', userId, c.entity_id, { statement: value, edited_by_user: true })
      if (!r.ok) return r
    }
  }
  const r = await updateRow('evidence_conflicts', userId, conflictId, { status: 'resolved', resolution: value, resolved_at: new Date().toISOString() })
  return r
}

export { normalizeOrg }
