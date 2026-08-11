// End-to-end smoke test for the agentic scouting pipeline.
//
//   Mission Strategist -> Market Discovery -> Company Validation
//   -> People Scout -> Person Research -> Ranking
//
// Deliberately TINY. This proves the wiring works, not that the output is good —
// quality is the eval loop's job, and running that before this passes would be
// burning money to discover a plumbing bug.
//
//   npm run smoke:agentic
//
// Asserts, and fails loudly on any of:
//   1. agents can call their tools
//   2. agent state is persisted
//   3. web research carries source provenance
//   4. Apollo works
//   5. Supabase persistence works
//   6. Anthropic usage and cost are recorded

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'

const CHECKS: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail: string) {
  CHECKS.push({ name, ok, detail })
}

async function main() {
  const { runScouting } = await import('../lib/scouting/orchestrator')
  const { createServiceClient } = await import('../lib/supabase/server')
  const { setAnthropicBudget } = await import('../lib/providers/anthropic/client')
  const { setApolloBudget } = await import('../lib/providers/apollo/client')

  // Hard ceilings. A wiring bug must not be able to spend real money.
  setAnthropicBudget(Number(process.env.SMOKE_ANTHROPIC_BUDGET ?? 60))
  setApolloBudget(Number(process.env.SMOKE_APOLLO_BUDGET ?? 15))

  const supabase = createServiceClient()
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
  if (!profiles?.length) {
    console.error('FAILED: no profiles row exists to own the run')
    process.exit(1)
  }
  const userId = profiles[0].id as string

  const backgroundItems = RESUME_ITEMS.filter((i) => i.credibility === 'strong')
    .slice(0, 8)
    .map((i) => ({ id: i.id, summary: `${i.title} — ${i.org}: ${i.summary}` }))

  console.log('\nSMOKE TEST — agentic scouting, minimum viable budget\n')
  console.log(`background items: ${backgroundItems.length}`)

  const started = Date.now()

  const result = await runScouting({
    userId,
    label: `smoke-${new Date().toISOString().slice(0, 16)}`,
    mission: {
      goal:
        'Find a high-value winter 2026-27 internship or technical project at the intersection of ' +
        'industrial AI, manufacturing, and chemical/process engineering.',
      timeframe: 'Winter 2026-27 (December 2026 - January 2027)',
      geography: 'United States',
      constraints: ['undergraduate student', 'remote or Midwest/Northeast preferred'],
    },
    backgroundItems,
    budget: {
      maxCompanies: 4,
      maxPeoplePerCompany: 2,
      maxApolloCalls: 15,
      maxWebSearches: 5,
      maxAgentSteps: 6,
    },
    segmentCount: 1,
    companiesPerSegment: 3,
    maxProspects: 3,
    concurrency: 2,
    onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
  })

  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\ncompleted in ${elapsed}s\n`)

  // ─── 1. Agents can call their tools ────────────────────────────────────────
  const totalWebSearches = result.usage.anthropic.webSearches
  check(
    'agents can call their tools',
    totalWebSearches > 0 && result.funnel.companiesDiscovered > 0,
    `${totalWebSearches} server-side web searches; discovery returned ${result.funnel.companiesDiscovered} companies`
  )

  // ─── 2. Agent state is persisted ───────────────────────────────────────────
  const { count: agentRunCount } = await supabase
    .from('agent_runs')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', result.runId ?? '00000000-0000-0000-0000-000000000000')

  const { data: runRow } = await supabase
    .from('scouting_runs')
    .select('id, status, strategy, stats')
    .eq('id', result.runId ?? '00000000-0000-0000-0000-000000000000')
    .maybeSingle()

  check(
    'agent state is persisted',
    Boolean(result.runId) && (agentRunCount ?? 0) > 0 && Boolean(runRow?.strategy),
    `scouting_runs row ${runRow ? `status=${runRow.status}` : 'MISSING'}; ` +
      `${agentRunCount ?? 0} agent_runs rows; strategy ${runRow?.strategy ? 'stored' : 'MISSING'}`
  )

  // ─── 3. Web research has source provenance ─────────────────────────────────
  const { data: factRows } = await supabase
    .from('research_facts')
    .select('id, type, source_url')
    .eq('run_id', result.runId ?? '00000000-0000-0000-0000-000000000000')

  const facts = (factRows ?? []).filter((f) => f.type === 'FACT')
  const sourced = facts.filter((f) => f.source_url && /^https?:\/\//.test(f.source_url))
  check(
    'web research has source provenance',
    facts.length > 0 && sourced.length === facts.length,
    `${factRows?.length ?? 0} claims stored; ${facts.length} typed FACT, ${sourced.length} carry a source URL ` +
      `(${result.persistence.factsRejected} rejected by the DB constraint)`
  )

  // ─── 4. Apollo works ───────────────────────────────────────────────────────
  // Split deliberately: search and enrichment are different entitlements and
  // fail for different reasons. Collapsing them into one check would report
  // "Apollo broken" when in fact only the credit balance is empty.
  const apollo = result.usage.apollo
  check(
    'Apollo search works',
    apollo.calls > 0 && result.funnel.stubsFound > 0,
    `${apollo.calls} calls (${apollo.cachedCalls} cached), ${result.funnel.stubsFound} stubs found`
  )

  const creditError = result.errors.find((e) => /insufficient credits/i.test(e))
  check(
    'Apollo enrichment works',
    result.funnel.peopleEnriched > 0,
    creditError
      ? `BLOCKED: Apollo account has no lead credits (422 insufficient credits). Search is unaffected; ` +
        `enrichment cannot resolve stubs to real people until the plan is topped up.`
      : `${result.funnel.peopleEnriched} people enriched, ${apollo.enrichmentCredits} credits spent`
  )

  // ─── 5. Supabase persistence works ─────────────────────────────────────────
  check(
    'Supabase persistence works',
    !result.persistence.migrationMissing &&
      result.persistence.companiesInserted + result.funnel.companiesValidated > 0,
    `migration missing: ${result.persistence.migrationMissing}; ` +
      `${result.persistence.companiesInserted} companies inserted, ` +
      `${result.persistence.contactsInserted} contacts inserted, ` +
      `${result.persistence.factsInserted} facts inserted`
  )

  // ─── 6. Anthropic usage/cost recorded ──────────────────────────────────────
  const a = result.usage.anthropic
  const { data: costRows } = await supabase
    .from('agent_runs')
    .select('cost_usd, tokens_in, tokens_out')
    .eq('run_id', result.runId ?? '00000000-0000-0000-0000-000000000000')

  const persistedCost = (costRows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
  check(
    'Anthropic usage and cost recorded',
    a.calls > 0 && a.inputTokens > 0 && a.costUsd > 0 && persistedCost > 0,
    `${a.calls} calls, ${a.inputTokens} in / ${a.outputTokens} out tokens, ` +
      `$${a.costUsd.toFixed(4)} in-memory, $${persistedCost.toFixed(4)} persisted across agent_runs`
  )

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log('FUNNEL')
  for (const [k, v] of Object.entries(result.funnel)) console.log(`  ${k.padEnd(22)} ${v}`)

  if (result.peopleFilter) {
    const f = result.peopleFilter
    console.log(`\nPEOPLE FILTER: ${f.seen} seen, ${f.kept} kept`)
    for (const [reason, n] of Object.entries(f.rejected)) console.log(`  rejected ${String(n).padStart(3)}  ${reason}`)
  }

  if (result.rejections.length) {
    console.log('\nREJECTED COMPANIES (why they are not here)')
    for (const r of result.rejections.slice(0, 6)) console.log(`  - ${r.company}: ${r.reason.slice(0, 110)}`)
  }

  if (result.ranked.length) {
    console.log('\nRANKED PROSPECTS')
    for (const p of result.ranked) {
      console.log(`  ${String(p.total).padStart(3)}  ${p.recommendation.padEnd(6)} ${p.person.name} — ${p.person.title ?? '?'} @ ${p.company}`)
      console.log(`       hook: ${p.why_i_fit_them.slice(0, 130)}`)
      if (p.ungrounded_ids.length) console.log(`       UNGROUNDED IDS: ${p.ungrounded_ids.join(', ')}`)
    }
  }

  console.log(`\nCOST: $${result.usage.costUsd.toFixed(4)} total, $${result.usage.costPerRankedProspect.toFixed(4)} per ranked prospect`)

  if (result.errors.length) {
    console.log('\nERRORS SURFACED (not hidden)')
    for (const e of result.errors.slice(0, 10)) console.log(`  - ${e.slice(0, 150)}`)
  }

  console.log('\n' + '─'.repeat(72))
  for (const c of CHECKS) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`)
  }
  console.log('─'.repeat(72))

  const failed = CHECKS.filter((c) => !c.ok)
  if (failed.length === 0) {
    console.log(`ALL ${CHECKS.length} SMOKE CHECKS PASSED — safe to begin eval iteration`)
  } else {
    console.log(`${failed.length} of ${CHECKS.length} SMOKE CHECKS FAILED: ${failed.map((f) => f.name).join(', ')}`)
    console.log('Do NOT start the eval loop until these pass.')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('\nSMOKE TEST CRASHED:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
