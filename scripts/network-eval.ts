// Internal-network retrieval eval.
//
//   npm run eval:network                    all five missions
//   npm run eval:network -- --mission consulting
//   npm run eval:network -- --limit 60      cap classification (first look)
//
// Prints the report to stdout and writes the full result JSON next to it.

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`
}

async function main() {
  const { runNetworkEval } = await import('../evals/network/run')
  const { NETWORK_EVAL_MISSIONS } = await import('../evals/network/missions')
  const { RESUME_ITEMS } = await import('../evals/phase3/user-profile')
  const { createServiceClient } = await import('../lib/supabase/server')

  const supabase = createServiceClient()
  const { data: profiles, error } = await supabase.from('profiles').select('id, email').limit(5)
  if (error || !profiles?.length) {
    console.error('Could not read profiles:', error?.message ?? 'none found')
    process.exit(1)
  }
  const userId = arg('user') ?? profiles[0].id

  const only = arg('mission')
  const missions = only ? NETWORK_EVAL_MISSIONS.filter((m) => m.key === only) : NETWORK_EVAL_MISSIONS
  if (missions.length === 0) {
    console.error(`No mission with key "${only}". Known: ${NETWORK_EVAL_MISSIONS.map((m) => m.key).join(', ')}`)
    process.exit(1)
  }

  const backgroundItems = RESUME_ITEMS.filter((i) => i.credibility !== 'supporting').map((i) => ({
    id: i.id,
    summary: `${i.title} — ${i.org} (${i.period}): ${i.summary}`,
  }))

  const started = Date.now()
  const result = await runNetworkEval({
    userId,
    backgroundItems,
    missions,
    maxClassify: arg('limit') ? Number(arg('limit')) : undefined,
    onProgress: (m) => console.log(m),
  })

  // ─── Report ───
  console.log('\n' + '═'.repeat(78))
  console.log('INTERNAL NETWORK RETRIEVAL — EVAL REPORT')
  console.log('═'.repeat(78))
  console.log(`Search backend: ${result.backend === 'local' ? 'in-memory (migration 013 not applied)' : 'postgres'}`)
  console.log(`Index: ${result.indexed} contacts, ${result.classified} classified`)
  console.log(`Index cost: $${result.indexCostUsd.toFixed(4)} across ${result.indexModelCalls} model calls`)
  console.log(`Elapsed: ${Math.round((Date.now() - started) / 1000)}s`)

  for (const m of result.missions) {
    console.log('\n' + '─'.repeat(78))
    console.log(`${m.mission.label}`)
    console.log('─'.repeat(78))
    console.log(`  pool considered      ${m.poolSize}`)
    console.log(`  survived retrieval   ${m.retrievalPool}   (distinct contacts any search surfaced)`)
    console.log(`  shortlisted          ${m.shortlisted}`)
    console.log(`  Precision@20         ${pct(m.precisionAt20)}`)
    console.log(`  BAD rate@20          ${pct(m.badRateAt20)}`)
    console.log(`  verdicts             ${JSON.stringify(m.verdictCounts)}`)
    console.log(`  decision             ${m.decision.decision} (${m.decision.strongCount} strong / ${m.decision.targetCount} target)`)
    console.log(`  cost                 $${m.costUsd.toFixed(4)} retrieval + $${m.judgeCostUsd.toFixed(4)} judging`)

    console.log('\n  searches:')
    for (const s of m.searches) {
      console.log(`    "${s.query.slice(0, 58)}" → ${s.totalMatches} matches, ${s.returned} shown`)
    }

    console.log('\n  top of the shortlist:')
    for (const [i, t] of m.top20.slice(0, 10).entries()) {
      const rel = t.relationship === 'never_contacted' ? '' : ` [${t.relationship}]`
      console.log(`    ${String(i + 1).padStart(2)}. ${t.verdict.padEnd(19)} ${t.name} — ${t.title ?? '?'} @ ${t.company ?? '?'}${rel}`)
    }

    if (m.missed.length) {
      console.log(`\n  MISSED — surfaced by search, judged GOOD, not shortlisted (${m.missed.length}):`)
      for (const x of m.missed.slice(0, 6)) console.log(`    · ${x.name} — ${x.title ?? '?'} @ ${x.company ?? '?'}`)
    } else {
      console.log('\n  missed: none among the highest-ranked non-shortlisted candidates')
    }

    if (m.missingProfile.length) {
      console.log('\n  network gaps the agent reported:')
      for (const g of m.missingProfile) console.log(`    · ${g}`)
    }
    console.log(`\n  pool assessment: ${m.poolAssessment}`)
    if (m.errors.length) {
      console.log('\n  issues:')
      for (const e of m.errors) console.log(`    · ${e}`)
    }
  }

  console.log('\n' + '═'.repeat(78))
  console.log('TOTALS')
  console.log('═'.repeat(78))
  console.log(`  avg Precision@20        ${pct(result.totals.precisionAt20)}`)
  console.log(`  avg BAD rate@20         ${pct(result.totals.badRateAt20)}`)
  console.log(`  external runs avoided   ${result.totals.externalRunsAvoided}/${result.missions.length}`)
  console.log(`  Apollo credits avoided  ~${result.totals.apolloCreditsAvoided}`)
  console.log(`  retrieval cost          $${result.totals.retrievalCostUsd.toFixed(4)}`)
  console.log(`  judging cost            $${result.totals.judgeCostUsd.toFixed(4)}`)
  console.log(`  index cost (one-off)    $${result.indexCostUsd.toFixed(4)}`)

  const out = path.join(process.cwd(), '.eval-out')
  fs.mkdirSync(out, { recursive: true })
  const file = path.join(out, `network-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(`\nFull result: ${path.relative(process.cwd(), file)}`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
