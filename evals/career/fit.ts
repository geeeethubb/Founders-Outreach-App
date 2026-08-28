// The FIT-RANKING EVAL over the jd-corpus (docs/CAREER_OS.md §9, "fit").
//
// Every one of the 24 fictional postings goes through exactly the path a
// scouted posting takes — RawJobPosting → Job Extractor (cheap) →
// buildNormalizedJob under the default mission → Fit Evaluator (no research)
// → evaluateFit — and the labels in the corpus grade three different things:
//
//   normalization  employment_type · season · location tier · role family
//   eligibility    the verdict, with a confusion matrix — NOT_QUALIFIED on a
//                  strong/good job is the failure that hides a job the user
//                  would have loved, so it is asserted separately
//   ranking        no planted negative above any positive; ≥6 strong in the
//                  top 8; the judge's P@10 — and two negatives that share
//                  vocabulary with the strong positives (senior full-time
//                  process engineering, Summer 2026) must rank below every
//                  strong positive, which is what separates fit from keyword
//                  similarity
//
// Nothing here changes a threshold to pass. A miss is printed with its row so
// the diagnosis can start from the evidence.

import fs from 'fs'
import path from 'path'
import type { ToolContext } from '@/lib/agents/runtime/types'
import type { RawJobPosting } from '@/lib/career/sources/types'
import { buildNormalizedJob } from '@/lib/career/jobs/normalize'
import { parseLocation, locationTier } from '@/lib/career/jobs/location'
import type { CareerMission, Eligibility, EmploymentType, SeasonRelevance } from '@/lib/career/types'
import { judgeJobRelevance, type JobVerdict } from './judge'
import { classificationAccuracy, precisionAtK, rankOrderViolations } from './metrics'
import { blindForJudge, count, extractCached, fitCached, judgeDescription, rate, toJobOpportunity, type EvalBank, type MetricResult, memoryRun } from './harness'

export type FitClass = 'strong' | 'good' | 'weak' | 'negative'

export interface CorpusEntry {
  id: string
  company: string
  title: string
  location_raw: string | null
  jd_text: string
  expected: {
    employment_type: EmploymentType
    season_relevance: SeasonRelevance
    location_tier: 1 | 2 | 3 | null
    role_family: string
    eligibility_for_user: Eligibility
    fit_class: FitClass
    negative_reason: string | null
  }
}

export function loadCorpus(): CorpusEntry[] {
  const file = path.resolve('evals/career/fixtures/jd-corpus.json')
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: CorpusEntry[] }).jobs
}

export interface FitRow {
  id: string
  company: string
  title: string
  expected: CorpusEntry['expected']
  got: {
    employment_type: EmploymentType
    season_relevance: SeasonRelevance
    location_tier: number | null
    role_family: string | null
    eligibility: Eligibility | null
    overall: number | null
    band: string | null
    explanation: string | null
    eligibility_reasoning: string | null
    extraction_status: string
    fit_status: string
  }
  rank: number
  judge: JobVerdict | null
  costUsd: number
}

/**
 * Expected tier as the tiering code would produce it: a remote-US posting
 * lands on locationTier's remoteUsTier default, London stays null. The corpus
 * writes null for both; the README says why.
 */
export function expectedTier(entry: CorpusEntry, mission: CareerMission): number | null {
  if (entry.expected.location_tier !== null) return entry.expected.location_tier
  const parsed = parseLocation(entry.location_raw)
  if (parsed.remote && parsed.country === 'US') return locationTier(parsed, mission.preferences.geo_tiers)
  return null
}

const FAMILY_STOP = new Set(['and', 'or', 'of', 'the', 'engineering', 'engineer', 'intern', 'analysis', 'analyst', 'management', 'development'])

