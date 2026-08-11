// Persist scouted companies and people into Supabase.
//
// Deterministic upserts — no model involved. Companies dedupe on
// (user_id, domain) or (user_id, normalized_name); people dedupe on
// (user_id, apollo_id), falling back to (user_id, linkedin_url) which V1
// already enforces.
//
// DEGRADES GRACEFULLY: if migration 010 has not been applied yet, every write
// returns a `migrationMissing` result instead of throwing. Migrations in this
// project are applied by hand in the Supabase SQL editor (see CLAUDE.md), so
// the scouting pipeline must not hard-depend on schema the operator may not
// have run.

import { createServiceClient } from '@/lib/supabase/server'
import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'
import { normalizeCompanyName, normalizeDomain } from '@/lib/providers/apollo/normalize'

export interface PersistResult {
  companiesInserted: number
  companiesUpdated: number
  contactsInserted: number
  contactsUpdated: number
  migrationMissing: boolean
  errors: string[]
}

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache/i.test(message)
}

/**
 * Upsert companies, returning a map from our dedupe key to the stored row id so
 * contacts can be linked in the same pass.
 */
export async function persistCompanies(
  userId: string,
  companies: CompanyCandidate[]
): Promise<{ idByKey: Map<string, string>; inserted: number; updated: number; migrationMissing: boolean; errors: string[] }> {
  const supabase = createServiceClient()
  const idByKey = new Map<string, string>()
  const errors: string[] = []
  let inserted = 0
  let updated = 0

  for (const company of companies) {
    const domain = normalizeDomain(company.domain)
    const normalizedName = normalizeCompanyName(company.name)
    const key = domain ? `d:${domain}` : `n:${normalizedName ?? company.name.toLowerCase()}`

    const row = {
      user_id: userId,
      name: company.name,
      domain,
      // Only set when there is no domain — the partial unique index on
      // normalized_name applies to domain-less rows only.
      normalized_name: domain ? null : normalizedName,
      description: company.description,
      industry: company.industry,
      sub_industries: company.sub_industries,
      employee_count: company.employee_count,
      founded_year: company.founded_year,
      hq_location: company.hq_location,
      country: company.country,
      website_url: company.website_url,
      linkedin_url: company.linkedin_url,
      provider_data: { [company.provenance.provider_id]: company.raw },
      status: 'discovered' as const,
    }

    const existingQuery = domain
      ? supabase.from('companies').select('id').eq('user_id', userId).eq('domain', domain).maybeSingle()
      : supabase.from('companies').select('id').eq('user_id', userId).eq('normalized_name', normalizedName).maybeSingle()

    const { data: existing, error: readErr } = await existingQuery
    if (readErr) {
      if (isMissingSchema(readErr.message)) {
        return { idByKey, inserted, updated, migrationMissing: true, errors: [readErr.message] }
      }
      errors.push(`read ${company.name}: ${readErr.message}`)
      continue
    }

    if (existing) {
      const { error } = await supabase.from('companies').update(row).eq('id', existing.id)
      if (error) errors.push(`update ${company.name}: ${error.message}`)
      else updated++
      idByKey.set(key, existing.id)
      continue
    }

    const { data: created, error } = await supabase.from('companies').insert(row).select('id').maybeSingle()
    if (error) {
      if (isMissingSchema(error.message)) {
        return { idByKey, inserted, updated, migrationMissing: true, errors: [error.message] }
      }
      errors.push(`insert ${company.name}: ${error.message}`)
      continue
    }
    if (created) {
      inserted++
      idByKey.set(key, created.id)
      await supabase.from('company_sources').upsert(
        {
          company_id: created.id,
          provider_id: company.provenance.provider_id,
          external_id: company.provenance.external_id ?? null,
          query_ref: company.provenance.query_ref ?? {},
        },
        { onConflict: 'company_id,provider_id,external_id' }
      )
    }
  }

  return { idByKey, inserted, updated, migrationMissing: false, errors }
}

/**
 * Upsert people into the existing `contacts` table, linked to their company.
 *
 * Returns `idByKey` so callers can attach downstream rows — research facts,
 * scores — to the stored contact without a second lookup. The key is the
 * person's LinkedIn URL, else email, else name, matching how the orchestrator
 * identifies a candidate before it has a database id.
 */
