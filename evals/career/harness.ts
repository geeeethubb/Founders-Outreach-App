// Shared no-DB helpers for the Career OS eval suites (docs/CAREER_OS.md §9).
//
// Migration 014 is not a precondition for measuring anything: the Evidence
// Bank comes from the real résumé through buildMemoryBank (importer cached by
// content, $0 after the first run), jobs come from fixtures or live boards,
// and every result lands under .career-out/eval/<suite>/ (gitignored) — the
// résumé's text never reaches a tracked file. Suites REPORT numbers; they do
// not commit them.
//
// Everything paid here is cached by content: the extractor by text hash, the
// fit evaluator by the cacheKeyParts we build from a stable job id, the judge
// by its own inputs. A re-run after a code fix costs only the changed parts.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { config } from 'dotenv'
config({ path: path.join(process.cwd(), '.env.local') })

import type { ToolContext } from '@/lib/agents/runtime/types'
import { runFitEvaluator, fitEvaluatorPrompt } from '@/lib/agents/fit-evaluator'
import { runJobExtractor, type JobExtraction } from '@/lib/agents/job-extractor'
import type { AgentResult } from '@/lib/agents/runtime/types'
import { anthropicUsage, setAnthropicBudget } from '@/lib/providers/anthropic/client'
import { buildMemoryBank } from '@/lib/career/evidence/memory-bank'
import { renderExperienceSummaries, renderPreferences } from '@/lib/career/evidence/render'
import { evaluateFit, type FitEvaluation } from '@/lib/career/fit/evaluate'
import { applyHardConstraints } from '@/lib/career/jobs/filters'
import { memoryRun, packageToolContext } from '@/lib/career/intelligence/orchestrator'
import { fitJobInputFrom } from '@/lib/career/intelligence/load'
import { descriptionSha } from '@/lib/career/jobs/snapshot'
import type { NormalizedJob } from '@/lib/career/jobs/normalize'
import { defaultMission, renderMission } from '@/lib/career/missions/store'
import type { CareerRun } from '@/lib/career/runs'
import type { CareerMission, EvidenceBank, FitJudgment, JobOpportunity } from '@/lib/career/types'
import { pct } from './metrics'

export const EVAL_USER = 'eval'
export const EVAL_OUT_ROOT = path.resolve('.career-out', 'eval')

// ─── Environment ─────────────────────────────────────────────────────────────

/** Exit 2, like the CLIs, when the paid half cannot run. Returns the résumé path. */
export function requireLiveEnv(): string {
  const resume = path.resolve(process.env.CAREER_RESUME ?? 'Zuyu_Resume.docx')
  if (!fs.existsSync(resume)) {
    console.error(`résumé not found at ${resume} (set CAREER_RESUME to point at it)`)
    process.exit(2)
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — this suite makes live (cached) model calls')
    process.exit(2)
  }
  setAnthropicBudget(Number(process.env.PROBE_ANTHROPIC_BUDGET ?? 400))
  return resume
}

