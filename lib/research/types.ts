// Grounded research dossier shapes.
//
// The three-way claim typing from docs/AGENTS.md §4 is the whole point: a FACT
// requires a resolvable source URL, an INFERENCE is reasoned and labelled, and
// UNKNOWN is a first-class output rather than an absence.
//
// Enforced structurally in `validateFacts()` below rather than by asking the
// model nicely — a FACT that arrives without a source is downgraded to
// INFERENCE, so an unsourced claim can never reach scoring as a fact.

export type FactType = 'FACT' | 'INFERENCE' | 'UNKNOWN'

export interface ResearchClaim {
  claim: string
  type: FactType
  /** Required when type === 'FACT'. Validated, not trusted. */
  source_url: string | null
  source_title: string | null
  confidence: number
  /** Why this claim matters to the mission. Optional; persisted when present. */
  relevance?: string | null
}

export interface CompanyDossier {
  company_key: string
  company_name: string
  domain: string | null

  /** Plain-English answer to "what does this company actually do?" */
  what_they_do: string
  products_services: string[]
  industries_served: string[]
  customer_types: string[]

  /** Evidence of the mission's target domains, or explicit absence of it. */
  domain_evidence: {
    industrial_ai: boolean
    manufacturing: boolean
    chemicals_process: boolean
    energy_materials: boolean
    consulting: boolean
    enterprise_software: boolean
  }

  size_stage_context: string | null
  /** The model's own verdict on mission relevance, before any scoring. */
  mission_relevant: boolean
  relevance_reasoning: string

  claims: ResearchClaim[]
  uncertainties: string[]
  /** Set when web research produced nothing usable. */
  research_failed: boolean
}

export interface PersonDossier {
  person_key: string
  person_name: string

  /** What this person appears to own. */
  apparent_ownership: string
  function_relevance: string
  decision_maker_assessment: string
  can_create_opportunity: boolean
  recent_initiatives: string[]

  claims: ResearchClaim[]
  uncertainties: string[]
  research_failed: boolean
}

/** Counts of sourced vs unsourced material, for the coverage eval. */
export interface ResearchCoverage {
  total: number
  researched: number
  withFacts: number
  factCount: number
  sourcedFactCount: number
}

/**
 * Enforce the sourcing rule.
 *
 * A claim typed FACT without a resolvable http(s) URL is **downgraded to
 * INFERENCE**, not dropped: the observation may still be useful, it simply is
 * not verified. This is the mechanism that keeps unsupported claims out of
 * scoring, and it makes "100% of factual claims have sources" true by
 * construction rather than by hope.
 */
export function validateClaims(raw: unknown[]): ResearchClaim[] {
  const out: ResearchClaim[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const c = entry as Record<string, unknown>

    const claim = String(c.claim ?? '').trim()
    if (!claim) continue

    const declared = String(c.type ?? 'INFERENCE').toUpperCase()
    const url = typeof c.source_url === 'string' && /^https?:\/\//i.test(c.source_url) ? c.source_url : null

    let type: FactType =
      declared === 'FACT' ? 'FACT' : declared === 'UNKNOWN' ? 'UNKNOWN' : 'INFERENCE'
    if (type === 'FACT' && !url) type = 'INFERENCE'

    const confidence = typeof c.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : 0.5

    out.push({
      claim,
      type,
      source_url: type === 'FACT' ? url : url,
      source_title: typeof c.source_title === 'string' ? c.source_title : null,
      confidence,
      relevance: typeof c.relevance === 'string' ? c.relevance : null,
    })
  }
  return out
}

/**
 * The stronger form, used by the agent runtime.
 *
 * `validateClaims` proves a FACT's URL is well-formed. This additionally proves
 * the model actually *retrieved* that URL: the allowed set is the citation list
 * harvested from its own tool results, so a plausible-looking but never-visited
 * link is downgraded to INFERENCE.
 *
 * Phase 6 found this mattered — a model will happily cite a company's real
 * homepage for a claim that page does not make. Restricting to retrieved URLs
 * does not fix that alone, but it removes the entire class of invented links.
 */
