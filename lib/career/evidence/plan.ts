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
// A second proposal block with the key of one already queued folds into it
// ONLY when their dates are compatible, so one import cannot create two rows
// of one job — and two P&G summers pasted together stay two rows.
// A qualifier the org normalizer strips ("(Professor X's lab)") that differs
// on both sides blocks every rule: two labs at one university are two rows.

import type { EvidenceBank } from '../types'
import type { ImportProposal } from './import'
import {
  datesCompatible,
  experienceKey,
  normalizeMetricValue,
  normalizeOrg,
  normalizeStatement,
  orgQualifier,
  titleSimilarity,
} from './normalize'

export const SIMILAR_TITLE_THRESHOLD = 0.6
export const NEAR_MISS_THRESHOLD = 0.3

/**
 * 'agent_filed': the importer filed the block under an existing id and the
 * rules (same org, similar title, compatible dates) agreed. The agent's
 * choice is a signal, never the decider.
 */
export type MatchRule = 'exact' | 'alias' | 'similar_title' | 'agent_filed'

export interface MatchedExperience {
  proposed: string
  existingId: string
  rule: Exclude<MatchRule, 'exact'>
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
  /** The bank row the importer filed this under, when it was shown the bank. */
  existingId?: string | null
}

/**
 * The importer's filing decision, checked. Reuse only when the hinted row is
 * the same org, the title is the same or closely related (≥ the similar-title
 * threshold — "President (previously Head of Events)" is "President"; "Head of
 * Events" and "Vice President" are not) and the dates do not contradict.
 * Anything else is a near miss: inserted, reported, decided by a human.
 */
/**
 * True when both org strings carry a qualifier and the qualifiers differ:
 * "University of Illinois (Mironenko lab)" vs "University of Illinois
 * (Flaherty lab)". One side unqualified is not a contradiction.
 */
export function qualifiersConflict(a: string, b: string): boolean {
  const qa = orgQualifier(a).toLowerCase()
  const qb = orgQualifier(b).toLowerCase()
  return qa !== '' && qb !== '' && qa !== qb
}

export function checkFilingHint(
  rows: ExperienceLike[],
  proposed: ProposedExperienceLike
): { match: { id: string; rule: 'agent_filed' } | null; nearMiss: NearMiss | null } {
  if (!proposed.existingId) return { match: null, nearMiss: null }
  const row = rows.find((r) => r.id === proposed.existingId)
  if (!row) return { match: null, nearMiss: null }
  const sameOrg =
    normalizeOrg(row.organization) === normalizeOrg(proposed.organization) &&
    !qualifiersConflict(row.organization, proposed.organization)
  const similarity = titleSimilarity(row.title, proposed.title)
  if (sameOrg && similarity >= SIMILAR_TITLE_THRESHOLD && datesCompatible(row, proposed)) {
    return { match: { id: row.id, rule: 'agent_filed' }, nearMiss: null }
  }
  return {
    match: null,
    nearMiss: {
      proposed: `${proposed.organization} / ${proposed.title}`,
      candidateId: row.id,
      candidate: `${row.organization} / ${row.title}`,
      similarity: Number(similarity.toFixed(2)),
    },
  }
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
    if (qualifiersConflict(r.organization, proposed.organization)) continue
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
  // Same org, same-ish title, but a different sub-unit named on both sides:
  // insert, and say which row it nearly was.
  if (best.similarity >= NEAR_MISS_THRESHOLD && qualifiersConflict(best.row.organization, proposed.organization)) {
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
  // Tombstones (015 status = 'merged') are never match targets; the loader
  // filters them, and an in-memory bank may not have.
  const activeExperiences = bank.experiences.filter((r) => r.status !== 'merged')
  const activeFacts = bank.facts.filter((f) => f.status !== 'merged')
  // experienceKey → earlier blocks of this proposal with that key. A later
  // block folds into the first one whose dates do not contradict it and whose
  // org qualifier does not name a different sub-unit; otherwise it is matched
  // against the bank on its own, like any block.
  const queued = new Map<string, ImportProposal['experiences'][number][]>()
  const slotOf = new Map<string, string>()
  for (const e of proposal.experiences) {
    const key = experienceKey(e.organization, e.title)
    const earlierBlocks = queued.get(key) ?? []
    const earlier = earlierBlocks.find((b) => datesCompatible(b, e) && !qualifiersConflict(b.organization, e.organization))
    if (earlier) {
      plan.experiences.push({ action: 'collapse', key: e.key, intoKey: earlier.key })
      slotOf.set(e.key, slotOf.get(earlier.key) ?? `new:${key}`)
      continue
    }
    // The importer's hint first, verified; then the rules on their own. A
    // rejected hint is reported even when the rules find nothing, because
    // the agent thought these were one job and a human should hear that.
    const hinted = checkFilingHint(activeExperiences, e)
    const found = hinted.match ? hinted : findExperienceMatch(activeExperiences, e)
    const match = found.match
    const nearMiss = found.nearMiss ?? hinted.nearMiss
    if (match) {
      plan.experiences.push({ action: 'reuse', key: e.key, existingId: match.id, rule: match.rule })
      if (match.rule !== 'exact') plan.matched.push({ proposed: `${e.organization} / ${e.title}`, existingId: match.id, rule: match.rule })
      slotOf.set(e.key, match.id)
    } else {
      if (nearMiss) plan.nearMisses.push(nearMiss)
      plan.experiences.push({ action: 'insert', key: e.key })
      slotOf.set(e.key, `new:${key}`)
    }
    queued.set(key, [...earlierBlocks, e])
  }
  const slot = (proposalKey: string) => slotOf.get(proposalKey) ?? 'none'
  const bankIdOf = (proposalKey: string): string | null => {
    const s = slotOf.get(proposalKey)
    return s && !s.startsWith('new:') ? s : null
  }

  // 2. Facts — (experience, normalized statement), bank first, then what this
  //    proposal already queued. A reused fact whose source differs is a second
  //    source for the same claim; say so rather than drop it.
  const bankFactKey = new Map(activeFacts.map((f) => [`${f.experience_id}::${normalizeStatement(f.statement)}`, f]))
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
