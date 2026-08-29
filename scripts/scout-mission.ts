// Runs ONE realistic scouting mission end to end and reports the shortlist plus
// a full cost breakdown. This is the prototype's acceptance test.
//
//   npm run scout
//   npm run scout -- --prospects 12
//
// Unlike the eval harness this does not judge anything — it produces the product
// output a person would actually read, and tells you what it cost.

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

async function main() {
  const { runScouting } = await import('../lib/scouting/orchestrator')
  const { createServiceClient } = await import('../lib/supabase/server')
  const { setAnthropicBudget } = await import('../lib/providers/anthropic/client')
  const { setApolloBudget } = await import('../lib/providers/apollo/client')
  const { loadEvidenceBank } = await import('../lib/career/evidence/store')
  const { backgroundForOutreach, toScoutItems } = await import('../lib/outreach/background')

  setAnthropicBudget(Number(process.env.SCOUT_ANTHROPIC_BUDGET ?? 220))
  setApolloBudget(Number(process.env.SCOUT_APOLLO_BUDGET ?? 60))

  const supabase = createServiceClient()
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
  if (!profiles?.length) {
    console.error('no profiles row exists to own the run')
    process.exit(1)
  }
  const userId = profiles[0].id as string

  const goal =
    'Find people who could realistically lead to a strong winter 2026-27 internship or ' +
    'short-term project at the intersection of industrial AI, manufacturing, and chemical ' +
    'or process engineering — people who would also matter for summer 2027 recruiting.'

  // The Evidence Bank is the background; the fixture only when the bank is empty.
  const bankRes = await loadEvidenceBank(userId, { approvedOnly: true })
  const background = backgroundForOutreach(bankRes.bank, { mission: goal, maxExperiences: 12, maxFacts: 24 })
  const items = toScoutItems(background.items)

  const started = Date.now()
  console.log('\nSCOUTING — one realistic winter-recruiting mission\n')
  console.log(
    background.source === 'bank'
      ? `  background: personalized from Evidence (${items.length} items)`
      : `  background: fixture (${items.length} items)${bankRes.migrationMissing ? ' — migration 014 not applied' : ' — the Evidence Bank has no approved experiences'}`
  )

  const result = await runScouting({
    userId,
    label: `prototype/${new Date().toISOString().slice(0, 16)}`,
    mission: {
      goal,
      timeframe: 'Winter 2026-27, with the same relationships relevant to summer 2027',
      geography: 'United States',
      constraints: [
        'undergraduate student, so the ask is an internship, a short project, advice, or a referral',
        'must be a person who could plausibly reply to a well-written cold email',
      ],
    },
    backgroundItems: items,
    budget: {
      maxCompanies: 16,
      maxPeoplePerCompany: 5,
      maxApolloCalls: 60,
      maxWebSearches: 4,
      maxAgentSteps: 6,
    },
    segmentCount: arg('segments', 3),
    companiesPerSegment: arg('companies', 5),
    // Enrich a reasonable pool, but only deep-research the few that survive triage.
    maxProspects: arg('pool', 40),
    maxDeepResearch: arg('prospects', 15),
    researchPerCompany: arg('perCompany', 2),
    maxDiscoveryRounds: 2,
    maxRescoutRounds: 0,
    concurrency: 5,
    onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
  })

  const elapsed = (Date.now() - started) / 1000

  // ─── The product output ────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(78)}\nSHORTLIST — ${result.ranked.length} prospects\n${'═'.repeat(78)}`)
  for (const [i, p] of result.ranked.entries()) {
    console.log(
      `\n${String(i + 1).padStart(2)}. ${p.person.name} — ${p.person.title ?? '?'}` +
        `\n    ${p.company}  ·  score ${p.total}  ·  ${p.recommendation}` +
        `\n    why them : ${p.why_they_fit.slice(0, 150)}` +
        `\n    why you  : ${p.why_i_fit_them.slice(0, 150)}` +
        `\n    evidence : ${p.resume_item_ids.join(', ') || 'none cited'}` +
        `\n    contact  : ${p.person.email ?? 'no email'} · ${p.person.linkedin_url ?? 'no linkedin'}`
    )
  }

  // ─── Cost ──────────────────────────────────────────────────────────────────
  const u = result.usage
  console.log(`\n${'═'.repeat(78)}\nCOST\n${'═'.repeat(78)}`)
  console.log(`  Anthropic total       $${u.costUsd.toFixed(2)}`)
  console.log(`  Apollo credits        ${u.apollo.enrichmentCredits}`)
  console.log(`  Apollo calls          ${u.apollo.calls}`)
  console.log(`  Web searches          ${u.anthropic.webSearches}`)
  console.log(`  Model calls           ${u.anthropic.calls}`)
  console.log(`  Runtime               ${elapsed.toFixed(0)}s`)
  console.log(`  Cost per prospect     $${(result.ranked.length ? u.costUsd / result.ranked.length : 0).toFixed(2)}`)

  console.log('\n  BY AGENT')
  const rows = Object.entries(u.byAgent).sort((a, b) => b[1].costUsd - a[1].costUsd)
  for (const [agent, v] of rows) {
    const share = u.costUsd > 0 ? ((v.costUsd / u.costUsd) * 100).toFixed(0) : '0'
    console.log(
      `    ${agent.padEnd(20)} $${v.costUsd.toFixed(2).padStart(6)}  ${String(share).padStart(3)}%  ` +
        `${String(v.calls).padStart(3)} calls, ${v.webSearches} searches`
    )
  }

  console.log('\n  BY MODEL TIER')
  for (const [tier, v] of Object.entries(u.anthropic.byTier)) {
    console.log(`    ${tier.padEnd(20)} $${v.costUsd.toFixed(2).padStart(6)}  ${String(v.calls).padStart(3)} calls`)
  }

  console.log('\n  FUNNEL')
  for (const [k, v] of Object.entries(result.funnel)) console.log(`    ${k.padEnd(22)} ${v}`)

  if (result.errors.length) {
    console.log('\n  ERRORS SURFACED')
    for (const e of result.errors.slice(0, 8)) console.log(`    - ${e.slice(0, 150)}`)
  }

  fs.mkdirSync(path.join(process.cwd(), '.eval-runs'), { recursive: true })
  fs.writeFileSync(
    path.join(process.cwd(), '.eval-runs', 'prototype-run.json'),
    JSON.stringify({ elapsed, backgroundSource: background.source, backgroundItems: items.length, funnel: result.funnel, usage: u, ranked: result.ranked }, null, 2)
  )
  console.log('\nwritten to .eval-runs/prototype-run.json')
}

main().catch((e) => {
  console.error('\nSCOUT FAILED:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
