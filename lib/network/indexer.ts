// Builds and refreshes `contact_index`.
//
// Deterministic orchestration around one cheap agent. Everything expensive is
// gated on a content hash, so the second run over an unchanged database costs
// zero model calls and the run after a scouting sweep costs one batch.
//
// DEGRADES GRACEFULLY: without migration 013 this reports `migrationMissing`
// rather than throwing, matching lib/scouting/persist.ts. Migrations here are
// applied by hand.

import { createServiceClient } from '@/lib/supabase/server'
import { runContactClassifier, contactClassifierPrompt, type ContactClassification } from '@/lib/agents/contact-classifier'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { anthropicUsage } from '@/lib/providers/anthropic/client'
import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { buildDocument, INDEX_VERSION, type ContactMaterial } from './document'
import { loadRelationshipHistory, emptyHistory } from './relationship'

export interface IndexOptions {
  userId: string
  /** Re-classify everything, ignoring the hash. Only for a taxonomy change. */
  force?: boolean
  /** Stop after N classifications. Bounds a first run you want to sample. */
  maxClassify?: number
  batchSize?: number
  concurrency?: number
  onProgress?: (message: string) => void
}

export interface IndexResult {
  migrationMissing: boolean
  contactsSeen: number
  rowsWritten: number
  classified: number
  skippedUnchanged: number
  costUsd: number
  modelCalls: number
  errors: string[]
}

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache/i.test(message)
}

/** Supabase caps a select at 1000 rows; every load here is paginated. */
async function loadAll<T>(
  // PromiseLike, not Promise: a Supabase query builder is thenable but is not a
  // Promise, so requiring Promise here rejects every real call site.
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) return { rows, error: error.message }
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return { rows, error: null }
}

interface ContactRow {
  id: string
  name: string
  role: string | null
  company: string | null
  location: string | null
  seniority: string | null
  department: string | null
  email: string | null
  linkedin_url: string | null
  tags: string[] | null
  notes: string | null
  status: string | null
  company_id: string | null
}

/** Everything the index is built from, loaded in six paginated queries. */
export async function loadContactMaterial(
  userId: string
): Promise<{ material: ContactMaterial[]; errors: string[] }> {
  const supabase = createServiceClient()
  const errors: string[] = []

  const contacts = await loadAll<ContactRow>((from, to) =>
    supabase
      .from('contacts')
      .select('id,name,role,company,location,seniority,department,email,linkedin_url,tags,notes,status,company_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .range(from, to)
  )
  if (contacts.error) errors.push(`contacts: ${contacts.error}`)

  const research = await loadAll<{
    contact_id: string
    summary: string | null
    hooks: string[] | null
    shared_context: string[] | null
    category: string | null
    suggested_ask: string | null
    relevance_score: number | null
  }>((from, to) =>
    supabase
      .from('contact_research')
      .select('contact_id,summary,hooks,shared_context,category,suggested_ask,relevance_score')
      .range(from, to)
  )
  if (research.error) errors.push(`contact_research: ${research.error}`)

  const companies = await loadAll<{
    id: string
    name: string
    description: string | null
    industry: string | null
    sub_industries: string[] | null
    employee_count: number | null
    stage: string | null
    hq_location: string | null
  }>((from, to) =>
    supabase
      .from('companies')
      .select('id,name,description,industry,sub_industries,employee_count,stage,hq_location')
      .eq('user_id', userId)
      .range(from, to)
  )
  if (companies.error) errors.push(`companies: ${companies.error}`)

  const facts = await loadAll<{ contact_id: string | null; company_id: string | null; claim: string; type: string }>(
    (from, to) =>
      supabase
        .from('research_facts')
        .select('contact_id,company_id,claim,type')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to)
  )
  if (facts.error) errors.push(`research_facts: ${facts.error}`)

  const researchByContact = new Map(research.rows.map((r) => [r.contact_id, r]))
  const companyById = new Map(companies.rows.map((c) => [c.id, c]))

  const factsByContact = new Map<string, { claim: string; type: string }[]>()
  const factsByCompany = new Map<string, { claim: string; type: string }[]>()
  for (const f of facts.rows) {
    if (f.contact_id) {
      const list = factsByContact.get(f.contact_id) ?? []
      if (list.length < 14) list.push({ claim: f.claim, type: f.type })
      factsByContact.set(f.contact_id, list)
    } else if (f.company_id) {
      const list = factsByCompany.get(f.company_id) ?? []
      if (list.length < 8) list.push({ claim: f.claim, type: f.type })
      factsByCompany.set(f.company_id, list)
    }
  }

  const material: ContactMaterial[] = contacts.rows.map((c) => {
    const r = researchByContact.get(c.id) ?? null
    const co = c.company_id ? companyById.get(c.company_id) ?? null : null
    return {
      id: c.id,
      name: c.name,
      title: c.role,
      company: c.company,
      location: c.location,
      seniority: c.seniority,
      department: c.department,
      email: c.email,
      linkedin: c.linkedin_url,
      tags: c.tags ?? [],
      notes: c.notes,
      status: c.status,
      research: r
        ? {
            summary: r.summary,
            hooks: r.hooks ?? [],
            sharedContext: r.shared_context ?? [],
            category: r.category,
            suggestedAsk: r.suggested_ask,
            relevanceScore: r.relevance_score,
          }
        : null,
      facts: factsByContact.get(c.id) ?? [],
      company_profile: co
        ? {
            name: co.name,
            description: co.description,
            industry: co.industry,
            subIndustries: co.sub_industries ?? [],
            employeeCount: co.employee_count,
            stage: co.stage,
            hqLocation: co.hq_location,
          }
        : null,
      companyFacts: c.company_id ? factsByCompany.get(c.company_id) ?? [] : [],
    }
  })

  return { material, errors }
}

