// Agentic scouting evaluation.
//
//   npm run eval:agentic -- <tag> [profileId ...]
//
//   npm run eval:agentic -- baseline                       all five profiles
//   npm run eval:agentic -- fix1 operations-industrial-consulting   one profile
//
// Targeted runs exist because re-running all five after every change is
// expensive in both Anthropic spend and Apollo credits. Fix consulting, measure
// consulting; only run the full suite once the targeted metric has moved.
//
// Results are written to .eval-runs/<tag>.json so runs can be compared.

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

import { EVAL_PROFILES, profileById, type EvalProfile } from '../evals/agentic/profiles'
import { RESUME_ITEMS } from '../evals/phase3/user-profile'
import {
  judgeProspects,
  judgeCompanies,
  judgeBestPerson,
  type JudgeVerdict,
} from '../evals/agentic/judge'
import {
  THRESHOLDS,
  classifyRecovery,
  computeCompanyRate,
  computeEfficiency,
  computePrecision,
  pct,
  recoveryRate,
  type RecoveryCase,
} from '../evals/agentic/metrics'

const OUT_DIR = path.join(process.cwd(), '.eval-runs')

// Top-N judged for Precision@20. 20 is the brief's metric.
const TOP_N = Number(process.env.EVAL_TOP_N ?? 20)

interface ProfileReport {
  profileId: string
  profileName: string
  runId: string | null
  precision: ReturnType<typeof computePrecision>
  discovery: ReturnType<typeof computeCompanyRate>
  rejection: ReturnType<typeof computeCompanyRate>
  recovery: RecoveryCase[]
  bestPerson: { n: number; hits: number; rate: number }
  efficiency: ReturnType<typeof computeEfficiency>
  funnel: Record<string, number>
  topProspects: { name: string; title: string | null; company: string; total: number; verdict: JudgeVerdict; why: string }[]
  badExamples: { name: string; company: string; reasoning: string }[]
  wrongRejections: { company: string; reasoning: string }[]
  diagnoses: Record<string, number>
  errors: string[]
}

function backgroundItems() {
  // Retrieved summaries, never the full resume (ADR-005). Strong + moderate
  // credibility items give the agents enough to find real overlaps without
  // pasting a CV into every prompt.
  return RESUME_ITEMS.filter((i) => i.credibility !== 'supporting').map((i) => ({
    id: i.id,
    summary: `${i.title} — ${i.org} (${i.period}): ${i.summary}`,
  }))
}

