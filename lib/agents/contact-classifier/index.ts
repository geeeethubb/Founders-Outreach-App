// Contact Classifier Agent — TIER 1 (cheap), batched, no web search.
//
// Judgment problem it owns: "what IS this person, in terms a later search can
// use?" — asked once per contact and cached by content hash.
//
// It is deliberately NOT Person Triage. Triage answers "is this person worth
// researching for THIS mission at THIS company", which is a mission-scoped
// judgment that must be recomputed every run. This answers a mission-independent
// question whose answer changes only when the underlying material changes, which
// is what makes it cacheable across every future mission.
//
// Cost shape: ~15 contacts per call on the cheap tier. 897 contacts is ~60
// calls, once. Re-running after a scouting run classifies only the new people.

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import {
  contactClassifierPrompt,
  RELEVANCE_KEYS,
  type ClassifierContact,
  type ContactClassifierInput,
} from './prompt'

export { contactClassifierPrompt, RELEVANCE_KEYS }
export type { ClassifierContact, ContactClassifierInput }

export interface ContactClassification {
  id: string
  industry: string | null
  sub_industry: string | null
  function: string | null
  company_type: string
  company_stage: string | null
  technical_domains: string[]
  business_domains: string[]
  opportunity_types: string[]
  tags: string[]
  relevance: Record<string, number>
  note: string
}

export interface ContactClassifierOutput {
  classifications: ContactClassification[]
}

const COMPANY_TYPES = [
  'startup', 'growth', 'corporate', 'consultancy', 'investor',
  'academic', 'nonprofit', 'government', 'agency', 'unknown',
]

const OPPORTUNITY_TYPES = [
  'internship', 'full_time_role', 'short_project', 'research_project',
  'consulting_project', 'mentorship', 'referral', 'introduction',
  'investment', 'partnership', 'speaking', 'sponsorship', 'customer_interview',
]

const OUTPUT_SCHEMA = {
  properties: {
    classifications: {
      type: 'array',
      description: 'Exactly one entry per person given, using their id.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id shown for that person.' },
          industry: { type: ['string', 'null'] },
          sub_industry: { type: ['string', 'null'] },
          function: { type: ['string', 'null'] },
          company_type: { type: 'string', enum: COMPANY_TYPES },
          company_stage: { type: ['string', 'null'] },
          technical_domains: { type: 'array', items: { type: 'string' } },
          business_domains: { type: 'array', items: { type: 'string' } },
          opportunity_types: { type: 'array', items: { type: 'string', enum: OPPORTUNITY_TYPES } },
          tags: { type: 'array', items: { type: 'string' } },
          relevance: {
            type: 'object',
            description: '0-1 for each of the six uses.',
            properties: Object.fromEntries(RELEVANCE_KEYS.map((k) => [k, { type: 'number' }])),
            required: [...RELEVANCE_KEYS],
          },
          note: { type: 'string' },
        },
        required: [
          'id', 'industry', 'sub_industry', 'function', 'company_type', 'company_stage',
          'technical_domains', 'business_domains', 'opportunity_types', 'tags', 'relevance', 'note',
        ],
      },
    },
  },
  required: ['classifications'],
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, v))
}

function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    const s = String(item ?? '').trim().toLowerCase()
    if (!s || s === 'unknown' || seen.has(s)) continue
    seen.add(s)
    out.push(s.slice(0, 60))
    if (out.length >= max) break
  }
  return out
}

function nullable(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s || /^(unknown|n\/a|none|null)$/i.test(s)) return null
  return s.slice(0, 120)
}

export async function runContactClassifier(
  input: ContactClassifierInput,
  ctx: ToolContext
): Promise<AgentResult<ContactClassifierOutput>> {
  const validKeys = new Set(input.contacts.map((c) => c.id))

  const validate = (raw: unknown): ContactClassifierOutput | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (!Array.isArray(r.classifications)) return null

    const out: ContactClassification[] = []
    const seen = new Set<string>()
    for (const entry of r.classifications) {
      if (!entry || typeof entry !== 'object') continue
      const c = entry as Record<string, unknown>
      const id = String(c.id ?? '')
      if (!validKeys.has(id) || seen.has(id)) continue
      seen.add(id)

      const rel = (c.relevance ?? {}) as Record<string, unknown>
      const relevance: Record<string, number> = {}
      for (const k of RELEVANCE_KEYS) relevance[k] = clamp01(rel[k])

      out.push({
        id,
        industry: nullable(c.industry),
        sub_industry: nullable(c.sub_industry),
        function: nullable(c.function),
        company_type: COMPANY_TYPES.includes(String(c.company_type)) ? String(c.company_type) : 'unknown',
        company_stage: nullable(c.company_stage),
        technical_domains: strList(c.technical_domains, 5),
        business_domains: strList(c.business_domains, 5),
        opportunity_types: strList(c.opportunity_types, 4).filter((t) => OPPORTUNITY_TYPES.includes(t)),
        tags: strList(c.tags, 6),
        relevance,
        note: String(c.note ?? '').trim().slice(0, 300),
      })
    }

    // Every contact must come back. A silently skipped person would sit in the
    // index unclassified and invisible to every future search, with nothing
    // recording that it happened.
    return out.length === input.contacts.length ? { classifications: out } : null
  }

  return runAgent<ContactClassifierInput, ContactClassifierOutput>({
    agentId: 'contact_classifier',
    tier: 'cheap',
    modelRole: 'fast',
    prompt: contactClassifierPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 8000,
    // Keyed on the material itself, so an unchanged contact is free forever and
    // a changed one is re-read exactly once.
    cacheKeyParts: { contacts: input.contacts.map((c) => `${c.id}:${c.material}`) },
  })
}
