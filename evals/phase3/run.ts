// Phase 3 eval harness.
//
// Pipeline per profile:
//   scout (Apollo, cached) -> score (LLM components + code arithmetic)
//   -> rank -> take top 20 -> judge (independent prompt) -> Precision@20
//
// Apollo responses are cached on disk, so re-running after a scoring or prompt
// change costs model tokens only. That is what makes the iteration loop cheap
// enough to actually run repeatedly.

import fs from 'fs'
import path from 'path'
import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'
import { apolloStats, resetApolloStats, setApolloBudget } from '@/lib/providers/apollo/client'
import { cacheStats, resetCacheStats } from '@/lib/providers/cache'
import { companyKey } from '@/lib/scouting/dedupe'
import { interleave, mapWithConcurrency } from '@/lib/scouting/concurrency'
import { DEFAULT_SCOUT_OPTIONS, scoutProfile, type ScoutDiagnostics, type ScoutOptions } from '@/lib/scouting/pipeline'
import { scoreBatch, SCORER_PROMPT_VERSION, type ScoutScore, type ScoringUsage } from '@/lib/scouting/score'
import { SEARCH_PROFILES, renderMissionForPrompt, type SearchProfile } from './mission'
import { RESUME_ITEM_IDS, renderProfileForPrompt } from './user-profile'
import { judgeBatch, JUDGE_PROMPT_VERSION, type JudgeResult, type JudgeUsage } from './judge'
import {
  computePrecisionAt20,
  runAllChecks,
  THRESHOLDS,
  type CheckResult,
  type PrecisionResult,
  type ScoredProspect,
} from './checks'

const SCORE_BATCH_SIZE = 8
const JUDGE_BATCH_SIZE = 10
const TOP_N = 20
/** Batches in flight. Scoring is latency-bound, so this dominates wall clock. */
const MODEL_CONCURRENCY = 6

export interface ProfileResult {
  profile: SearchProfile
  diagnostics: ScoutDiagnostics
  scored: ScoredProspect[]
  top20: ScoredProspect[]
  judgments: Map<string, JudgeResult>
  precision: PrecisionResult
}

export interface EvalRunResult {
  iteration: string
  timestamp: string
  profiles: ProfileResult[]
  allTop: ScoredProspect[]
  checks: CheckResult[]
  avgPrecision: number
  minPrecision: number
  passed: boolean
  usage: {
    apollo: ReturnType<typeof apolloStats>
    cache: ReturnType<typeof cacheStats>
    scoring: ScoringUsage
    judging: JudgeUsage
  }
}