async function runProfile(profile: EvalProfile, userId: string): Promise<ProfileReport> {
  const { runScouting } = await import('../lib/scouting/orchestrator')
  const items = backgroundItems()
  const backgroundSummary = items.map((b) => `  [${b.id}] ${b.summary}`).join('\n')

  console.log(`\n${'═'.repeat(76)}\n▶ ${profile.name}\n${'═'.repeat(76)}`)

  const result = await runScouting({
    userId,
    label: `agentic-eval/${profile.id}`,
    mission: {
      goal: profile.goal,
      timeframe: profile.timeframe,
      geography: profile.geography,
      constraints: profile.constraints,
    },
    backgroundItems: items,
    budget: {
      maxCompanies: 18,
      maxPeoplePerCompany: 3,
      maxApolloCalls: 90,
      maxWebSearches: 5,
      maxAgentSteps: 6,
    },
    // Overridable so the harness itself can be validated cheaply before a full
    // run. Defaults are sized to produce ~20 rankable prospects per profile.
    segmentCount: Number(process.env.EVAL_SEGMENTS ?? profile.segmentCount),
    companiesPerSegment: Number(process.env.EVAL_COMPANIES_PER_SEGMENT ?? 7),
    maxProspects: Number(process.env.EVAL_MAX_PROSPECTS ?? 26),
    maxDiscoveryRounds: Number(process.env.EVAL_DISCOVERY_ROUNDS ?? 3),
    maxRescoutRounds: Number(process.env.EVAL_RESCOUT_ROUNDS ?? 1),
    concurrency: Number(process.env.EVAL_CONCURRENCY ?? 4),
    onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
  })

  // ─── Precision@20 ──────────────────────────────────────────────────────────
  const top = result.ranked.slice(0, TOP_N)
  const judgeInputs = top.map((p) => ({
    candidate_id: p.candidate_key,
    name: p.person.name,
    title: p.person.title,
    company: p.company,
    company_description:
      result.enrichedCompanies.find((c) => c.name === p.company)?.description ??
      p.person.company_name ??
      'unknown',
    person_summary: p.why_they_fit || 'no research summary available',
    location: p.person.location,
  }))

  const judged = await judgeProspects(profile.goal, backgroundSummary, judgeInputs)
  const verdictById = new Map(judged.results.map((j) => [j.candidate_id, j]))
  const verdicts = top.map((p) => verdictById.get(p.candidate_key)?.verdict ?? 'BAD')
  const precision = computePrecision(verdicts)

  // ─── Market discovery precision ────────────────────────────────────────────
  const discoveryJudged = await judgeCompanies(profile.goal, result.enrichedCompanies, 'targets')
  const discovery = computeCompanyRate(discoveryJudged.results.map((r) => r.verdict))

  // ─── Company rejection accuracy ────────────────────────────────────────────
  const rejectedSample = result.rejections.slice(0, 12).map((r) => ({
    name: r.company,
    description: 'see the assistant note',
    note: r.reason,
  }))
  const rejectionJudged = await judgeCompanies(profile.goal, rejectedSample, 'rejections')
  const rejection = computeCompanyRate(rejectionJudged.results.map((r) => r.verdict))

  // ─── Best-person hit rate ──────────────────────────────────────────────────
  // Only inside companies that reached Apollo, and only where alternatives
  // existed — "was this the best person?" is meaningless with a pool of one.
  const bestPersonCases = top.slice(0, 12).map((p) => {
    const pool = result.candidatePool[p.company] ?? []
    const chosen = `${p.person.name} — ${p.person.title ?? 'unknown'}`
    return {
      company: p.company,
      company_description: result.enrichedCompanies.find((c) => c.name === p.company)?.description ?? 'unknown',
      chosen,
      alternatives: pool.filter((a) => !a.startsWith(p.person.name.split(' ')[0])).slice(0, 12),
    }
  })
  const bestJudged = await judgeBestPerson(profile.goal, bestPersonCases)
  const hits = bestJudged.results.filter((r) => r.hit).length
  const bestPerson = {
    n: bestJudged.results.length,
    hits,
    rate: bestJudged.results.length > 0 ? hits / bestJudged.results.length : 0,
  }

  // ─── Search recovery ───────────────────────────────────────────────────────
  const recovery = classifyRecovery(result.discoveryHistory)

  const diagnoses: Record<string, number> = {}
  for (const h of result.discoveryHistory) {
    for (const r of h.rounds) diagnoses[r.diagnosis] = (diagnoses[r.diagnosis] ?? 0) + 1
  }

  // ─── Efficiency ────────────────────────────────────────────────────────────
  const judgeCost = judged.costUsd + discoveryJudged.costUsd + rejectionJudged.costUsd + bestJudged.costUsd
  const efficiency = computeEfficiency({
    apolloSearchCalls: result.usage.apollo.calls,
    enrichmentCredits: result.usage.apollo.enrichmentCredits,
    peopleEnriched: result.funnel.peopleEnriched,
    goodProspects: precision.good,
    webSearches: result.usage.anthropic.webSearches,
    modelCalls: result.usage.anthropic.calls,
    // Pipeline cost only. Judge spend is eval overhead, not product cost.
    anthropicCostUsd: result.usage.costUsd,
  })

  const errors = [...result.errors]
  for (const [label, e] of [
    ['judge', judged.error],
    ['discovery-judge', discoveryJudged.error],
    ['rejection-judge', rejectionJudged.error],
    ['bestperson-judge', bestJudged.error],
  ] as const) {
    if (e) errors.push(`${label}: ${e}`)
  }

  const report: ProfileReport = {
    profileId: profile.id,
    profileName: profile.name,
    runId: result.runId,
    precision,
    discovery,
    rejection,
    recovery,
    bestPerson,
    efficiency,
    funnel: result.funnel as unknown as Record<string, number>,
    topProspects: top.map((p) => ({
      name: p.person.name,
      title: p.person.title,
      company: p.company,
      total: p.total,
      verdict: verdictById.get(p.candidate_key)?.verdict ?? 'BAD',
      why: p.why_i_fit_them.slice(0, 160),
    })),
    badExamples: top
      .filter((p) => verdictById.get(p.candidate_key)?.verdict === 'BAD')
      .map((p) => ({
        name: p.person.name,
        company: p.company,
        reasoning: verdictById.get(p.candidate_key)?.reasoning ?? '',
      })),
    wrongRejections: rejectionJudged.results
      .filter((r) => r.verdict === 'BAD')
      .map((r) => ({ company: r.company, reasoning: r.reasoning })),
    diagnoses,
    errors,
  }

  console.log(
    `\n  Precision@${TOP_N}: ${pct(precision.precision)} (${precision.good}G/${precision.maybe}M/${precision.bad}B of ${precision.n})  ` +
      `BAD rate ${pct(precision.badRate)}  |  discovery ${pct(discovery.rate)}  rejection ${pct(rejection.rate)}  ` +
      `best-person ${pct(bestPerson.rate)}  |  $${result.usage.costUsd.toFixed(2)}, ${result.usage.apollo.enrichmentCredits} credits`
  )

  return report
}