export async function persistContacts(
  userId: string,
  people: PersonCandidate[],
  companyIdByKey: Map<string, string>
): Promise<{
  idByKey: Map<string, string>
  inserted: number
  updated: number
  migrationMissing: boolean
  errors: string[]
}> {
  const supabase = createServiceClient()
  const idByKey = new Map<string, string>()
  const errors: string[] = []
  let inserted = 0
  let updated = 0

  for (const person of people) {
    const candidateKey = person.linkedin_url ?? person.email ?? person.name
    const apolloId = person.provenance.external_id ?? null
    const domain = normalizeDomain(person.company_domain)
    const companyKey = domain ? `d:${domain}` : `n:${normalizeCompanyName(person.company_name) ?? ''}`

    const row = {
      user_id: userId,
      name: person.name,
      email: person.email,
      linkedin_url: person.linkedin_url,
      company: person.company_name,          // V1 text column, kept in sync
      company_id: companyIdByKey.get(companyKey) ?? null,
      role: person.title,
      location: person.location,
      source: 'apollo',
      discovery_source: 'apollo',
      seniority: person.seniority,
      department: person.department,
      title_normalized: person.title?.toLowerCase() ?? null,
      email_status: person.email_status,
      apollo_id: apolloId,
      status: 'discovered' as const,
    }

    // Apollo id first (authoritative), LinkedIn URL second (V1's existing key).
    let existingId: string | null = null
    if (apolloId) {
      const { data, error } = await supabase
        .from('contacts').select('id').eq('user_id', userId).eq('apollo_id', apolloId).maybeSingle()
      if (error && isMissingSchema(error.message)) {
        return { idByKey, inserted, updated, migrationMissing: true, errors: [error.message] }
      }
      existingId = data?.id ?? null
    }
    if (!existingId && person.linkedin_url) {
      const { data } = await supabase
        .from('contacts').select('id').eq('user_id', userId).eq('linkedin_url', person.linkedin_url).maybeSingle()
      existingId = data?.id ?? null
    }

    if (existingId) {
      // Never downgrade a contact that has progressed past discovery.
      const { status: _ignored, ...safeUpdate } = row
      const { error } = await supabase.from('contacts').update(safeUpdate).eq('id', existingId)
      if (error) errors.push(`update ${person.name}: ${error.message}`)
      else updated++
      idByKey.set(candidateKey, existingId)
      continue
    }

    const { data: created, error } = await supabase.from('contacts').insert(row).select('id').maybeSingle()
    if (error) {
      if (isMissingSchema(error.message)) {
        return { idByKey, inserted, updated, migrationMissing: true, errors: [error.message] }
      }
      errors.push(`insert ${person.name}: ${error.message}`)
      continue
    }
    if (created) {
      inserted++
      idByKey.set(candidateKey, created.id)
      await supabase.from('contact_sources').upsert(
        {
          contact_id: created.id,
          provider_id: 'apollo',
          external_id: apolloId,
          query_ref: person.provenance.query_ref ?? {},
        },
        { onConflict: 'contact_id,provider_id,external_id' }
      )
    }
  }

  return { idByKey, inserted, updated, migrationMissing: false, errors }
}

export async function persistScoutResults(
  userId: string,
  companies: CompanyCandidate[],
  people: PersonCandidate[]
): Promise<PersistResult> {
  const companyResult = await persistCompanies(userId, companies)
  if (companyResult.migrationMissing) {
    return {
      companiesInserted: 0, companiesUpdated: 0, contactsInserted: 0, contactsUpdated: 0,
      migrationMissing: true,
      errors: ['migration 010_companies_scouting.sql has not been applied'],
    }
  }

  const contactResult = await persistContacts(userId, people, companyResult.idByKey)

  return {
    companiesInserted: companyResult.inserted,
    companiesUpdated: companyResult.updated,
    contactsInserted: contactResult.inserted,
    contactsUpdated: contactResult.updated,
    migrationMissing: contactResult.migrationMissing,
    errors: [...companyResult.errors, ...contactResult.errors],
  }
}
