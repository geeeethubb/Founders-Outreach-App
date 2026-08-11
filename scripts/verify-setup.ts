// Verifies the three things that must be true before agentic scouting can run:
//   1. APOLLO_API_KEY works        (free auth/health endpoint — zero credits)
//   2. ANTHROPIC_API_KEY works     (smallest possible Messages call)
//   3. Migration 010 is applied    (schema present AND a real write/read round-trip)
//
// NEVER prints a credential. Only presence, length class, and outcome.
//
//   npm run verify:setup

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

type Check = { name: string; ok: boolean; detail: string }
const results: Check[] = []

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`)
}

/** Safe to log: says a secret exists and is plausibly shaped, never what it is. */
function shape(v: string | undefined): string {
  if (!v) return 'not set'
  return `set (${v.length} chars)`
}

// ─── 1. Apollo ───────────────────────────────────────────────────────────────
// auth/health is Apollo's own credential check. It consumes no search or lead
// credits, which matters because this account's lead credits are exhausted.

async function checkApollo() {
  const key = process.env.APOLLO_API_KEY
  if (!key) return record('Apollo credential', false, 'APOLLO_API_KEY is not set in the environment')

  try {
    const res = await fetch('https://api.apollo.io/api/v1/auth/health', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': key },
    })
    const text = await res.text()
    let body: any = null
    try { body = JSON.parse(text) } catch { /* keep raw */ }

    if (!res.ok) {
      return record('Apollo credential', false, `HTTP ${res.status} from auth/health — ${text.slice(0, 160)}`)
    }
    const loggedIn = body?.is_logged_in === true
    record(
      'Apollo credential',
      loggedIn,
      loggedIn
        ? `key ${shape(key)}, authenticated against api.apollo.io (auth/health, 0 credits)`
        : `authenticated request returned is_logged_in=${String(body?.is_logged_in)} — ${text.slice(0, 160)}`
    )
  } catch (e) {
    record('Apollo credential', false, `network error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── 2. Anthropic ────────────────────────────────────────────────────────────
// Goes through the provider abstraction, not the raw SDK, so this also proves
// the wiring the agents will use.

async function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return record('Anthropic credential', false, 'ANTHROPIC_API_KEY is not set in the environment')

  try {
    const { anthropicComplete, anthropicUsage, resetAnthropicUsage } = await import('../lib/providers/anthropic/client')
    resetAnthropicUsage()

    const out = await anthropicComplete({
      role: 'fast',
      system: 'Reply with exactly one word.',
      messages: [{ role: 'user', content: 'Say OK.' }],
      maxTokens: 16,
    })

    const usage = anthropicUsage()
    const text = out.text.trim()
    record(
      'Anthropic credential',
      text.length > 0,
      `key ${shape(key)}, model ${out.model} replied ${JSON.stringify(text.slice(0, 40))} ` +
        `(in ${usage.inputTokens} / out ${usage.outputTokens} tokens, ~$${usage.costUsd.toFixed(6)})`
    )
  } catch (e) {
    record('Anthropic credential', false, e instanceof Error ? e.message : String(e))
  }
}

// ─── 3. Supabase migration 010 ───────────────────────────────────────────────
// Schema presence is necessary but not sufficient — RLS, constraints and the
// partial unique indexes only reveal themselves on a real write. So this does a
// full round-trip through the production persistence path and cleans up after
// itself.

async function checkMigration() {
  let supabase: any
  try {
    const { createServiceClient } = await import('../lib/supabase/server')
    supabase = createServiceClient()
  } catch (e) {
    return record('Supabase migration 010', false, `cannot create service client: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 3a. Schema presence.
  const probes: Array<[string, () => any]> = [
    ['companies', () => supabase.from('companies').select('id, name, domain, normalized_name, description, status, filtered_reason').limit(1)],
    ['company_sources', () => supabase.from('company_sources').select('id, company_id, provider_id, external_id, query_ref, raw').limit(1)],
    ['contact_sources', () => supabase.from('contact_sources').select('id, contact_id, provider_id, external_id').limit(1)],
    ['contacts.company_id', () => supabase.from('contacts').select('company_id').limit(1)],
    ['contacts.apollo_id', () => supabase.from('contacts').select('apollo_id').limit(1)],
    ['contacts.seniority', () => supabase.from('contacts').select('seniority, department, title_normalized, email_status, discovery_source').limit(1)],
  ]

  const missing: string[] = []
  for (const [label, q] of probes) {
    const { error } = await q()
    if (error) missing.push(`${label} (${error.message.slice(0, 60)})`)
  }
  if (missing.length) {
    return record('Supabase migration 010', false, `schema not applied — missing: ${missing.join('; ')}`)
  }

  // 3b. Live write/read round-trip through lib/scouting/persist.ts.
  const { data: profiles, error: pErr } = await supabase.from('profiles').select('id').limit(1)
  if (pErr || !profiles?.length) {
    return record('Supabase migration 010', false, `schema present, but no profiles row to own the test write (${pErr?.message ?? 'empty'})`)
  }
  const userId = profiles[0].id as string
  const marker = `verify-setup-${Date.now()}`
  const testDomain = `${marker}.invalid`

  try {
    const { persistCompanies } = await import('../lib/scouting/persist')
    const res = await persistCompanies(userId, [
      {
        name: `Verify Setup Co ${marker}`,
        domain: testDomain,
        description: 'Temporary row written by scripts/verify-setup.ts. Safe to delete.',
        industry: 'test',
        sub_industries: [],
        employee_count: 1,
        employee_range: null,
        stage: null,
        founded_year: null,
        hq_location: null,
        country: null,
        website_url: `https://${testDomain}`,
        linkedin_url: null,
        raw: { marker },
        provenance: {
          provider_id: 'verify-setup',
          external_id: marker,
          query_ref: { marker },
          retrieved_at: new Date().toISOString(),
        },
      },
    ])

    if (res.migrationMissing) {
      return record('Supabase migration 010', false, 'persist layer reported migrationMissing on write')
    }
    if (res.errors.length) {
      return record('Supabase migration 010', false, `write failed: ${res.errors.join('; ').slice(0, 200)}`)
    }

    // Read it back — proves the row is actually queryable, not just accepted.
    const { data: readBack, error: rErr } = await supabase
      .from('companies')
      .select('id, name, domain')
      .eq('user_id', userId)
      .eq('domain', testDomain)
      .maybeSingle()

    if (rErr || !readBack) {
      return record('Supabase migration 010', false, `write reported success but read-back failed: ${rErr?.message ?? 'no row'}`)
    }

    const { count: srcCount } = await supabase
      .from('company_sources')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', readBack.id)

    // Clean up. company_sources cascades on company delete.
    await supabase.from('companies').delete().eq('id', readBack.id)

    const { data: gone } = await supabase.from('companies').select('id').eq('id', readBack.id).maybeSingle()

    record(
      'Supabase migration 010',
      !gone,
      `schema applied; wrote company + ${srcCount ?? 0} provenance row(s), read back, deleted cleanly ` +
        `(inserted=${res.inserted}, updated=${res.updated})`
    )
  } catch (e) {
    record('Supabase migration 010', false, `round-trip threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  console.log('\nVerifying credentials and schema — no secret values are printed.\n')
  await checkApollo()
  await checkAnthropic()
  await checkMigration()

  const failed = results.filter((r) => !r.ok)
  console.log('─'.repeat(70))
  if (failed.length === 0) {
    console.log(`ALL ${results.length} CHECKS PASSED`)
  } else {
    console.log(`${failed.length} of ${results.length} CHECKS FAILED: ${failed.map((f) => f.name).join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('verify-setup crashed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
