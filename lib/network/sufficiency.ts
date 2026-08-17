// The internal-first decision.
//
// "Do not call Apollo merely because the mission started." This is where that
// becomes a rule rather than an intention — and it is deterministic on purpose.
// Asking a model whether it has found enough people is asking the party that
// benefits from spending more.
//
// Every decision carries its reasons, and the orchestrator writes them to
// scouting_runs.internal_decision. "Why did this run cost $14?" and "why did
// this run cost nothing?" must both be answerable afterwards.

export type SearchMode = 'internal_first' | 'internal_only' | 'external_only' | 'both'

export const SEARCH_MODES: SearchMode[] = ['internal_first', 'internal_only', 'external_only', 'both']

export function isSearchMode(v: unknown): v is SearchMode {
  return typeof v === 'string' && (SEARCH_MODES as string[]).includes(v)
}

/** A candidate is "strong" only if it is both well-scored and well-evidenced. */
export const STRONG_SCORE = 0.62
export const STRONG_CONFIDENCE = 0.5

export type Decision = 'INTERNAL_SUFFICIENT' | 'EXTERNAL_DISCOVERY_NEEDED' | 'INTERNAL_SKIPPED'

export interface SufficiencyInput {
  mode: SearchMode
  /** Total scores of the internal candidates, best first. */
  candidates: { total: number; confidence: number }[]
  targetCount: number
  /** From the retrieval agent: profiles the network lacks. */
  missingProfile: string[]
  /** How many contacts are indexed at all. */
  indexed: number
  /** How many of those carry a classification. */
  classified: number
}

export interface SufficiencyDecision {
  decision: Decision
  runExternal: boolean
  strongCount: number
  usableCount: number
  targetCount: number
  shortfall: number
  reasons: string[]
  missingProfile: string[]
}

export function decideSufficiency(input: SufficiencyInput): SufficiencyDecision {
  const strong = input.candidates.filter((c) => c.total >= STRONG_SCORE && c.confidence >= STRONG_CONFIDENCE)
  const usable = input.candidates.filter((c) => c.total >= 0.45)
  const strongCount = strong.length
  const shortfall = Math.max(0, input.targetCount - strongCount)
  const reasons: string[] = []

  const base = (decision: Decision, runExternal: boolean): SufficiencyDecision => ({
    decision,
    runExternal,
    strongCount,
    usableCount: usable.length,
    targetCount: input.targetCount,
    shortfall,
    reasons,
    missingProfile: input.missingProfile,
  })

  if (input.mode === 'external_only') {
    reasons.push('Search mode is "new contacts only" — the existing network was not searched.')
    return base('INTERNAL_SKIPPED', true)
  }

  if (input.mode === 'both') {
    reasons.push('Search mode is "existing + new" — external discovery runs regardless of the internal result.')
    reasons.push(`${strongCount} strong internal candidate${strongCount === 1 ? '' : 's'} found.`)
    return base('EXTERNAL_DISCOVERY_NEEDED', true)
  }

  if (input.indexed === 0) {
    reasons.push('No contacts are indexed yet — run the network indexer before relying on internal-first.')
    return base(input.mode === 'internal_only' ? 'INTERNAL_SUFFICIENT' : 'EXTERNAL_DISCOVERY_NEEDED', input.mode !== 'internal_only')
  }

  if (input.classified < input.indexed * 0.5) {
    reasons.push(
      `Only ${input.classified} of ${input.indexed} indexed contacts are classified, so internal retrieval is ` +
        'searching a partly-blind index.'
    )
  }

  if (input.mode === 'internal_only') {
    reasons.push('Search mode is "existing network only" — external discovery is disabled for this run.')
    if (shortfall > 0) {
      reasons.push(
        `Found ${strongCount} strong of ${input.targetCount} asked for. Returning ${strongCount} rather than padding the list.`
      )
    }
    return base('INTERNAL_SUFFICIENT', false)
  }

  // ─── internal_first, the default ───
  if (strongCount >= input.targetCount) {
    reasons.push(
      `${strongCount} strong internal candidates (score ≥ ${STRONG_SCORE}, confidence ≥ ${STRONG_CONFIDENCE}) ` +
        `meets the target of ${input.targetCount}.`
    )
    reasons.push('External discovery skipped — no Apollo credits and no web research were spent.')
    if (input.missingProfile.length > 0) {
      reasons.push(`Noted gaps, not acted on this run: ${input.missingProfile.slice(0, 3).join('; ')}`)
    }
    return base('INTERNAL_SUFFICIENT', false)
  }

  reasons.push(
    `Only ${strongCount} strong internal candidate${strongCount === 1 ? '' : 's'} against a target of ` +
      `${input.targetCount} — short by ${shortfall}.`
  )
  if (input.missingProfile.length > 0) {
    reasons.push(`The network is missing: ${input.missingProfile.slice(0, 3).join('; ')}`)
  }
  if (usable.length > strongCount) {
    reasons.push(`${usable.length - strongCount} further internal candidates are usable but not strong; they are kept and ranked alongside new discoveries.`)
  }
  return base('EXTERNAL_DISCOVERY_NEEDED', true)
}

/** One line for the UI and the run log. */
export function summarizeDecision(d: SufficiencyDecision): string {
  switch (d.decision) {
    case 'INTERNAL_SUFFICIENT':
      return `Internal network sufficient — ${d.strongCount} strong candidates, no external discovery run.`
    case 'INTERNAL_SKIPPED':
      return 'Internal network skipped by search mode — external discovery only.'
    default:
      return `External discovery needed — ${d.strongCount}/${d.targetCount} strong internal candidates.`
  }
}