function familyTokens(s: string | null): Set<string> {
  return new Set((s ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').map((t) => t.replace(/s$/, '')).filter((t) => t.length >= 3 && !FAMILY_STOP.has(t)))
}

/**
 * Lenient: the extractor's label is free text, the corpus's is free text, so
 * a shared content word ("process", "materials", "product") counts; 'other'
 * only when the expected family is other. Both labels are printed per row so
 * a reader can see what "lenient" accepted.
 */
export function roleFamilyMatches(predicted: string | null, expected: string): boolean {
  const p = (predicted ?? '').toLowerCase().trim()
  if (!p || p === 'other') return expected.toLowerCase() === 'other'
  const a = familyTokens(p)
  const b = familyTokens(expected)
  for (const t of a) if (b.has(t)) return true
  // "R&D" and "industrial AI" carry their meaning in tokens the tokenizer drops.
  if (/\br ?& ?d\b|research/.test(p) && /r&d|research/i.test(expected)) return true
  if (/\bai\b|machine learning|\bml\b/.test(p) && /\bai\b|\bml\b|machine learning/i.test(expected)) return true
  return false
}

export interface FitEvalResult {
  rows: FitRow[]
  metrics: MetricResult[]
  confusion: Record<string, Record<string, number>>
  violations: { negative: string; positive: string }[]
  costUsd: number
  judgeCostUsd: number
  errors: string[]
}

export async function runFitEval(params: { corpus: CorpusEntry[]; bank: EvalBank; mission: CareerMission; ctx: ToolContext; log?: (line: string) => void }): Promise<FitEvalResult> {
  const { corpus, bank, mission, ctx } = params
  const log = params.log ?? (() => {})
  const run = memoryRun()
  const errors: string[] = []
  const rows: FitRow[] = []
  const now = new Date().toISOString()

  for (const entry of corpus) {
    const extraction = await extractCached({ title: entry.title, company: entry.company, location_raw: entry.location_raw, text: entry.jd_text, source_hint: 'manual' }, ctx, run)
    if (!extraction.output) errors.push(`extract ${entry.id}: ${extraction.error ?? extraction.status}`)
    const raw: RawJobPosting = {
      source_type: 'manual', source_url: `manual:${entry.id}`, external_id: null, company_name: entry.company, company_domain: null, title: entry.title,
      location_raw: entry.location_raw, description_text: entry.jd_text, description_html: null, department: null, posted_at: null, updated_at: null, apply_url: null,
      canonical_url: null, ats_type: null, ats_job_id: null, requisition_id: null, employment_type_hint: null, raw: {}, retrieved_at: now,
    }
    const normalized = buildNormalizedJob(raw, extraction.output, { geo_tiers: mission.preferences.geo_tiers })
    const job = toJobOpportunity(normalized, `eval-fit-${entry.id}`, mission)
    const fit = await fitCached(job, bank, mission, ctx, run)
    if (!fit.judgment) errors.push(`fit ${entry.id}: ${fit.error ?? fit.status}`)
    rows.push({
      id: entry.id, company: entry.company, title: entry.title, expected: entry.expected,
      got: {
        employment_type: job.employment_type, season_relevance: job.season_relevance, location_tier: job.location_tier, role_family: job.role_family,
        eligibility: fit.judgment?.eligibility ?? null, overall: fit.evaluation?.overall ?? null, band: fit.evaluation?.band ?? null,
        explanation: fit.judgment?.explanation ?? null, eligibility_reasoning: fit.judgment?.eligibility_reasoning ?? null,
        extraction_status: extraction.status, fit_status: fit.status,
      },
      rank: 0, judge: null, costUsd: extraction.trace.cost_usd + fit.costUsd,
    })
    log(`${entry.id.padEnd(36)} ${(job.employment_type + '/' + job.season_relevance + '/t' + (job.location_tier ?? '-')).padEnd(32)} ${(fit.judgment?.eligibility ?? '-').padEnd(14)} ${fit.evaluation ? fit.evaluation.overall.toFixed(3) : '  -  '} ${fit.evaluation?.band ?? ''}`)
  }

  // Rank: a job the evaluator could not judge sorts last, never silently.
  const ranked = [...rows].sort((a, b) => (b.got.overall ?? -1) - (a.got.overall ?? -1))
  ranked.forEach((r, i) => { r.rank = i + 1 })

  // ─── Judge the top 10 ───
  const top10 = ranked.slice(0, 10)
  const byId = new Map(corpus.map((c) => [c.id, c]))
  const blind = blindForJudge(top10.map((r) => {
    const c = byId.get(r.id)!
    return { job_id: r.id, company: c.company, title: c.title, location: c.location_raw, description: judgeDescription(c.jd_text) }
  }))
  const judged = await judgeJobRelevance(bank.missionText, bank.judgeBackground, blind.inputs)
  if (judged.error) errors.push(`judge: ${judged.error}`)
  for (const j of judged.results) { const r = rows.find((x) => x.id === blind.unblind(j.job_id)); if (r) r.judge = j.verdict }

  // ─── Metrics ───
  const metrics: MetricResult[] = []
  const n = rows.length
  const acc = (label: string, pairs: { predicted: unknown; expected: unknown }[], target: number) => {
    const a = classificationAccuracy(pairs)
    metrics.push(rate(label, a, pairs.length, `≥ ${Math.round(target * 100)}%`, a >= target))
  }
  acc('employment_type accuracy', rows.map((r) => ({ predicted: r.got.employment_type, expected: r.expected.employment_type })), 0.9)
  acc('season_relevance accuracy', rows.map((r) => ({ predicted: r.got.season_relevance, expected: r.expected.season_relevance })), 0.9)
  acc('location_tier accuracy', rows.map((r) => ({ predicted: r.got.location_tier, expected: expectedTier(byId.get(r.id)!, mission) })), 0.9)
  acc('role_family accuracy (lenient)', rows.map((r) => ({ predicted: roleFamilyMatches(r.got.role_family, r.expected.role_family), expected: true })), 0.8)

  const confusion: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    const e = r.expected.eligibility_for_user
    const g = r.got.eligibility ?? 'NONE'
    confusion[e] = confusion[e] ?? {}
    confusion[e][g] = (confusion[e][g] ?? 0) + 1
  }
  acc('eligibility accuracy', rows.map((r) => ({ predicted: r.got.eligibility, expected: r.expected.eligibility_for_user })), 0.8)
  const wrongNq = rows.filter((r) => (r.expected.fit_class === 'strong' || r.expected.fit_class === 'good') && r.got.eligibility === 'NOT_QUALIFIED')
  metrics.push(count('NOT_QUALIFIED on a strong/good job', wrongNq.length, rows.filter((r) => r.expected.fit_class === 'strong' || r.expected.fit_class === 'good').length, '= 0', wrongNq.length === 0, wrongNq.map((r) => r.id).join(', ')))

  const classes: Record<string, 'positive' | 'negative'> = {}
  for (const r of rows) {
    if (r.expected.fit_class === 'strong' || r.expected.fit_class === 'good') classes[r.id] = 'positive'
    else if (r.expected.fit_class === 'negative') classes[r.id] = 'negative'
  }
  const rankedIds = ranked.map((r) => r.id)
  const viol = rankOrderViolations(rankedIds, classes)
  const violations: { negative: string; positive: string }[] = []
  for (let i = 0; i < rankedIds.length; i++) {
    if (classes[rankedIds[i]] !== 'negative') continue
    for (let j = i + 1; j < rankedIds.length; j++) if (classes[rankedIds[j]] === 'positive') violations.push({ negative: rankedIds[i], positive: rankedIds[j] })
  }
  metrics.push(count('rank-order violations (negative above positive)', viol, n, '= 0', viol === 0))

  const top8Strong = ranked.slice(0, 8).filter((r) => r.expected.fit_class === 'strong').length
  metrics.push(count('strong jobs in the top 8', top8Strong, 8, '≥ 6', top8Strong >= 6))

  const judgedTop = top10.map((r) => r.judge)
  const p10 = precisionAtK(judgedTop, 10, (v) => v === 'GOOD_FIT' || v === 'STRETCH')
  metrics.push(rate('judge P@10 (GOOD_FIT|STRETCH)', p10, judgedTop.filter(Boolean).length, '≥ 80%', p10 >= 0.8 && judgedTop.every(Boolean), judgedTop.every(Boolean) ? undefined : 'judge did not cover every job'))

  // Not keyword similarity: the two lexical decoys must sit below EVERY strong positive.
  const strongRanks = ranked.filter((r) => r.expected.fit_class === 'strong').map((r) => r.rank)
  const worstStrong = Math.max(...strongRanks)
  for (const decoy of ['jd-neg-01-senior-fulltime', 'jd-neg-02-summer-2026']) {
    const r = rows.find((x) => x.id === decoy)
    const ok = !!r && r.rank > worstStrong
    metrics.push(count(`decoy ${decoy} below every strong positive`, r?.rank ?? -1, 1, `> ${worstStrong} (rank)`, ok, r ? `overall ${r.got.overall ?? '-'}` : 'missing'))
  }

  return { rows: ranked, metrics, confusion, violations, costUsd: run.costUsd(), judgeCostUsd: judged.costUsd, errors }
}