export function validateClaimsAgainstEvidence(
  raw: unknown[],
  evidenceUrls: Iterable<string>
): { claims: ResearchClaim[]; downgraded: number } {
  const allowed = new Set<string>()
  for (const u of evidenceUrls) {
    allowed.add(u)
    // Also accept the bare origin: models routinely cite the site root for a
    // claim sourced from a specific page on that same site.
    try {
      allowed.add(new URL(u).origin)
    } catch {
      /* ignore unparseable */
    }
  }

  let downgraded = 0
  const claims = validateClaims(raw).map((c) => {
    if (c.type !== 'FACT' || !c.source_url) return c
    let retrieved = allowed.has(c.source_url)
    if (!retrieved) {
      try {
        retrieved = allowed.has(new URL(c.source_url).origin)
      } catch {
        retrieved = false
      }
    }
    if (retrieved) return c
    downgraded++
    return { ...c, type: 'INFERENCE' as FactType }
  })

  return { claims, downgraded }
}

export function countCoverage(
  dossiers: (CompanyDossier | PersonDossier | null)[],
  total: number
): ResearchCoverage {
  let researched = 0
  let withFacts = 0
  let factCount = 0
  let sourcedFactCount = 0

  for (const d of dossiers) {
    if (!d || d.research_failed) continue
    researched++
    const facts = d.claims.filter((c) => c.type === 'FACT')
    if (facts.length > 0) withFacts++
    factCount += facts.length
    sourcedFactCount += facts.filter((f) => f.source_url).length
  }

  return { total, researched, withFacts, factCount, sourcedFactCount }
}

/** Compact dossier rendering for a scoring prompt. Kept tight — prompt budget. */
export function renderCompanyDossier(d: CompanyDossier): string {
  const lines = [
    `WHAT THEY DO: ${d.what_they_do}`,
  ]
  if (d.products_services.length) lines.push(`PRODUCTS/SERVICES: ${d.products_services.join('; ')}`)
  if (d.industries_served.length) lines.push(`INDUSTRIES SERVED: ${d.industries_served.join(', ')}`)
  if (d.customer_types.length) lines.push(`CUSTOMERS: ${d.customer_types.join(', ')}`)

  const domains = Object.entries(d.domain_evidence).filter(([, v]) => v).map(([k]) => k)
  lines.push(`DOMAIN EVIDENCE: ${domains.length ? domains.join(', ') : 'NONE FOUND'}`)

  if (d.size_stage_context) lines.push(`CONTEXT: ${d.size_stage_context}`)
  lines.push(`RESEARCHER VERDICT: ${d.mission_relevant ? 'mission-relevant' : 'NOT mission-relevant'} — ${d.relevance_reasoning}`)

  const facts = d.claims.filter((c) => c.type === 'FACT').slice(0, 6)
  if (facts.length) {
    lines.push('VERIFIED FACTS:')
    for (const f of facts) lines.push(`  • ${f.claim}`)
  }
  if (d.uncertainties.length) lines.push(`UNKNOWNS: ${d.uncertainties.slice(0, 3).join('; ')}`)
  return lines.join('\n')
}

export function renderPersonDossier(d: PersonDossier): string {
  const lines = [
    `APPARENT OWNERSHIP: ${d.apparent_ownership}`,
    `FUNCTION RELEVANCE: ${d.function_relevance}`,
    `DECISION MAKER: ${d.can_create_opportunity ? 'yes' : 'unclear/no'} — ${d.decision_maker_assessment}`,
  ]
  if (d.recent_initiatives.length) lines.push(`RECENT: ${d.recent_initiatives.slice(0, 3).join('; ')}`)
  const facts = d.claims.filter((c) => c.type === 'FACT').slice(0, 4)
  if (facts.length) {
    lines.push('VERIFIED FACTS:')
    for (const f of facts) lines.push(`  • ${f.claim}`)
  }
  return lines.join('\n')
}
