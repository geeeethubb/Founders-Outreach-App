// The searchable representation of one existing contact.
//
// Pure functions. Given everything the database already knows about a person,
// produce three weighted text fields and a hash of the material they came from.
//
// WHY THREE FIELDS AND NOT ONE
//
// Postgres full-text ranking over a single blob makes a plant manager whose
// title says "manufacturing" indistinguishable from a marketer whose research
// paragraph happens to mention the word once. Splitting identity (A), tags (B)
// and research prose (C) and weighting them is the difference between a
// retrieval layer and a keyword grep.
//
// WHY A HASH
//
// Classification is the only part of indexing that costs money. The hash covers
// exactly the material the classifier reads, so re-indexing after a new scouting
// run re-classifies the new people and nobody else.

import crypto from 'crypto'
import { normalizeContact, type NormalizedContact } from './normalize'
import type { RelationshipHistory } from './relationship'

export const INDEX_VERSION = '1.1.0'

export interface ContactMaterial {
  id: string
  name: string
  title: string | null
  company: string | null
  location: string | null
  seniority: string | null
  department: string | null
  email: string | null
  linkedin: string | null
  tags: string[]
  notes: string | null
  status: string | null
  /** From V1 `contact_research`, when it exists. */
  research: {
    summary: string | null
    hooks: string[]
    sharedContext: string[]
    category: string | null
    suggestedAsk: string | null
    relevanceScore: number | null
  } | null
  /** Grounded person-level claims from Phase 7+ research. */
  facts: { claim: string; type: string }[]
  /** The company record, when the contact is linked to one. */
  company_profile: {
    name: string | null
    description: string | null
    industry: string | null
    subIndustries: string[]
    employeeCount: number | null
    stage: string | null
    hqLocation: string | null
  } | null
  /** Grounded company-level claims. */
  companyFacts: { claim: string; type: string }[]
}

