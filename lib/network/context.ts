// Rebuild research context for a contact we already own.
//
// This is what makes reuse real rather than nominal. An internal candidate
// arrives at ranking, positioning and drafting carrying the same shape of
// context an externally-discovered one does — except every fact was already
// paid for, so the run spends nothing to produce it.
//
// The bullet format is not cosmetic. lib/outreach/evidence.ts builds the
// writer's and the grounding gate's evidence pool by reading lines that begin
// with "•" out of `personContext`. A different format here would silently
// starve the gate and every honest claim about the recipient would be blocked.

import { createServiceClient } from '@/lib/supabase/server'

export interface InternalContext {
  companyContext: string
  personContext: string
  /** Facts with sources, for provenance display. */
  sourcedFacts: { claim: string; sourceUrl: string | null }[]
  factCount: number
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

export async function loadInternalContexts(
  userId: string,
  contactIds: string[]
): Promise<Map<string, InternalContext>> {
  const out = new Map<string, InternalContext>()
  if (contactIds.length === 0) return out
  const supabase = createServiceClient()

  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, name, role, company, location, company_id')
    .eq('user_id', userId)
    .in('id', contactIds)

  const { data: research } = await supabase
    .from('contact_research')
    .select('contact_id, summary, hooks, shared_context, suggested_ask, category')
    .in('contact_id', contactIds)

  const { data: personFacts } = await supabase
    .from('research_facts')
    .select('contact_id, claim, type, source_url')
    .eq('user_id', userId)
    .in('contact_id', contactIds)
    .order('created_at', { ascending: false })
    .limit(2000)

  const companyIds = Array.from(
    new Set((contacts ?? []).map((c) => c.company_id).filter((id): id is string => Boolean(id)))
  )

  const { data: companies } = companyIds.length
    ? await supabase
        .from('companies')
        .select('id, name, description, industry, sub_industries, employee_count, stage, hq_location')
        .eq('user_id', userId)
        .in('id', companyIds)
    : { data: [] as never[] }

  const { data: companyFacts } = companyIds.length
    ? await supabase
        .from('research_facts')
        .select('company_id, claim, type, source_url')
        .eq('user_id', userId)
        .in('company_id', companyIds)
        .order('created_at', { ascending: false })
        .limit(1500)
    : { data: [] as never[] }

  const { data: indexRows } = await supabase
    .from('contact_index')
    .select('contact_id, industry, sub_industry, function, company_type, company_stage, technical_domains, business_domains, classification_note, relationship_note, relationship_status')
    .eq('user_id', userId)
    .in('contact_id', contactIds)

  const researchBy = new Map((research ?? []).map((r) => [r.contact_id, r]))
  const indexBy = new Map((indexRows ?? []).map((r) => [r.contact_id, r]))
  const companyById = new Map((companies ?? []).map((c) => [c.id, c]))

  const factsByContact = new Map<string, { claim: string; type: string; source_url: string | null }[]>()
  for (const f of personFacts ?? []) {
    if (!f.contact_id) continue
    const list = factsByContact.get(f.contact_id) ?? []
    list.push({ claim: f.claim, type: f.type, source_url: f.source_url })
    factsByContact.set(f.contact_id, list)
  }
  const factsByCompany = new Map<string, { claim: string; type: string; source_url: string | null }[]>()
  for (const f of companyFacts ?? []) {
    if (!f.company_id) continue
    const list = factsByCompany.get(f.company_id) ?? []
    list.push({ claim: f.claim, type: f.type, source_url: f.source_url })
    factsByCompany.set(f.company_id, list)
  }

  for (const c of contacts ?? []) {
    const r = researchBy.get(c.id)
    const idx = indexBy.get(c.id)
    const co = c.company_id ? companyById.get(c.company_id) : null
    const pFacts = factsByContact.get(c.id) ?? []
    const cFacts = c.company_id ? factsByCompany.get(c.company_id) ?? [] : []

    // ─── company ───
    const companyLines: string[] = []
    if (co?.description) companyLines.push(`WHAT THEY DO: ${clean(co.description)}`)
    else if (idx?.industry) companyLines.push(`WHAT THEY DO: ${clean(c.company)} — ${clean(idx.industry)}`)
    if (co?.industry || idx?.industry) companyLines.push(`INDUSTRY: ${clean(co?.industry ?? idx?.industry)}`)
    const subs = co?.sub_industries?.length ? co.sub_industries : idx?.sub_industry ? [idx.sub_industry] : []
    if (subs.length) companyLines.push(`SUB-INDUSTRIES: ${subs.map(clean).join(', ')}`)
    if (co?.employee_count) companyLines.push(`SIZE: ~${co.employee_count} employees`)
    if (co?.stage || idx?.company_stage) companyLines.push(`STAGE: ${clean(co?.stage ?? idx?.company_stage)}`)
    if (co?.hq_location) companyLines.push(`HQ: ${clean(co.hq_location)}`)
    const companyVerified = cFacts.filter((f) => f.type === 'FACT').slice(0, 5)
    if (companyVerified.length) {
      companyLines.push(`VERIFIED FACTS:\n${companyVerified.map((f) => `  • ${clean(f.claim)}`).join('\n')}`)
    }
    const companyContext = companyLines.length
      ? companyLines.join('\n')
      : `WHAT THEY DO: ${clean(c.company) || 'unknown company'} — no stored company research.`

    // ─── person ───
    const personLines: string[] = [
      `SOURCE: already in your database — this person was researched for an earlier mission.`,
    ]
    if (idx?.function) personLines.push(`FUNCTION: ${clean(idx.function)}`)
    if (idx?.technical_domains?.length) personLines.push(`TECHNICAL DOMAINS: ${idx.technical_domains.join(', ')}`)
    if (idx?.business_domains?.length) personLines.push(`BUSINESS DOMAINS: ${idx.business_domains.join(', ')}`)
    if (r?.summary) personLines.push(`RESEARCH SUMMARY: ${clean(r.summary)}`)
    if (r?.hooks?.length) personLines.push(`HOOKS: ${r.hooks.map(clean).filter(Boolean).join('; ')}`)
    if (r?.shared_context?.length) personLines.push(`SHARED CONTEXT: ${r.shared_context.map(clean).filter(Boolean).join('; ')}`)
    if (r?.suggested_ask) personLines.push(`PREVIOUSLY SUGGESTED ASK: ${clean(r.suggested_ask)}`)
    if (idx?.relationship_status && idx.relationship_status !== 'never_contacted') {
      personLines.push(`RELATIONSHIP: ${clean(idx.relationship_note)}`)
    }

    const verified = pFacts.filter((f) => f.type === 'FACT')
    if (verified.length) {
      personLines.push('VERIFIED FACTS:')
      for (const f of verified.slice(0, 8)) personLines.push(`  • ${clean(f.claim)}`)
    }
    const inferences = pFacts.filter((f) => f.type === 'INFERENCE').slice(0, 3)
    if (inferences.length) {
      personLines.push(`INFERENCES (not assertable): ${inferences.map((f) => clean(f.claim)).join('; ')}`)
    }
    if (verified.length === 0 && !r?.summary) {
      personLines.push('NOTE: no stored research on this individual beyond their title and company.')
    }

    out.set(c.id, {
      companyContext,
      personContext: personLines.join('\n'),
      sourcedFacts: verified.slice(0, 8).map((f) => ({ claim: f.claim, sourceUrl: f.source_url })),
      factCount: verified.length,
    })
  }

  return out
}