async function main() {
  const args = process.argv.slice(2)
  const tag = args[0] ?? `run-${Date.now()}`
  const requested = args.slice(1)
  const profiles = requested.length
    ? requested.map((id) => {
        const p = profileById(id)
        if (!p) throw new Error(`unknown profile "${id}". Valid: ${EVAL_PROFILES.map((x) => x.id).join(', ')}`)
        return p
      })
    : EVAL_PROFILES

  const { createServiceClient } = await import('../lib/supabase/server')
  const { setAnthropicBudget } = await import('../lib/providers/anthropic/client')
  const { setApolloBudget } = await import('../lib/providers/apollo/client')

  // Hard ceilings per profile, so a runaway loop cannot drain the account.
  setAnthropicBudget(Number(process.env.EVAL_ANTHROPIC_BUDGET ?? 1200))
  setApolloBudget(Number(process.env.EVAL_APOLLO_BUDGET ?? 400))

  const supabase = createServiceClient()
  const { data: profilesRows } = await supabase.from('profiles').select('id').limit(1)
  if (!profilesRows?.length) {
    console.error('FAILED: no profiles row exists to own the run')
    process.exit(1)
  }
  const userId = profilesRows[0].id as string

  console.log(`\nAGENTIC SCOUTING EVAL — tag "${tag}", ${profiles.length} profile(s), Precision@${TOP_N}`)

  const reports: ProfileReport[] = []
  for (const profile of profiles) {
    try {
      reports.push(await runProfile(profile, userId))
    } catch (e) {
      console.error(`\nPROFILE ${profile.id} CRASHED:`, e instanceof Error ? e.message : e)
      throw e
    }
  }

  // ─── Aggregate ─────────────────────────────────────────────────────────────
  const avgPrecision = reports.reduce((s, r) => s + r.precision.precision, 0) / reports.length
  const totalJudged = reports.reduce((s, r) => s + r.precision.n, 0)
  const totalBad = reports.reduce((s, r) => s + r.precision.bad, 0)
  const totalGood = reports.reduce((s, r) => s + r.precision.good, 0)
  const overallBadRate = totalJudged > 0 ? totalBad / totalJudged : 0
  const minProfile = Math.min(...reports.map((r) => r.precision.precision))

  const allRecovery = reports.flatMap((r) => r.recovery)
  const recovery = recoveryRate(allRecovery)

  const bestPersonN = reports.reduce((s, r) => s + r.bestPerson.n, 0)
  const bestPersonHits = reports.reduce((s, r) => s + r.bestPerson.hits, 0)

  const totalCost = reports.reduce((s, r) => s + r.efficiency.anthropicCostUsd, 0)
  const totalCredits = reports.reduce((s, r) => s + r.efficiency.enrichmentCredits, 0)

  const avgDiscovery = reports.reduce((s, r) => s + r.discovery.rate, 0) / reports.length
  const avgRejection = reports.reduce((s, r) => s + r.rejection.rate, 0) / reports.length

  const summary = {
    tag,
    at: new Date().toISOString(),
    topN: TOP_N,
    profiles: reports,
    aggregate: {
      avgPrecision,
      minProfilePrecision: minProfile,
      overallBadRate,
      totalGood,
      totalJudged,
      discoveryPrecision: avgDiscovery,
      rejectionAccuracy: avgRejection,
      searchRecovery: recovery,
      bestPersonHitRate: bestPersonN > 0 ? bestPersonHits / bestPersonN : 0,
      totalCostUsd: totalCost,
      totalCredits,
      costPerGoodProspect: totalGood > 0 ? totalCost / totalGood : Infinity,
      creditsPerGoodProspect: totalGood > 0 ? totalCredits / totalGood : Infinity,
    },
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `${tag}.json`), JSON.stringify(summary, null, 2))

  // ─── Report ────────────────────────────────────────────────────────────────
  const line = (label: string, value: string, ok: boolean | null, target: string) =>
    console.log(
      `  ${ok === null ? ' ' : ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ${value.padStart(7)}   target ${target}`
    )

  console.log(`\n${'═'.repeat(76)}\nRESULTS — "${tag}"\n${'═'.repeat(76)}\n`)
  console.log('  PER-PROFILE PRECISION@' + TOP_N)
  for (const r of reports) {
    const ok = r.precision.precision >= THRESHOLDS.minProfilePrecision
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${r.profileName.padEnd(42)} ${pct(r.precision.precision).padStart(5)}  ` +
        `(${r.precision.good}G/${r.precision.maybe}M/${r.precision.bad}B of ${r.precision.n})`
    )
  }

  console.log('\n  AGGREGATE')
  line('Average Precision@' + TOP_N, pct(avgPrecision), avgPrecision >= THRESHOLDS.avgPrecision, `>= ${pct(THRESHOLDS.avgPrecision)}`)
  line('Min profile Precision', pct(minProfile), minProfile >= THRESHOLDS.minProfilePrecision, `>= ${pct(THRESHOLDS.minProfilePrecision)}`)
  line('BAD rate@' + TOP_N, pct(overallBadRate), overallBadRate <= THRESHOLDS.maxBadRate, `<= ${pct(THRESHOLDS.maxBadRate)}`)
  line('Market discovery precision', pct(avgDiscovery), avgDiscovery >= THRESHOLDS.minDiscoveryPrecision, `>= ${pct(THRESHOLDS.minDiscoveryPrecision)}`)
  line('Company rejection accuracy', pct(avgRejection), avgRejection >= THRESHOLDS.minRejectionAccuracy, `>= ${pct(THRESHOLDS.minRejectionAccuracy)}`)
  line(`Search recovery (${recovery.succeeded}/${recovery.applicable})`, pct(recovery.rate), recovery.rate >= THRESHOLDS.minSearchRecovery, `>= ${pct(THRESHOLDS.minSearchRecovery)}`)
  line(`Best-person hit rate (${bestPersonHits}/${bestPersonN})`, pct(summary.aggregate.bestPersonHitRate), summary.aggregate.bestPersonHitRate >= THRESHOLDS.minBestPersonHitRate, `>= ${pct(THRESHOLDS.minBestPersonHitRate)}`)

  console.log('\n  EFFICIENCY')
  console.log(`      Apollo credits              ${totalCredits}`)
  console.log(`      Credits per GOOD prospect   ${summary.aggregate.creditsPerGoodProspect.toFixed(1)}`)
  console.log(`      Anthropic spend             $${totalCost.toFixed(2)}`)
  console.log(`      Cost per GOOD prospect      $${summary.aggregate.costPerGoodProspect.toFixed(2)}`)

  const diagAll: Record<string, number> = {}
  for (const r of reports) for (const [k, v] of Object.entries(r.diagnoses)) diagAll[k] = (diagAll[k] ?? 0) + v
  if (Object.keys(diagAll).length) {
    console.log('\n  SEARCH-SPACE DIAGNOSES')
    for (const [k, v] of Object.entries(diagAll).sort((a, b) => b[1] - a[1])) console.log(`      ${String(v).padStart(3)}  ${k}`)
  }

  const allBad = reports.flatMap((r) => r.badExamples.map((b) => ({ ...b, profile: r.profileName })))
  if (allBad.length) {
    console.log('\n  BAD PROSPECTS (failure clustering)')
    for (const b of allBad.slice(0, 14)) console.log(`      [${b.profile.slice(0, 22)}] ${b.name} @ ${b.company}\n         ${b.reasoning.slice(0, 150)}`)
  }

  const allWrong = reports.flatMap((r) => r.wrongRejections.map((w) => ({ ...w, profile: r.profileName })))
  if (allWrong.length) {
    console.log('\n  WRONGLY REJECTED COMPANIES')
    for (const w of allWrong.slice(0, 10)) console.log(`      [${w.profile.slice(0, 22)}] ${w.company}: ${w.reasoning.slice(0, 130)}`)
  }

  const failedRecovery = allRecovery.filter((c) => c.outcome === 'failed')
  if (failedRecovery.length) {
    console.log('\n  FAILED SEARCH RECOVERIES')
    for (const c of failedRecovery) console.log(`      ${c.segment}: ${c.detail}`)
  }

  const allErrors = reports.flatMap((r) => r.errors)
  if (allErrors.length) {
    console.log('\n  ERRORS SURFACED')
    for (const e of allErrors.slice(0, 12)) console.log(`      - ${e.slice(0, 160)}`)
  }

  const passed =
    avgPrecision >= THRESHOLDS.avgPrecision &&
    minProfile >= THRESHOLDS.minProfilePrecision &&
    overallBadRate <= THRESHOLDS.maxBadRate

  console.log(`\n${'═'.repeat(76)}`)
  console.log(passed ? 'PRIMARY THRESHOLDS PASSED' : 'PRIMARY THRESHOLDS NOT MET')
  console.log(`written to .eval-runs/${tag}.json`)
  if (!passed) process.exitCode = 1
}

main().catch((e) => {
  console.error('\nEVAL CRASHED:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