/** One index row, exactly as it is written to `contact_index`. */
export type IndexRow = {
  contact_id: string
  user_id: string
  headline: string
  tags_text: string
  body_text: string
  seniority_band: string
  function_area: string
  geo_city: string | null
  geo_state: string | null
  geo_country: string | null
  geo_region: string
  company_name: string | null
  company_norm: string | null
  industry: string | null
  sub_industry: string | null
  function: string | null
  company_type: string | null
  company_stage: string | null
  technical_domains: string[]
  business_domains: string[]
  opportunity_types: string[]
  tags: string[]
  relevance: Record<string, number>
  classification_note: string | null
  relationship_status: string
  relationship_note: string
  touches: number
  replies: number
  last_contacted_at: string | null
  last_reply_at: string | null
  evidence_level: string
  source_hash: string
  index_version: string
  classifier_version: string | null
  classified_at: string | null
  indexed_at: string
}

export interface BuildRowsResult extends IndexResult {
  rows: IndexRow[]
  /** Names and titles, so a caller without `contacts` loaded can still render. */
  identities: Map<string, { name: string; title: string | null; email: string | null; linkedin: string | null; location: string | null }>
}

/**
 * Build every index row in memory: load, normalize, classify, assemble.
 *
 * Split out from the write so the eval harness can measure retrieval over real
 * contacts without depending on migration 013 having been applied by hand.
 */
