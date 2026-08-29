// The outreach loop's background list, from the Evidence Bank.
//
// People Scout, positioning and the claim gate used to read a hand-written
// fixture (evals/phase3/user-profile.ts). The bank is now the source; the
// fixture is the fallback for an EMPTY bank only — so a founder who edits an
// Evidence fact sees the change in the next scout run, and a fresh account
// with nothing approved still gets a usable (if impersonal) run, labelled as
// such (`source: 'fixture'`) rather than silently.

import { RESUME_ITEMS } from '@/evals/phase3/user-profile'
import { getRelevantPersonalEvidence, toBackgroundItems } from '@/lib/career/evidence/retrieval'
import type { BackgroundItemLike } from '@/lib/career/evidence/retrieval-types'
import type { EvidenceBank } from '@/lib/career/types'

export interface BackgroundOptions {
  mission?: string | null
  /** Default 12 — the positioning agent chooses FROM this list; it is a shortlist, not the bank. */
  maxExperiences?: number
  /** Default 24. */
  maxFacts?: number
}

/** A retrieved fact the claim gate may verify against, scoped to its experience. */
export interface BackgroundFact {
  id: string
  statement: string
  experienceId: string
}

export interface BackgroundResult {
  items: BackgroundItemLike[]
  source: 'bank' | 'fixture'
  /** Facts behind the items (bank only), for buildVerificationPool's bankFacts. */
  facts: BackgroundFact[]
}

export function fixtureBackground(): BackgroundItemLike[] {
  return RESUME_ITEMS.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    org: i.org,
    period: i.period,
    summary: i.summary,
    domains: [...i.domains],
    credibility: i.credibility,
  }))
}

export function backgroundForOutreach(bank: EvidenceBank | null | undefined, opts: BackgroundOptions = {}): BackgroundResult {
  const hasApproved = !!bank && bank.experiences.some((e) => e.approved === true && e.status !== 'merged')
  if (!bank || !hasApproved) return { items: fixtureBackground(), source: 'fixture', facts: [] }

  const rel = getRelevantPersonalEvidence({
    bank,
    mission: opts.mission ?? null,
    target: { kind: 'generic' },
    maxExperiences: opts.maxExperiences ?? 12,
    maxFacts: opts.maxFacts ?? 24,
    includeMetrics: true,
    includeSkills: true,
  })
  const items = toBackgroundItems(rel)
  const facts: BackgroundFact[] = rel.experiences.flatMap((e) =>
    e.facts.map((f) => ({ id: f.fact.id, statement: f.fact.statement, experienceId: e.experience.id }))
  )
  return { items, source: 'bank', facts }
}

/** The scouting orchestrator's `{ id, summary }` shape. */
export function toScoutItems(items: BackgroundItemLike[]): { id: string; summary: string }[] {
  return items
    .filter((i) => i.credibility !== 'supporting')
    .map((i) => ({ id: i.id, summary: `${i.title} — ${i.org}${i.period ? ` (${i.period})` : ''}: ${i.summary}` }))
}
