// Phase 6 eval harness — grounded research folded into the Phase 3 scouting loop.
//
// Reuses the Phase 3 profiles, résumé profile and LLM judge unchanged, so
// Precision@20 is directly comparable to the Phase 3 baseline. The only
// difference is that scoring now sees a researched company (and person) dossier
// instead of an Apollo keyword list.
//
// Runs against the cached Apollo pool by default (APOLLO_CACHE_ONLY=true),
// because lead credits are exhausted — see docs/PHASE_6_EVAL.md.

import fs from 'fs'
import path from 'path'
import { apolloStats, cacheOnlySkipCount, isCacheOnly, resetApolloStats, setApolloBudget } from '@/lib/providers/apollo/client'
import { cacheStats, resetCacheStats } from '@/lib/providers/cache'
import { resetWebSearchStats, webSearchStats } from '@/lib/providers/web/openai-search'
import { estimateCost } from '@/lib/ai/models'
import { companyKey, normalizeLinkedIn } from '@/lib/scouting/dedupe'
import { interleave, mapWithConcurrency } from '@/lib/scouting/concurrency'
import {
  DEFAULT_SCOUT_V2_OPTIONS,
  companyFromPerson,
  personKeyOf,
  scoutProfileV2,
  type ScoutV2Diagnostics,
  type ScoutV2Options,
} from '@/lib/scouting/pipeline-v2'
import { scoreBatch, SCORER_PROMPT_VERSION, type ScoutScore, type ScoringUsage } from '@/lib/scouting/score'
import { COMPANY_RESEARCH_PROMPT_VERSION } from '@/lib/research/company'
import { PERSON_RESEARCH_PROMPT_VERSION } from '@/lib/research/person'
import type { CompanyDossier, PersonDossier } from '@/lib/research/types'
import { SEARCH_PROFILES, renderMissionForPrompt, type SearchProfile } from '../phase3/mission'
import { RESUME_ITEM_IDS, renderProfileForPrompt } from '../phase3/user-profile'
import { judgeBatch, JUDGE_PROMPT_VERSION, type JudgeResult, type JudgeUsage } from '../phase3/judge'
import { computePrecisionAt20, runAllChecks, THRESHOLDS, type CheckResult, type ScoredProspect } from '../phase3/checks'
import { PHASE6_THRESHOLDS, checkBadRate, checkResearchCoverage, checkFactGrounding, type ResearchedProspect } from './checks'

const SCORE_BATCH_SIZE = 8
const JUDGE_BATCH_SIZE = 10
const TOP_N = 20
const MODEL_CONCURRENCY = 6

export interface Phase6ProfileResult {
  profile: SearchProfile
  diagnostics: ScoutV2Diagnostics
  scored: ResearchedProspect[]
  top20: ResearchedProspect[]
  judgments: Map<string, JudgeResult>
  precision: ReturnType<typeof computePrecisionAt20>
}

export interface Phase6Usage {
  apollo: ReturnType<typeof apolloStats>
  apolloCacheOnlySkips: number
  web: ReturnType<typeof webSearchStats>
  research_llm_calls: number
  research_tokens_in: number
  research_tokens_out: number
  scoring: ScoringUsage
  judging: JudgeUsage
  /** Total estimated model spend across research, scoring and judging. */
  total_model_cost: number
}

export interface Phase6RunResult {
  iteration: string
  timestamp: string
  profiles: Phase6ProfileResult[]
  allTop: ResearchedProspect[]
  checks: CheckResult[]
  avgPrecision: number
  minPrecision: number
  badRate: number
  passed: boolean
  usage: Phase6Usage
  costPerGoodProspect: number
  goodCount: number
}