export async function buildIndexRows(opts: IndexOptions): Promise<BuildRowsResult> {
  const log = opts.onProgress ?? (() => {})
  const supabase = createServiceClient()
  const batchSize = opts.batchSize ?? 15
  const concurrency = opts.concurrency ?? 4

  const result: BuildRowsResult = {
    migrationMissing: false,
    contactsSeen: 0,
    rowsWritten: 0,
    classified: 0,
    skippedUnchanged: 0,
    costUsd: 0,
    modelCalls: 0,
    errors: [],
    rows: [],
    identities: new Map(),
  }

  const { material, errors } = await loadContactMaterial(opts.userId)
  result.errors.push(...errors.slice(0, 5))
  result.contactsSeen = material.length
  log(`loaded ${material.length} contacts`)
  for (const m of material) {
    result.identities.set(m.id, { name: m.name, title: m.title, email: m.email, linkedin: m.linkedin, location: m.location })
  }

  if (material.length === 0) return result

  const history = await loadRelationshipHistory(opts.userId)
  result.errors.push(...history.degraded.slice(0, 3))

  // ─── What already exists, and at what version ───
  // A missing table is not fatal here: rows can still be built in memory. Only
  // the write step needs migration 013.
  const existing = await loadAll<{
    contact_id: string
    source_hash: string | null
    classifier_version: string | null
    index_version: string | null
  }>((from, to) =>
    supabase
      .from('contact_index')
      .select('contact_id,source_hash,classifier_version,index_version')
      .eq('user_id', opts.userId)
      .range(from, to)
  )
  if (existing.error) {
    if (isMissingSchema(existing.error)) result.migrationMissing = true
    else result.errors.push(`contact_index read: ${existing.error}`)
  }
  const existingByContact = new Map(existing.rows.map((r) => [r.contact_id, r]))

  // ─── Build documents (free) ───
  const built = material.map((m) => ({
    material: m,
    doc: buildDocument(m, history.byContact.get(m.id) ?? emptyHistory()),
    history: history.byContact.get(m.id) ?? emptyHistory(),
  }))

  // ─── Decide who needs the model ───
  const stale = built.filter((b) => {
    if (opts.force) return true
    const prior = existingByContact.get(b.material.id)
    if (!prior) return true
    return prior.source_hash !== b.doc.sourceHash || prior.classifier_version !== contactClassifierPrompt.version
  })
  result.skippedUnchanged = built.length - stale.length

  const toClassify = opts.maxClassify ? stale.slice(0, opts.maxClassify) : stale
  log(
    `${toClassify.length} need classification, ${result.skippedUnchanged} unchanged` +
      (toClassify.length < stale.length ? ` (capped from ${stale.length})` : '')
  )

  // ─── Classify, in batches, concurrently ───
  const classifications = new Map<string, ContactClassification>()
  if (toClassify.length > 0) {
    const ctx: ToolContext = {
      user_id: opts.userId,
      run_id: null,
      budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 3 },
    }

    const batches: (typeof toClassify)[] = []
    for (let i = 0; i < toClassify.length; i += batchSize) batches.push(toClassify.slice(i, i + batchSize))

    let done = 0
    const outputs = await mapWithConcurrency(batches, concurrency, async (batch) => {
      const run = await runContactClassifier(
        { contacts: batch.map((b) => ({ id: b.material.id, material: b.doc.classifierInput })) },
        ctx
      )
      done++
      if (done % 5 === 0 || done === batches.length) log(`classified batch ${done}/${batches.length}`)
      if (!run.output) {
        // One failed batch must not stop the index. Those contacts are still
        // written with their deterministic fields and no classification, and
        // the next run picks them up because their hash never matched.
        result.errors.push(`classifier batch failed: ${run.error}`)
        return []
      }
      return run.output.classifications
    })

    for (const list of outputs) {
      for (const c of list) classifications.set(c.id, c)
    }
    result.classified = classifications.size
  }

  result.rows = built.map((b) => {
    const c = classifications.get(b.material.id)
    const prior = existingByContact.get(b.material.id)
    const n = b.doc.normalized
    const h = b.history
    return {
      contact_id: b.material.id,
      user_id: opts.userId,
      headline: b.doc.headline,
      // Classification tags belong in the weight-B band, so a search for
      // "industrial AI" matches the tag rather than only a prose mention.
      tags_text: [
        b.doc.tagsText,
        c
          ? [c.industry, c.sub_industry, c.function, c.company_type, ...c.technical_domains, ...c.business_domains, ...c.opportunity_types, ...c.tags]
              .filter(Boolean)
              .join(' · ')
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      body_text: [b.doc.bodyText, c?.note ?? ''].filter(Boolean).join('\n'),
      seniority_band: n.seniorityBand,
      function_area: n.functionArea,
      geo_city: n.geo.city,
      geo_state: n.geo.state,
      geo_country: n.geo.country,
      geo_region: n.geo.region,
      company_name: b.material.company,
      company_norm: n.companyNorm,
      industry: c?.industry ?? null,
      sub_industry: c?.sub_industry ?? null,
      function: c?.function ?? null,
      company_type: c?.company_type ?? null,
      company_stage: c?.company_stage ?? null,
      technical_domains: c?.technical_domains ?? [],
      business_domains: c?.business_domains ?? [],
      opportunity_types: c?.opportunity_types ?? [],
      tags: c?.tags ?? [],
      relevance: c?.relevance ?? {},
      classification_note: c?.note ?? null,
      relationship_status: h.status,
      relationship_note: h.note,
      touches: h.touches,
      replies: h.replies,
      last_contacted_at: h.lastContactedAt,
      last_reply_at: h.lastReplyAt,
      evidence_level: b.doc.evidenceLevel,
      source_hash: b.doc.sourceHash,
      index_version: INDEX_VERSION,
      // Only stamp the classifier version when this row actually carries a
      // classification. Stamping it otherwise would mark a failed batch as done
      // and it would never be retried.
      classifier_version: c ? contactClassifierPrompt.version : prior?.classifier_version ?? null,
      classified_at: c ? new Date().toISOString() : null,
      indexed_at: new Date().toISOString(),
    }
  })

  const usage = anthropicUsage()
  result.costUsd = usage.costUsd
  result.modelCalls = usage.calls
  return result
}

export async function buildContactIndex(opts: IndexOptions): Promise<IndexResult> {
  const log = opts.onProgress ?? (() => {})
  const supabase = createServiceClient()

  const built = await buildIndexRows(opts)
  if (built.rows.length === 0) return built

  for (let i = 0; i < built.rows.length; i += 200) {
    const chunk = built.rows.slice(i, i + 200)
    const { error } = await supabase.from('contact_index').upsert(chunk, { onConflict: 'contact_id' })
    if (error) {
      if (isMissingSchema(error.message)) {
        return { ...built, migrationMissing: true, errors: [...built.errors, 'migration 013 not applied'] }
      }
      built.errors.push(`upsert rows ${i}-${i + chunk.length}: ${error.message.slice(0, 120)}`)
      continue
    }
    built.rowsWritten += chunk.length
  }

  log(`wrote ${built.rowsWritten} index rows`)
  return built
}