export interface BuiltDocument {
  headline: string
  tagsText: string
  bodyText: string
  sourceHash: string
  normalized: NormalizedContact
  evidenceLevel: 'rich' | 'moderate' | 'thin'
  /** Exactly what a classifier needs, and nothing else. Keeps the hash tight. */
  classifierInput: string
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

function uniq(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const t = clean(v)
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/**
 * How much we actually know. Retrieval reports this so "we have nobody good" is
 * distinguishable from "we know nothing about the people we have" — two very
 * different reasons to go spend money externally.
 */
function evidenceLevelFor(m: ContactMaterial): 'rich' | 'moderate' | 'thin' {
  const facts = m.facts.filter((f) => f.type === 'FACT').length
  const hasSummary = clean(m.research?.summary ?? '').length > 120
  const hasCompany = clean(m.company_profile?.description ?? '').length > 60
  if (facts >= 3 || (hasSummary && facts >= 1)) return 'rich'
  if (hasSummary || hasCompany || facts >= 1) return 'moderate'
  return 'thin'
}

export function buildDocument(m: ContactMaterial, history: RelationshipHistory): BuiltDocument {
  const normalized = normalizeContact({
    title: m.title,
    seniority: m.seniority,
    location: m.location,
    company: m.company,
  })

  const headline = uniq([m.name, m.title, m.company, m.company_profile?.name]).join(' · ')

  // Tags are the mid-weight band: enumerable facets that should beat prose but
  // not beat an actual job title.
  const tagsText = uniq([
    normalized.seniorityBand.replace(/_/g, ' '),
    normalized.functionArea.replace(/_/g, ' '),
    m.department,
    normalized.geo.city,
    normalized.geo.state,
    normalized.geo.country,
    normalized.geo.region.replace(/_/g, ' '),
    m.company_profile?.industry,
    ...(m.company_profile?.subIndustries ?? []),
    m.company_profile?.stage,
    m.research?.category,
    history.status.replace(/_/g, ' '),
    ...m.tags,
  ]).join(' · ')

  const bodyParts: string[] = []
  if (m.company_profile?.description) bodyParts.push(`Company: ${clean(m.company_profile.description)}`)
  if (m.research?.summary) bodyParts.push(clean(m.research.summary))
  if (m.research?.hooks.length) bodyParts.push(`Hooks: ${m.research.hooks.map(clean).join('; ')}`)
  if (m.research?.sharedContext.length) bodyParts.push(`Shared: ${m.research.sharedContext.map(clean).join('; ')}`)
  if (m.research?.suggestedAsk) bodyParts.push(`Suggested ask: ${clean(m.research.suggestedAsk)}`)
  for (const f of m.facts.slice(0, 12)) bodyParts.push(clean(f.claim))
  for (const f of m.companyFacts.slice(0, 6)) bodyParts.push(clean(f.claim))
  if (m.notes) bodyParts.push(clean(m.notes))

  const bodyText = bodyParts.filter(Boolean).join('\n')

  // What the classifier sees. Deliberately narrower than bodyText — the hash
  // must not change (and force a re-classification) because an unrelated
  // company fact was appended.
  const classifierInput = [
    `NAME: ${m.name}`,
    `TITLE: ${clean(m.title) || 'unknown'}`,
    `COMPANY: ${clean(m.company) || 'unknown'}`,
    `LOCATION: ${clean(m.location) || 'unknown'}`,
    m.company_profile?.description ? `COMPANY PROFILE: ${clean(m.company_profile.description).slice(0, 400)}` : '',
    m.company_profile?.industry ? `COMPANY INDUSTRY: ${clean(m.company_profile.industry)}` : '',
    m.company_profile?.employeeCount ? `COMPANY SIZE: ~${m.company_profile.employeeCount} employees` : '',
    m.research?.summary ? `RESEARCH: ${clean(m.research.summary).slice(0, 700)}` : '',
    m.facts.length ? `FACTS: ${m.facts.slice(0, 6).map((f) => clean(f.claim)).join(' | ').slice(0, 700)}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    headline,
    tagsText,
    bodyText,
    normalized,
    evidenceLevel: evidenceLevelFor(m),
    classifierInput,
    sourceHash: crypto.createHash('sha256').update(classifierInput).digest('hex').slice(0, 32),
  }
}

/**
 * A compact line describing a contact, for a model that must not be handed rows.
 *
 * Deliberately terse. Every search result re-enters the prompt and stays there
 * for the rest of the session, so a verbose row format is paid for on every
 * subsequent turn. The first version ran five lines per candidate and 25
 * candidates a search; eight searches of that made the agent's own context the
 * dominant cost of the run.
 */
export function renderCandidateLine(row: {
  contact_id: string
  name: string
  title: string | null
  company: string | null
  seniority_band: string | null
  function_area: string | null
  geo_city: string | null
  geo_state: string | null
  industry: string | null
  technical_domains: string[] | null
  opportunity_types: string[] | null
  relationship_status: string | null
  evidence_level: string | null
  summary: string | null
}): string {
  const where = [row.geo_city, row.geo_state].filter(Boolean).join(', ') || 'loc?'
  const facets = [
    row.seniority_band ?? '?',
    row.function_area ?? '?',
    where,
    row.industry ?? '',
    (row.technical_domains ?? []).slice(0, 3).join('/'),
    (row.opportunity_types ?? []).slice(0, 2).join('/'),
    row.relationship_status && row.relationship_status !== 'never_contacted' ? `REL:${row.relationship_status}` : '',
    row.evidence_level === 'thin' ? 'thin-evidence' : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const head = `${row.contact_id} | ${row.name} — ${row.title ?? 'unknown title'} @ ${row.company ?? 'unknown company'}`
  const note = row.summary ? `\n    ${clean(row.summary).slice(0, 130)}` : ''
  return `${head}\n    ${facets}${note}`
}
