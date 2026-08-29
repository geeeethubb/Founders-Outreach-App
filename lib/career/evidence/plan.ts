// Deciding what a proposal adds to the bank — before anything is written.
//
// persistProposal used to decide row by row while inserting, which made the
// matching untestable without a database and made "why did that become a
// second row?" a question only the production bank could answer. The plan is
// a pure function of (bank, proposal): every reuse, every insert, every
// near-miss it declined to merge, and every source it would otherwise have
// dropped on the floor. persistProposal executes it; the tests read it.
//
// Rules, in the order they are tried, for an experience:
//   1. same experienceKey (normalized org + title) as a bank row  → reuse
//   2. same normalized org, title similarity ≥ 0.6, dates compatible → reuse
//   3. same normalized org, similarity in [0.3, 0.6)                 → INSERT,
//      and report it as a near-miss. Never guess; the founder merges by hand.
// A second proposal block with the key of one already queued folds into it,
// so one import cannot create two rows of one job.

import type { EvidenceBank } from '../types'
import type { ImportProposal } from './import'
import {
  datesCompatible,
  experienceKey,
  normalizeMetricValue,
  normalizeOrg,
  normalizeStatement,
  titleSimilarity,
} from './normalize'

export const SIMILAR_TITLE_THRESHOLD = 0.6
export const NEAR_MISS_THRESHOLD = 0.3

export type MatchRule = 'exact' | 'alias' | 'similar_title'

export interface MatchedExperience {
  proposed: string
  existingId: string
  rule: 'alias' | 'similar_title'
}

export interface NearMiss {
  proposed: string
  candidateId: string
  candidate: string
  similarity: number
}

export interface Corroboration {
  factId: string
  source: string
  source_location: string | null
}

export type ExperienceDecision =
  | { action: 'insert'; key: string }
  | { action: 'reuse'; key: string; existingId: string; rule: MatchRule }
  /** Same key as an earlier block of this proposal; resolves to whatever that one became. */
  | { action: 'collapse'; key: string; intoKey: string }

export type FactDecision =
  | { action: 'insert' }
  | { action: 'reuse'; existingId: string }
  /** Same statement as an earlier fact of this proposal, under the same experience. */
  | { action: 'collapse'; intoIndex: number; corroborates: boolean }

export interface PersistPlan {
  /** Index-aligned with proposal.experiences. */
  experiences: ExperienceDecision[]
  /** Index-aligned with proposal.facts. */
  facts: FactDecision[]
  /** Index-aligned with proposal.metrics / proposal.deliverables: true = insert. */
  metrics: boolean[]
  deliverables: boolean[]
  matched: MatchedExperience[]
  nearMisses: NearMiss[]
  /** Facts reused from the bank whose incoming source differs from the stored one. */
  corroborated: Corroboration[]
}

export interface ExperienceLike {
  id: string
  organization: string
  title: string
  start_date: string | null
  end_date: string | null
}

export interface ProposedExperienceLike {
  organization: string
  title: string
  start_date: string | null
  end_date: string | null
}

/**
 * The bank row a proposed experience IS, if any. Exact key first; then a
 * same-org row with a similar enough title. Either way the dates must not
 * contradict — two P&G internships in different summers stay two rows.
 */
export function findExperienceMatch(
  rows: ExperienceLike[],
  proposed: ProposedExperienceLike,
  opts: { allowSimilar?: boolean } = {}
): { match: { id: string; rule: MatchRule } | null; nearMiss: NearMiss | null } {
  const key = experienceKey(proposed.organization, proposed.title)
  const rawKey = `${proposed.organization.trim().toLowerCase()}::${proposed.title.trim().toLowerCase()}`
  // The same title in a disjoint period is a different job: two P&G summers
  // with the same intern title are two rows, not one.
  for (const r of rows) {
    if (experienceKey(r.organization, r.title) !== key || !datesCompatible(r, proposed)) continue
    const rawSame = `${r.organization.trim().toLowerCase()}::${r.title.trim().toLowerCase()}` === rawKey
    return { match: { id: r.id, rule: rawSame ? 'exact' : 'alias' }, nearMiss: null }
  }
  if (opts.allowSimilar === false) return { match: null, nearMiss: null }

  const org = normalizeOrg(proposed.organization)
  let best: { row: ExperienceLike; similarity: number } | null = null
  for (const r of rows) {
    if (normalizeOrg(r.organization) !== org) continue
    const similarity = titleSimilarity(r.title, proposed.title)
    if (!best || similarity > best.similarity) best = { row: r, similarity }
  }
  if (!best) return { match: null, nearMiss: null }
  if (best.similarity >= SIMILAR_TITLE_THRESHOLD && datesCompatible(best.row, proposed)) {
    return { match: { id: best.row.id, rule: 'similar_title' }, nearMiss: null }
  }
  if (best.similarity >= NEAR_MISS_THRESHOLD && best.similarity < SIMILAR_TITLE_THRESHOLD) {
    return {
      match: null,
      nearMiss: {
        proposed: `${proposed.organization} / ${proposed.title}`,
        candidateId: best.row.id,
        candidate: `${best.row.organization} / ${best.row.title}`,
        similarity: Number(best.similarity.toFixed(2)),
      },
    }
  }
  return { match: null, nearMiss: null }
}