export function outDir(suite: string): string {
  const dir = path.join(EVAL_OUT_ROOT, suite)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function writeResult(suite: string, name: string, data: unknown): string {
  const file = path.join(outDir(suite), name)
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
  return file
}

// ─── Cost accounting ─────────────────────────────────────────────────────────

/** Deltas of the process-wide Anthropic meter, so a suite can price each stage. */
export function costMeter(): { lap: (label: string) => { label: string; costUsd: number; calls: number; cached: number }; laps: () => { label: string; costUsd: number; calls: number; cached: number }[]; total: () => number } {
  let last = anthropicUsage()
  const start = last
  const laps: { label: string; costUsd: number; calls: number; cached: number }[] = []
  return {
    lap(label) {
      const now = anthropicUsage()
      const entry = { label, costUsd: round4(now.costUsd - last.costUsd), calls: now.calls - last.calls, cached: now.cachedCalls - last.cachedCalls }
      laps.push(entry)
      last = now
      return entry
    },
    laps: () => [...laps],
    total: () => round4(anthropicUsage().costUsd - start.costUsd),
  }
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

export function money(n: number): string {
  return `$${n.toFixed(4)}`
}

// ─── Mission, bank, context ──────────────────────────────────────────────────

export function evalMission(): CareerMission {
  const now = '2026-08-27T00:00:00.000Z'
  return { ...defaultMission(EVAL_USER), id: 'eval-mission', created_at: now, updated_at: now }
}

export function evalToolContext(): ToolContext {
  return packageToolContext(EVAL_USER, null)
}

export interface EvalBank {
  bank: EvidenceBank
  missionText: string
  evidenceSummaries: string
  preferences: string
  /** Content hash of what the agents see. buildMemoryBank mints random ids per process, so the product's evidenceVersion (an id hash) would miss the cache on every run. */
  contentVersion: string
  /** The summaries with ids stripped — what the judge is shown, so its cache is stable across processes too. */
  judgeBackground: string
  costUsd: number
}

/** The real résumé as an in-memory Evidence Bank, plus the renderings every agent and judge reads. */
export async function loadEvalBank(resumePath: string, ctx: ToolContext, mission: CareerMission): Promise<EvalBank> {
  const mem = await buildMemoryBank({ userId: EVAL_USER, docx: fs.readFileSync(resumePath), filename: path.basename(resumePath), ctx })
  if (mem.agentError) throw new Error(`résumé importer failed: ${mem.agentError}`)
  if (mem.bank.experiences.length === 0) throw new Error('the memory bank has no experiences — the eval would judge an empty candidate')
  const evidenceSummaries = renderExperienceSummaries(mem.bank).replace(/\[[0-9a-f-]{36}\]/g, '[id]')
  const preferences = renderPreferences(mem.bank)
  return {
    bank: mem.bank,
    missionText: renderMission(mission),
    evidenceSummaries: renderExperienceSummaries(mem.bank),
    preferences,
    judgeBackground: evidenceSummaries,
    contentVersion: crypto.createHash('sha256').update(`${evidenceSummaries}\n${preferences}`).digest('hex').slice(0, 16),
    costUsd: mem.costUsd,
  }
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

/** A NormalizedJob as a JobOpportunity row, with a caller-chosen stable id (the fit cache keys on it). */
export function toJobOpportunity(job: NormalizedJob, id: string, mission: CareerMission): JobOpportunity {
  const { sources: _s, company_domain: _d, company_key: _k, normalized_title: _t, ...cols } = job
  const now = new Date().toISOString()
  return {
    ...cols, id, user_id: EVAL_USER, company_id: null, mission_id: mission.id, discovery_run_id: null, duplicate_cluster_id: null,
    fit_overall: null, fit_eligibility: null, fit_computed_at: null, first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now,
  }
}

/** The extractor on the cheap tier, traced against an in-memory run. Cached by text hash. */
export async function extractCached(input: { title: string; company: string; location_raw: string | null; text: string; source_hint: string | null }, ctx: ToolContext, run: CareerRun): Promise<AgentResult<JobExtraction>> {
  const res = await runJobExtractor(input, ctx)
  await run.trace(res, { title: input.title, company: input.company })
  return res
}

export interface FitOutcome {
  jobId: string
  judgment: FitJudgment | null
  evaluation: FitEvaluation | null
  status: string
  error: string | null
  costUsd: number
}

/**
 * Fit with no company research and no feedback — the state a job is in the
 * moment discovery finds it, which is what ranking the fresh list depends on.
 * Cached per (job id, description, evidence, prompt version).
 */
export async function fitCached(job: JobOpportunity, bank: EvalBank, mission: CareerMission, ctx: ToolContext, run: CareerRun): Promise<FitOutcome> {
  const res = await runFitEvaluator(
    {
      mission: bank.missionText,
      job: fitJobInputFrom(job),
      companyResearch: '(no research yet)',
      evidenceSummaries: bank.evidenceSummaries,
      preferences: bank.preferences,
      feedbackContext: [],
    },
    ctx,
    // location_tier is in the key on purpose: a tiering fix changes what the
    // evaluator is shown, and a stale cached judgment would hide the fix.
    { cacheKeyParts: { job_id: job.id, description_sha: descriptionSha(job.description_text), research_version: 'none', evidence_version: bank.contentVersion, mission_id: mission.id, location_tier: job.location_tier, eval: 'no-db' } }
  )
  await run.trace(res, { job_id: job.id })
  const judgment = res.output
  return {
    jobId: job.id,
    judgment,
    evaluation: judgment ? evaluateFit({ judgment, weights: mission.fit_weights, feedbackAdjustment: 0, hardConstraintFailures: applyHardConstraints(job, mission.hard_constraints).failed.map((f) => f.label) }) : null,
    status: res.status,
    error: res.error ?? null,
    costUsd: res.trace.cost_usd,
  }
}

export { memoryRun, fitEvaluatorPrompt }

// ─── Judge blinding ──────────────────────────────────────────────────────────

/**
 * What the judge is shown must carry nothing the pipeline concluded. The
 * corpus ids say the expected class in their name (jd-neg-02-summer-2026,
 * jd-good-06-…), and the top-k list arrives in rank order — both leak. Ids
 * become a content hash and the batch is sorted by it, so the judge sees an
 * anonymous list in an order unrelated to the ranking; the order is also
 * stable across processes, which keeps the judge's cache key stable.
 */
export function blindForJudge<T extends { job_id: string }>(jobs: T[]): { inputs: T[]; unblind: (opaque: string) => string } {
  const back = new Map<string, string>()
  const inputs = jobs.map((j) => {
    const opaque = `job-${crypto.createHash('sha1').update(j.job_id).digest('hex').slice(0, 8)}`
    back.set(opaque, j.job_id)
    return { ...j, job_id: opaque }
  }).sort((a, b) => a.job_id.localeCompare(b.job_id))
  return { inputs, unblind: (opaque) => back.get(opaque) ?? opaque }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

export interface MetricResult {
  metric: string
  /** Fraction for rates, count for counts; `display` says which. */
  actual: number
  display: string
  target: string
  pass: boolean
  n: number
  note?: string
}

export function rate(metric: string, actual: number, n: number, target: string, pass: boolean, note?: string): MetricResult {
  return { metric, actual: round4(actual), display: n === 0 ? 'n/a' : pct(actual), target, pass, n, ...(note ? { note } : {}) }
}

export function count(metric: string, actual: number, n: number, target: string, pass: boolean, note?: string): MetricResult {
  return { metric, actual, display: String(actual), target, pass, n, ...(note ? { note } : {}) }
}

export function metricsTable(results: MetricResult[]): string {
  const rows = results.map((r) => [r.pass ? 'PASS' : 'FAIL', r.metric, r.display, r.target, `n=${r.n}`, r.note ?? ''])
  const widths = [4, ...[1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)))]
  return rows.map((r) => `${r[0]}  ${r[1].padEnd(widths[1])}  ${r[2].padStart(widths[2])}  target ${r[3].padEnd(widths[3])}  ${r[4].padEnd(widths[4])}  ${r[5]}`).join('\n')
}

/** Description text as the judge sees it: enough to find the disqualifying line, not the whole page. */
export function judgeDescription(text: string | null, max = 2600): string {
  const t = (text ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > max ? `${t.slice(0, max)} …` : t
}

export function short(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