function mergeUsage<T extends { calls: number; tokens_in: number; tokens_out: number; cost_estimate: number }>(a: T, b: T): T {
  return { ...a, calls: a.calls + b.calls, tokens_in: a.tokens_in + b.tokens_in, tokens_out: a.tokens_out + b.tokens_out, cost_estimate: a.cost_estimate + b.cost_estimate }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function identityKey(p: { person: ScoredProspect['person'] }): string {
  const apolloId = p.person.provenance.external_id
  if (apolloId) return `a:${apolloId}`
  if (p.person.linkedin_url) return `l:${normalizeLinkedIn(p.person.linkedin_url)}`
  return `nc:${p.person.name.toLowerCase()}|${(p.person.company_name ?? '').toLowerCase()}`
}

async function runProfile(
  profile: SearchProfile,
  opts: ScoutV2Options,
  usage: { scoring: ScoringUsage; judging: JudgeUsage; research: { calls: number; tin: number; tout: number } },
  claimed: Set<string>
): Promise<Phase6ProfileResult> {
  process.stdout.write(`\n─── ${profile.label} ───\n`)

  const scoutOpts: ScoutV2Options = {
    ...opts,
    companyFilter: {
      ...opts.companyFilter,
      minEmployees: profile.companySize.min,
      maxEmployees: profile.companySize.max,
      // Research replaces the blunt keyword-substring filter: the dossier's own
      // mission_relevant verdict is a far better instrument than substring
      // matching on an Apollo keyword blob.
      requiredDomainTerms: undefined,
    },
  }

  const scout = await scoutProfileV2(profile.queries, scoutOpts)
  const d = scout.diagnostics
  usage.research.calls += scout.usage.research_llm_calls
  usage.research.tin += scout.usage.research_tokens_in
  usage.research.tout += scout.usage.research_tokens_out

  process.stdout.write(
    `  scout: ${d.stubsUnique} stubs → ${d.stubsAfterCheapFilter} after cheap filter → ` +
      `${d.companiesResearched} companies researched (${d.companiesRejectedByResearch} rejected) → ` +
      `${d.shortlistedStubs} shortlisted → ${d.peopleEnriched} enriched → ${d.peopleAfterDedupe} candidates\n`
  )
  process.stdout.write(`  research: ${d.peopleResearched} person dossiers · ${scout.usage.web_searches} web searches\n`)

  // ── Score, with dossiers attached ──
  const inputs = scout.people.map((person, i) => {
    const company = companyFromPerson(person)
    const cKey = company ? companyKey(company) : null
    return {
      candidateId: `${profile.id}-${i}`,
      person,
      company,
      companyDossier: cKey ? scout.companyDossiers.get(cKey) ?? null : null,
      personDossier: scout.personDossiers.get(personKeyOf(person)) ?? null,
    }
  })

  const profileBlock = renderProfileForPrompt()
  const missionBlock = renderMissionForPrompt()
  const scores = new Map<string, ScoutScore>()

  const scoreResults = await mapWithConcurrency(
    chunk(interleave(inputs, SCORE_BATCH_SIZE), SCORE_BATCH_SIZE),
    MODEL_CONCURRENCY,
    (batch) => scoreBatch(batch, profileBlock, missionBlock, RESUME_ITEM_IDS)
  )
  for (const r of scoreResults) {
    usage.scoring = mergeUsage(usage.scoring, r.usage)
    for (const s of r.scores) scores.set(s.candidate_id, s)
  }

  const scored: ResearchedProspect[] = inputs
    .filter((i) => scores.has(i.candidateId))
    .map((i) => ({
      candidateId: i.candidateId,
      person: i.person,
      company: i.company,
      score: scores.get(i.candidateId)!,
      companyDossier: i.companyDossier as CompanyDossier | null,
      personDossier: i.personDossier as PersonDossier | null,
    }))

  scored.sort((a, b) => b.score.total - a.score.total)

  // Cross-profile dedupe + one person per company (docs/PRODUCT.md §3).
  const top20: ResearchedProspect[] = []
  const companiesTaken = new Set<string>()
  for (const c of scored) {
    if (top20.length >= TOP_N) break
    const key = identityKey(c)
    if (claimed.has(key)) continue
    const cKey = c.company ? companyKey(c.company) : companyKey({ domain: c.person.company_domain, name: c.person.company_name ?? '' })
    if (companiesTaken.has(cKey)) continue
    claimed.add(key)
    companiesTaken.add(cKey)
    top20.push(c)
  }
  process.stdout.write(`  scored: ${scored.length} · top20 range ${top20[top20.length - 1]?.score.total ?? 0}–${top20[0]?.score.total ?? 0}\n`)

  // ── Judge (blind to the scorer's numbers and reasoning; given the same
  //    researched company context a careful advisor would look up) ──
  const judgments = new Map<string, JudgeResult>()
  const judgeResults = await mapWithConcurrency(
    chunk(top20, JUDGE_BATCH_SIZE),
    MODEL_CONCURRENCY,
    (batch) => judgeBatch(batch.map((p) => ({
      candidateId: p.candidateId,
      person: p.person,
      company: p.company,
      companyContext: p.companyDossier && !p.companyDossier.research_failed ? p.companyDossier.what_they_do : null,
    })))
  )
  for (const r of judgeResults) {
    usage.judging = mergeUsage(usage.judging, r.usage)
    for (const j of r.results) judgments.set(j.candidate_id, j)
  }

  const verdicts = top20.map((p) => judgments.get(p.candidateId)?.verdict).filter(Boolean) as ('GOOD' | 'MAYBE' | 'BAD')[]
  const precision = computePrecisionAt20(profile.id, verdicts)
  process.stdout.write(`  judge: ${precision.good} GOOD / ${precision.maybe} MAYBE / ${precision.bad} BAD → P@20 = ${(precision.precision * 100).toFixed(0)}%\n`)

  return { profile, diagnostics: d, scored, top20, judgments, precision }
}

export async function runPhase6Eval(
  iteration: string,
  opts: ScoutV2Options = DEFAULT_SCOUT_V2_OPTIONS,
  profiles: SearchProfile[] = SEARCH_PROFILES
): Promise<Phase6RunResult> {
  resetApolloStats()
  resetCacheStats()
  resetWebSearchStats()
  setApolloBudget(Number(process.env.APOLLO_MAX_CALLS_PER_RUN ?? 500))

  const usage = {
    scoring: { calls: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0 } as ScoringUsage,
    judging: { calls: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0 } as JudgeUsage,
    research: { calls: 0, tin: 0, tout: 0 },
  }

  process.stdout.write(`\n╔══ PHASE 6 · ITERATION ${iteration} ══╗\n`)
  process.stdout.write(
    `scorer v${SCORER_PROMPT_VERSION} · judge v${JUDGE_PROMPT_VERSION} · ` +
      `company-research v${COMPANY_RESEARCH_PROMPT_VERSION} · person-research v${PERSON_RESEARCH_PROMPT_VERSION}\n`
  )
  process.stdout.write(`apollo mode: ${isCacheOnly() ? 'CACHE-ONLY (0 credits)' : 'LIVE'}\n`)

  const claimed = new Set<string>()
  const results: Phase6ProfileResult[] = []
  for (const profile of profiles) {
    results.push(await runProfile(profile, opts, usage, claimed))
  }

  const allTop = results.flatMap((r) => r.top20)
  const checks = [
    ...runAllChecks(allTop),
    checkBadRate(allTop, results),
    checkResearchCoverage(allTop),
    checkFactGrounding(allTop),
  ]

  const precisions = results.map((r) => r.precision.precision)
  const avgPrecision = precisions.length ? precisions.reduce((a, b) => a + b, 0) / precisions.length : 0
  const minPrecision = precisions.length ? Math.min(...precisions) : 0
  const totalBad = results.reduce((n, r) => n + r.precision.bad, 0)
  const badRate = allTop.length ? totalBad / allTop.length : 0
  const goodCount = results.reduce((n, r) => n + r.precision.good, 0)

  const web = webSearchStats()
  const researchCost = estimateCost(usage.research.tin + web.tokens_in, usage.research.tout + web.tokens_out)
  const totalModelCost = researchCost + usage.scoring.cost_estimate + usage.judging.cost_estimate

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
    badRate,
    passed,
    goodCount,
    costPerGoodProspect: goodCount > 0 ? totalModelCost / goodCount : Infinity,
    usage: {
      apollo: apolloStats(),
      apolloCacheOnlySkips: cacheOnlySkipCount(),
      web,
      research_llm_calls: usage.research.calls,
      research_tokens_in: usage.research.tin,
      research_tokens_out: usage.research.tout,
      scoring: usage.scoring,
      judging: usage.judging,
      total_model_cost: totalModelCost,
    },
  }
}