/** The bank fact that already states this, under this experience, if any. */
export function findFactMatch(
  facts: { id: string; experience_id: string | null; statement: string }[],
  experienceId: string | null,
  statement: string
): { id: string } | null {
  const want = normalizeStatement(statement)
  const hit = facts.find((f) => f.experience_id === experienceId && normalizeStatement(f.statement) === want)
  return hit ? { id: hit.id } : null
}

export function planPersist(bank: EvidenceBank, proposal: ImportProposal): PersistPlan {
  const plan: PersistPlan = { experiences: [], facts: [], metrics: [], deliverables: [], matched: [], nearMisses: [], corroborated: [] }

  // 1. Experiences. `slotOf` maps a proposal key to something stable enough to
  //    dedupe children on before ids exist: the bank id when reused, or the
  //    canonical key when the row is yet to be inserted.
  const queued = new Map<string, string>() // experienceKey → proposal key it resolved to
  const slotOf = new Map<string, string>()
  for (const e of proposal.experiences) {
    const key = experienceKey(e.organization, e.title)
    const earlier = queued.get(key)
    if (earlier !== undefined) {
      plan.experiences.push({ action: 'collapse', key: e.key, intoKey: earlier })
      slotOf.set(e.key, slotOf.get(earlier) ?? `new:${key}`)
      continue
    }
    const { match, nearMiss } = findExperienceMatch(bank.experiences, e)
    if (match) {
      plan.experiences.push({ action: 'reuse', key: e.key, existingId: match.id, rule: match.rule })
      if (match.rule !== 'exact') plan.matched.push({ proposed: `${e.organization} / ${e.title}`, existingId: match.id, rule: match.rule })
      slotOf.set(e.key, match.id)
    } else {
      if (nearMiss) plan.nearMisses.push(nearMiss)
      plan.experiences.push({ action: 'insert', key: e.key })
      slotOf.set(e.key, `new:${key}`)
    }
    queued.set(key, e.key)
  }
  const slot = (proposalKey: string) => slotOf.get(proposalKey) ?? 'none'
  const bankIdOf = (proposalKey: string): string | null => {
    const s = slotOf.get(proposalKey)
    return s && !s.startsWith('new:') ? s : null
  }

  // 2. Facts — (experience, normalized statement), bank first, then what this
  //    proposal already queued. A reused fact whose source differs is a second
  //    source for the same claim; say so rather than drop it.
  const bankFactKey = new Map(bank.facts.map((f) => [`${f.experience_id}::${normalizeStatement(f.statement)}`, f]))
  const queuedFacts = new Map<string, number>()
  proposal.facts.forEach((f, i) => {
    const norm = normalizeStatement(f.statement)
    // A fact under an experience this proposal is about to insert cannot be in
    // the bank yet; comparing it to orphan (experience_id null) facts would be
    // a false match.
    const pending = slot(f.experience_key).startsWith('new:')
    const existing = pending ? undefined : bankFactKey.get(`${bankIdOf(f.experience_key)}::${norm}`)
    if (existing) {
      plan.facts.push({ action: 'reuse', existingId: existing.id })
      if (existing.source !== f.source || (existing.source_location ?? null) !== (f.source_location ?? null)) {
        plan.corroborated.push({ factId: existing.id, source: f.source, source_location: f.source_location ?? null })
      }
      return
    }
    const k = `${slot(f.experience_key)}::${norm}`
    const earlier = queuedFacts.get(k)
    if (earlier !== undefined) {
      const first = proposal.facts[earlier]
      plan.facts.push({ action: 'collapse', intoIndex: earlier, corroborates: first.source !== f.source || first.source_location !== f.source_location })
      return
    }
    queuedFacts.set(k, i)
    plan.facts.push({ action: 'insert' })
  })

  // 3. Metrics and deliverables — bank set plus a within-proposal set.
  const metricKey = (expSlot: string, value: string) => `${expSlot}::${normalizeMetricValue(value)}`
  const seenMetrics = new Set(bank.metrics.map((m) => metricKey(String(m.experience_id), m.value)))
  plan.metrics = proposal.metrics.map((m) => {
    const k = metricKey(bankIdOf(m.experience_key) ?? slot(m.experience_key), m.value)
    if (seenMetrics.has(k)) return false
    seenMetrics.add(k)
    return true
  })
  const deliverableKey = (expSlot: string, d: string) => `${expSlot}::${normalizeStatement(d)}`
  const seenDeliverables = new Set(bank.deliverables.map((d) => deliverableKey(String(d.experience_id), d.description)))
  plan.deliverables = proposal.deliverables.map((d) => {
    const k = deliverableKey(bankIdOf(d.experience_key) ?? slot(d.experience_key), d.description)
    if (seenDeliverables.has(k)) return false
    seenDeliverables.add(k)
    return true
  })

  return plan
}