function mergeUsage<T extends { calls: number; tokens_in: number; tokens_out: number; cost_estimate: number }>(
  a: T,
  b: T
): T {
  return {
    ...a,
    calls: a.calls + b.calls,
    tokens_in: a.tokens_in + b.tokens_in,
    tokens_out: a.tokens_out + b.tokens_out,
    cost_estimate: a.cost_estimate + b.cost_estimate,
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function runProfile(
  profile: SearchProfile,
  opts: ScoutOptions,
  usage: { scoring: ScoringUsage; judging: JudgeUsage }
): Promise<ProfileResult> {
  process.stdout.write(`\n─── ${profile.label} ───\n`)

  const scoutOpts: ScoutOptions = {
    ...opts,
    companyFilter: {
      ...opts.companyFilter,
      minEmployees: profile.companySize.min,
      maxEmployees: profile.companySize.max,
    },
  }

  const scout = await scoutProfile(profile.queries, scoutOpts)
  const d = scout.diagnostics
  process.stdout.write(
    `  scout: ${d.queriesRun} queries → ${d.stubsUnique} stubs → ${d.peopleEnriched} enriched → ` +
      `${d.peopleAfterDedupe} candidates across ${d.companiesAfterFilter} companies\n`
  )

  // ── Score ──
  const inputs = scout.people.map((person, i) => {
    const key = person.company_domain
      ? `d:${person.company_domain}`
      : companyKey({ domain: null, name: person.company_name ?? '' })
    return {
      candidateId: `${profile.id}-${i}`,
      person,
      company: scout.companiesByKey.get(key) ?? null,
    }
  })

  const profileBlock = renderProfileForPrompt()
  const missionBlock = renderMissionForPrompt()
  const scores = new Map<string, ScoutScore>()

  // Stride across the pool so each batch mixes candidates from different
  // queries — the scorer needs contrast to calibrate against. See interleave().
  const scoreResults = await mapWithConcurrency(
    chunk(interleave(inputs, SCORE_BATCH_SIZE), SCORE_BATCH_SIZE),
    MODEL_CONCURRENCY,
    (batch) => scoreBatch(batch, profileBlock, missionBlock, RESUME_ITEM_IDS)
  )
  for (const result of scoreResults) {
    usage.scoring = mergeUsage(usage.scoring, result.usage)
    for (const s of result.scores) scores.set(s.candidate_id, s)
  }

  const scored: ScoredProspect[] = inputs
    .filter((i) => scores.has(i.candidateId))
    .map((i) => ({ ...i, score: scores.get(i.candidateId)! }))

  // Deterministic ranking — highest total first.
  scored.sort((a, b) => b.score.total - a.score.total)
  const top20 = scored.slice(0, TOP_N)
  process.stdout.write(`  scored: ${scored.length} · top20 range ${top20[top20.length - 1]?.score.total ?? 0}–${top20[0]?.score.total ?? 0}\n`)

  // ── Judge (blind to scores) ──
  const judgments = new Map<string, JudgeResult>()
  const judgeResults = await mapWithConcurrency(
    chunk(top20, JUDGE_BATCH_SIZE),
    MODEL_CONCURRENCY,
    (batch) => judgeBatch(batch.map((p) => ({ candidateId: p.candidateId, person: p.person, company: p.company })))
  )
  for (const result of judgeResults) {
    usage.judging = mergeUsage(usage.judging, result.usage)
    for (const j of result.results) judgments.set(j.candidate_id, j)
  }

  const verdicts = top20.map((p) => judgments.get(p.candidateId)?.verdict).filter(Boolean) as ('GOOD' | 'MAYBE' | 'BAD')[]
  const precision = computePrecisionAt20(profile.id, verdicts)
  process.stdout.write(
    `  judge: ${precision.good} GOOD / ${precision.maybe} MAYBE / ${precision.bad} BAD → P@20 = ${(precision.precision * 100).toFixed(0)}%\n`
  )

  return { profile, diagnostics: scout.diagnostics, scored, top20, judgments, precision }
}

export async function runEval(
  iteration: string,
  opts: ScoutOptions = DEFAULT_SCOUT_OPTIONS,
  profiles: SearchProfile[] = SEARCH_PROFILES
): Promise<EvalRunResult> {
  resetApolloStats()
  resetCacheStats()
  setApolloBudget(Number(process.env.APOLLO_MAX_CALLS_PER_RUN ?? 500))

  const usage = {
    scoring: { calls: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0 } as ScoringUsage,
    judging: { calls: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0 } as JudgeUsage,
  }

  process.stdout.write(`\n╔══ ITERATION ${iteration} ══╗\n`)
  process.stdout.write(`scorer prompt v${SCORER_PROMPT_VERSION} · judge prompt v${JUDGE_PROMPT_VERSION}\n`)

  const results: ProfileResult[] = []
  for (const profile of profiles) {
    results.push(await runProfile(profile, opts, usage))
  }

  const allTop = results.flatMap((r) => r.top20)
  const checks = runAllChecks(allTop)
  const precisions = results.map((r) => r.precision.precision)
  const avgPrecision = precisions.length ? precisions.reduce((a, b) => a + b, 0) / precisions.length : 0
  const minPrecision = precisions.length ? Math.min(...precisions) : 0

  const passed =
    checks.every((c) => c.pass) &&
    avgPrecision >= THRESHOLDS.avgPrecisionAt20 &&
    minPrecision >= THRESHOLDS.minProfilePrecisionAt20

  return {
    iteration,
    timestamp: new Date().toISOString(),
    profiles: results,
    allTop,
    checks,
    avgPrecision,
    minPrecision,
    passed,
    usage: { apollo: apolloStats(), cache: cacheStats(), scoring: usage.scoring, judging: usage.judging },
  }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

export function printSummary(result: EvalRunResult): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  process.stdout.write(`\n╔══════ ITERATION ${result.iteration} RESULTS ══════╗\n\n`)

  process.stdout.write('AUTOMATED CHECKS\n')
  for (const c of result.checks) {
    process.stdout.write(
      `  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} ${pct(c.value).padStart(7)} (need ${pct(c.threshold)})  ${c.detail}\n`
    )
    for (const f of c.failures.slice(0, 5)) process.stdout.write(`         · ${f}\n`)
  }

  process.stdout.write('\nPRECISION@20 BY PROFILE\n')
  for (const p of result.profiles) {
    const pr = p.precision
    process.stdout.write(
      `  ${pr.pass ? 'PASS' : 'FAIL'}  ${p.profile.label.padEnd(42)} ${pct(pr.precision).padStart(7)}  (${pr.good}G/${pr.maybe}M/${pr.bad}B)\n`
    )
  }

  process.stdout.write(
    `\n  Average P@20: ${pct(result.avgPrecision)} (need ${pct(THRESHOLDS.avgPrecisionAt20)})\n` +
      `  Minimum P@20: ${pct(result.minPrecision)} (need ${pct(THRESHOLDS.minProfilePrecisionAt20)})\n`
  )

  const u = result.usage
  process.stdout.write(
    `\nUSAGE\n  Apollo: ${u.apollo.calls} live calls (${u.apollo.cachedCalls} cache hits), ` +
      `${u.apollo.enrichmentCredits} enrichment credits, ${u.apollo.errors} errors\n` +
      `  Model: ${u.scoring.calls + u.judging.calls} calls, ` +
      `${(u.scoring.tokens_in + u.judging.tokens_in / 1000).toFixed(0)}k in / ` +
      `${((u.scoring.tokens_out + u.judging.tokens_out) / 1000).toFixed(1)}k out, ` +
      `~$${(u.scoring.cost_estimate + u.judging.cost_estimate).toFixed(2)}\n`
  )

  process.stdout.write(`\n  OVERALL: ${result.passed ? 'PASS' : 'FAIL'}\n\n`)
}

/** Persist the full run so iterations can be diffed without re-running. */
export function saveRun(result: EvalRunResult): string {
  const dir = path.join(process.cwd(), '.eval-runs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `iteration-${result.iteration}.json`)

  const serializable = {
    iteration: result.iteration,
    timestamp: result.timestamp,
    checks: result.checks,
    avgPrecision: result.avgPrecision,
    minPrecision: result.minPrecision,
    passed: result.passed,
    usage: result.usage,
    profiles: result.profiles.map((p) => ({
      id: p.profile.id,
      label: p.profile.label,
      diagnostics: p.diagnostics,
      precision: p.precision,
      top20: p.top20.map((s, rank) => ({
        rank: rank + 1,
        name: s.person.name,
        title: s.person.title,
        company: s.person.company_name,
        employees: s.company?.employee_count ?? null,
        industry: s.company?.industry ?? null,
        linkedin: s.person.linkedin_url,
        email_status: s.person.email_status,
        apollo_id: s.person.provenance.external_id,
        total: s.score.total,
        components: s.score.components,
        why_they_fit: s.score.why_they_fit,
        why_i_fit_them: s.score.why_i_fit_them,
        resume_item_ids: s.score.resume_item_ids,
        risks: s.score.risks,
        recommendation: s.score.recommendation,
        judge: p.judgments.get(s.candidateId) ?? null,
      })),
    })),
  }

  fs.writeFileSync(file, JSON.stringify(serializable, null, 2), 'utf8')
  return file
}