export function printPhase6Summary(r: Phase6RunResult): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  process.stdout.write(`\n╔══════ PHASE 6 · ITERATION ${r.iteration} RESULTS ══════╗\n\n`)

  process.stdout.write('AUTOMATED CHECKS\n')
  for (const c of r.checks) {
    process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} ${pct(c.value).padStart(7)} (need ${pct(c.threshold)})  ${c.detail}\n`)
    for (const f of c.failures.slice(0, 4)) process.stdout.write(`         · ${f}\n`)
  }

  process.stdout.write('\nPRECISION@20 BY PROFILE\n')
  for (const p of r.profiles) {
    const pr = p.precision
    process.stdout.write(`  ${pr.pass ? 'PASS' : 'FAIL'}  ${p.profile.label.padEnd(46)} ${pct(pr.precision).padStart(7)}  (${pr.good}G/${pr.maybe}M/${pr.bad}B)\n`)
  }

  process.stdout.write(
    `\n  Average P@20: ${pct(r.avgPrecision)} (need ${pct(THRESHOLDS.avgPrecisionAt20)})\n` +
      `  Minimum P@20: ${pct(r.minPrecision)} (need ${pct(THRESHOLDS.minProfilePrecisionAt20)})\n` +
      `  BAD rate@20:  ${pct(r.badRate)} (need ≤ ${pct(PHASE6_THRESHOLDS.badRate)})\n`
  )

  const u = r.usage
  process.stdout.write(
    `\nUSAGE\n` +
      `  Apollo:  ${u.apollo.calls} live calls, ${u.apollo.enrichmentCredits} credits, ` +
      `${u.apollo.cachedCalls} cache hits, ${u.apolloCacheOnlySkips} cache-only skips\n` +
      `  Web:     ${u.web.searches} searches (${u.web.cachedSearches} cached), ${u.web.errors} errors\n` +
      `  Model:   ${u.research_llm_calls} research + ${u.scoring.calls} scoring + ${u.judging.calls} judging calls\n` +
      `  Cost:    ~$${u.total_model_cost.toFixed(2)} total model spend\n` +
      `  COST PER GOOD TOP-20 PROSPECT: ${Number.isFinite(r.costPerGoodProspect) ? '$' + r.costPerGoodProspect.toFixed(2) : 'n/a'} (${r.goodCount} GOOD)\n`
  )

  process.stdout.write(`\n  OVERALL: ${r.passed ? 'PASS' : 'FAIL'}\n\n`)
}

export function savePhase6Run(r: Phase6RunResult): string {
  const dir = path.join(process.cwd(), '.eval-runs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `phase6-iteration-${r.iteration}.json`)

  fs.writeFileSync(file, JSON.stringify({
    iteration: r.iteration,
    timestamp: r.timestamp,
    checks: r.checks,
    avgPrecision: r.avgPrecision,
    minPrecision: r.minPrecision,
    badRate: r.badRate,
    passed: r.passed,
    goodCount: r.goodCount,
    costPerGoodProspect: r.costPerGoodProspect,
    usage: r.usage,
    profiles: r.profiles.map((p) => ({
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
        apollo_id: s.person.provenance.external_id,
        total: s.score.total,
        components: s.score.components,
        why_they_fit: s.score.why_they_fit,
        why_i_fit_them: s.score.why_i_fit_them,
        resume_item_ids: s.score.resume_item_ids,
        risks: s.score.risks,
        recommendation: s.score.recommendation,
        judge: p.judgments.get(s.candidateId) ?? null,
        research: s.companyDossier ? {
          what_they_do: s.companyDossier.what_they_do,
          mission_relevant: s.companyDossier.mission_relevant,
          relevance_reasoning: s.companyDossier.relevance_reasoning,
          domain_evidence: s.companyDossier.domain_evidence,
          fact_count: s.companyDossier.claims.filter((c) => c.type === 'FACT').length,
          sources: s.companyDossier.claims.filter((c) => c.type === 'FACT').map((c) => c.source_url).filter(Boolean).slice(0, 5),
          research_failed: s.companyDossier.research_failed,
        } : null,
        person_research: s.personDossier && !s.personDossier.research_failed ? {
          apparent_ownership: s.personDossier.apparent_ownership,
          can_create_opportunity: s.personDossier.can_create_opportunity,
          fact_count: s.personDossier.claims.filter((c) => c.type === 'FACT').length,
        } : null,
      })),
      /** Companies research rejected — the domain-drift kill list. */
      rejectedByResearch: p.scored.length,
    })),
  }, null, 2), 'utf8')

  return file
}
