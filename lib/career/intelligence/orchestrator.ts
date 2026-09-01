// Job intelligence: research → fit → evidence map → warm paths, for one job.
//
// Four agents, each a pure function; this file loads their inputs, decides
// whether a stored answer is still good, persists what comes back and traces
// every call. The stages are independent on purpose: a researcher that times
// out costs the fit evaluator its company context, not its existence, and a
// pathfinder with nobody to judge is simply skipped. One stage failing never
// stops the others — errors are collected and returned (principle 9).
//
// What is reused, and when:
//   research      companies.researched_at within RESEARCH_TTL_DAYS and the same prompt version
//   fit           a stored evaluation at the current prompt version, unless forced
//   evidence map  a stored map at the current prompt version, unless forced
//   warm paths    stored rows, unless forced
// The agents are additionally disk-cached by content, so a forced re-run with
// identical inputs is free — forcing is about "read the stored answer or
// not", never about spending money twice on the same question.

import crypto from 'crypto'
import { runCompanyResearcher, companyResearcherPrompt, type CompanyResearch } from '@/lib/agents/company-researcher'
import { runFitEvaluator, fitEvaluatorPrompt } from '@/lib/agents/fit-evaluator'
import { runEvidenceMatcher, evidenceMatcherPrompt, type EvidenceMatch } from '@/lib/agents/evidence-matcher'
import { runNetworkPathfinder, type JudgedPath } from '@/lib/agents/network-pathfinder'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { GenerationDeadline, withDeadline } from '../package/deadline'
import { renderPreferences, renderSkills, renderStories } from '../evidence/render'
import { getRelevantPersonalEvidence, renderRelevantEvidence } from '../evidence/retrieval'
import { retrievalTargetForJob } from '../evidence/retrieval-targets'
import { buildFitEvaluationRow, evaluateFit, type FitEvaluation } from '../fit/evaluate'
import { computeFeedbackAdjustment, renderFeedbackHints, type FeedbackRow } from '../fit/feedback'
import { applyHardConstraints } from '../jobs/filters'
import { descriptionSha } from '../jobs/snapshot'
import { renderMission, sanitizeDirection } from '../missions/store'
import { findWarmPathCandidates } from '../network/candidates'
import { renderCompanyResearchForPrompt } from '../research/company'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun, type CareerRun } from '../runs'
import type { CareerMission, EvidenceBank, FitJudgment, JobEvidenceMap, JobFitEvaluation, WarmPath } from '../types'
import { fitJobInputFrom, loadFeedbackRows, loadJobContext, researchFromStored, researchInputFrom, type JobContext } from './load'
import { persistCompanyResearch, replaceWarmPaths, upsertEvidenceMap, upsertFitEvaluation } from './persist'
import { ensureExtracted, needsExtraction } from './extract'

export const RESEARCH_TTL_DAYS = 30

export interface IntelligenceForce {
  research?: boolean
  fit?: boolean
  match?: boolean
  paths?: boolean
}

export type IntelligenceStage = 'extract' | 'research' | 'fit' | 'match' | 'paths'

/**
 * Stages to leave out entirely. Post-scout ranking skips research: the list
 * the user gets back needs a fit number in seconds, and the researcher's web
 * searches are the slow, expensive stage — the package flow runs it later,
 * when one job has been chosen. Skipped is not failed: the fit prompt reads
 * '(no research yet)', exactly as it does for a company nobody researched.
 */
export interface IntelligenceSkip {
  research?: boolean
}

export interface IntelligenceParams {
  userId: string
  jobId: string
  ctx?: ToolContext
  run?: CareerRun
  force?: IntelligenceForce
  skip?: IntelligenceSkip
  /** A context the caller already loaded (the package orchestrator has one). */
  context?: JobContext
  feedbackRows?: FeedbackRow[]
  /**
   * No database at all: nothing is persisted, warm paths are skipped (they
   * live in the network tables), and the run is in-memory. The no-DB CLI and
   * the evals run the same agents through the same code this way.
   */
  noDb?: boolean
  /**
   * The package's shared clock. When present, each intelligence stage is bound
   * by what is left rather than by its own patience, and a stage that runs out
   * DEGRADES rather than blocking: research is enrichment, and the fit
   * evaluator, the matcher and the letter all already handle its absence
   * (`renderCompanyResearchForPrompt` returns "(no research yet)").
   *
   * Absent — the CLI, the evals, the batch helper — behaviour is unchanged.
   */
  deadline?: GenerationDeadline
  onProgress?: (stage: IntelligenceStage, detail: string) => void
}

export interface IntelligenceResult {
  research: CompanyResearch | null
  /** True when the stored research was reused (no agent call). */
  researchFromCache: boolean
  fit: { judgment: FitJudgment; evaluation: FitEvaluation; row: JobFitEvaluation | null } | null
  fitFromStore: boolean
  evidenceMap: EvidenceMatch | null
  evidenceMapRow: JobEvidenceMap | null
  warmPaths: JudgedPath[]
  warmPathRows: WarmPath[]
  costUsd: number
  errors: string[]
  migrationMissing: boolean
  context: JobContext | null
  runId: string | null
}

/** A CareerRun that records nothing — cost and call counts only. For runs with no database behind them. */
export function memoryRun(): CareerRun {
  let cost = 0
  let calls = 0
  return {
    runId: null,
    migrationMissing: false,
    async trace(result) {
      cost += result.trace.cost_usd
      calls += 1
      return null
    },
    costUsd: () => cost,
    agentCalls: () => calls,
    async finish() {},
  }
}

export function packageToolContext(userId: string, runId: string | null): ToolContext {
  const b = DEFAULT_PACKAGE_BUDGET
  return {
    user_id: userId,
    run_id: runId,
    budget: { maxCompanies: 1, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: b.maxWebSearches, maxAgentSteps: b.maxAgentSteps },
  }
}

/** Approved evidence identity: the fit and matcher caches turn over when the bank does. */
export function evidenceVersion(bank: EvidenceBank): string {
  const ids = [...bank.experiences.map((e) => e.id), ...bank.facts.map((f) => f.id), ...bank.metrics.map((m) => m.id)].sort()
  return crypto.createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 16)
}

/**
 * Identity of a fit judgment: the prompt version plus the mission direction it
 * was judged toward. Stored on the fit row's `prompt_version` (no migration —
 * the column is text) and compared on reuse, so saving or editing the direction
 * on the Jobs / Mission page invalidates every stored rank the same way a
 * prompt bump does. The agent_runs trace keeps the bare prompt version.
 */
export function fitJudgmentVersion(mission: Pick<CareerMission, 'preferences'>): string {
  const direction = sanitizeDirection(mission.preferences?.direction)
  if (!direction) return fitEvaluatorPrompt.version
  const sha = crypto.createHash('sha256').update(direction).digest('hex').slice(0, 12)
  return `${fitEvaluatorPrompt.version}+direction.${sha}`
}

export function researchIsFresh(company: { researched_at?: string | null; research_version?: string | null } | null, now = new Date()): boolean {
  if (!company?.researched_at || company.research_version !== companyResearcherPrompt.version) return false
  const age = now.getTime() - new Date(company.researched_at).getTime()
  return age >= 0 && age < RESEARCH_TTL_DAYS * 86_400_000
}

function judgmentFromRow(row: JobFitEvaluation): FitJudgment {
  return {
    components: row.components,
    eligibility: row.eligibility,
    eligibility_reasoning: row.eligibility_reasoning ?? '',
    explanation: row.explanation ?? '',
    uncertainties: row.uncertainties ?? [],
    red_flags: row.red_flags ?? [],
    missing_qualifications: row.missing_qualifications ?? [],
    confidence: row.confidence ?? 0,
  }
}

function matchFromRow(row: JobEvidenceMap): EvidenceMatch {
  return {
    why_i_fit: row.why_i_fit ?? '',
    top_experience_ids: row.top_experience_ids,
    fact_ids: row.fact_ids,
    metric_ids: row.metric_ids,
    skill_ids: row.skill_ids,
    story_ids: row.story_ids,
    gaps: row.gaps,
    best_differentiator: row.best_differentiator ?? '',
    emphasize: row.emphasize,
    do_not_claim: row.do_not_claim,
    no_gaps_reason: null,
    ungrounded_ids: 0,
  }
}

export async function runJobIntelligence(params: IntelligenceParams): Promise<IntelligenceResult> {
  const errors: string[] = []
  const force = params.force ?? {}
  const progress = params.onProgress ?? (() => {})
  const empty = (error: string, migrationMissing: boolean): IntelligenceResult => ({
    research: null, researchFromCache: false, fit: null, fitFromStore: false, evidenceMap: null, evidenceMapRow: null,
    warmPaths: [], warmPathRows: [], costUsd: 0, errors: [error], migrationMissing, context: null, runId: params.run?.runId ?? null,
  })

  const noDb = params.noDb === true
  let context = params.context ?? null
  if (!context) {
    if (noDb) return empty('noDb requires a preloaded context', false)
    const loaded = await loadJobContext(params.userId, params.jobId)
    if (!loaded.ctx) return empty(loaded.error, loaded.migrationMissing)
    context = loaded.ctx
  }
  errors.push(...context.errors)
  const { company, mission, bank } = context
  let job = context.job

  const ownRun = !params.run
  const run = params.run ?? (noDb ? memoryRun() : await startCareerRun({
    userId: params.userId,
    kind: 'package',
    label: `intelligence: ${job.company_name} — ${job.title}`,
    mission: { job_id: job.id, mission_id: mission.id },
    budget: DEFAULT_PACKAGE_BUDGET,
    careerMissionId: mission.id,
  }))
  const ctx = params.ctx ?? packageToolContext(params.userId, run.runId)
  const costBefore = run.costUsd()

  // ─── (0) Extraction backfill ───
  // A job the scout persisted under its deadline has a description and nothing
  // else. Complete it here, once, before anything judges it.
  if (needsExtraction(job)) {
    progress('extract', `backfilling extraction for ${job.title}`)
    const ex = await ensureExtracted({ userId: params.userId, job, mission, ctx, run, noDb })
    if (ex.error) errors.push(ex.error)
    if (ex.extracted) {
      job = ex.job
      context = { ...context, job }
      if (ex.closedByText) errors.push('the posting text says this role is closed; stored as CLOSED')
    }
  }

  // ─── (a) Company research ───
  let research: CompanyResearch | null = null
  let researchFromCache = false
  if (!force.research && researchIsFresh(company)) {
    research = researchFromStored(context.existing.research.summary, company, context.existing.research.facts)
    researchFromCache = research !== null
  }
  if (!research && params.skip?.research) {
    // Stored research is still used when fresh; only a NEW researcher call is skipped.
  } else if (!research) {
    progress('research', job.company_name)
    try {
      // THE CRITICAL PATH, AND THE ONE THAT CAN HANG. Company research is a
      // 7-step agent with web search; measured cold runs take 126–304s, which
      // on its own can exhaust a 5-minute package. Bounded here and allowed to
      // return nothing: a package built from the job description alone is worth
      // far more than one that never arrives.
      const researchBudget = params.deadline ? params.deadline.budgetFor('research') : 0
      const res = params.deadline
        ? await withDeadline(
            'company research',
            researchBudget,
            () => runCompanyResearcher(researchInputFrom(job, company, mission), ctx),
            { onTimeout: () => null }
          )
        : await runCompanyResearcher(researchInputFrom(job, company, mission), ctx)
      if (res === null) {
        errors.push(`research: no result within ${Math.round(researchBudget / 1000)}s — continuing from the job description and any stored company data`)
      } else {
      const done = res
      const agentRunId = await run.trace(done, { job_id: job.id, company_id: company?.id ?? null })
      if (done.output) {
        research = done.output
        if (company && !noDb) {
          const w = await persistCompanyResearch({
            userId: params.userId, runId: run.runId, companyId: company.id, companyName: job.company_name,
            agentRunId, research, promptVersion: done.trace.prompt_version,
          })
          if (w.error) errors.push(`research persist: ${w.error}`)
          if (w.rejected) errors.push(`research: ${w.rejected} unsourced claim(s) rejected by the database`)
        }
      } else {
        errors.push(`research ${done.status}: ${done.error ?? 'no output'}`)
      }
      }
    } catch (e) {
      errors.push(`research: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ─── (b) Fit ───
  let fit: IntelligenceResult['fit'] = null
  let fitFromStore = false
  const feedbackRows = params.feedbackRows ?? (noDb ? [] : (await loadFeedbackRows(params.userId)).rows)
  const adjustment = computeFeedbackAdjustment(
    { id: job.id, role_family: job.role_family, industry: job.industry, company_name: job.company_name, location_tier: job.location_tier, company_type: company?.company_type ?? null },
    feedbackRows
  )
  // Discovery rejects these before storing; a manual add keeps them with a warning. Either way the rank must show it.
  const hardConstraintFailures = applyHardConstraints(job, mission.hard_constraints).failed.map((f) => f.label)
  const stored = context.existing.fit
  const judgmentVersion = fitJudgmentVersion(mission)
  if (!force.fit && stored && stored.prompt_version === judgmentVersion) {
    const judgment = judgmentFromRow(stored)
    fit = { judgment, evaluation: evaluateFit({ judgment, weights: mission.fit_weights, feedbackAdjustment: adjustment.adjustment, hardConstraintFailures }), row: stored }
    fitFromStore = true
  } else {
    progress('fit', job.title)
    try {
      const jobInput = fitJobInputFrom(job)
      // Retrieval, not the whole bank: the six experiences that plausibly
      // matter for THIS posting, compact (principle 5).
      const relevant = getRelevantPersonalEvidence({ bank, mission: renderMission(mission), target: retrievalTargetForJob(job), maxExperiences: 6, maxFacts: 16 })
      const res = await runFitEvaluator(
        {
          mission: renderMission(mission),
          job: jobInput,
          companyResearch: renderCompanyResearchForPrompt(research),
          evidenceSummaries: renderRelevantEvidence(relevant, { style: 'compact' }),
          preferences: renderPreferences(bank),
          feedbackContext: renderFeedbackHints(feedbackRows),
        },
        ctx,
        {
          cacheKeyParts: {
            job_id: job.id,
            description_sha: descriptionSha(job.description_text),
            research_version: research ? `${companyResearcherPrompt.version}:${research.summary.slice(0, 80)}` : 'none',
            evidence_version: evidenceVersion(bank),
            mission_id: mission.id,
            judgment_version: judgmentVersion,
          },
        }
      )
      const agentRunId = await run.trace(res, { job_id: job.id, mission_id: mission.id })
      if (res.output) {
        const evaluation = evaluateFit({ judgment: res.output, weights: mission.fit_weights, feedbackAdjustment: adjustment.adjustment, hardConstraintFailures })
        const row = buildFitEvaluationRow({
          userId: params.userId, jobId: job.id, missionId: mission.id, judgment: res.output, evaluation,
          promptVersion: judgmentVersion, agentRunId,
        })
        let persisted: JobFitEvaluation | null = null
        if (!noDb) {
          const w = await upsertFitEvaluation(row)
          if (w.error) errors.push(`fit persist: ${w.error}`)
          persisted = w.row
        }
        fit = { judgment: res.output, evaluation, row: persisted }
      } else {
        errors.push(`fit ${res.status}: ${res.error ?? 'no output'}`)
      }
    } catch (e) {
      errors.push(`fit: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ─── (c) Evidence map ───
  let evidenceMap: EvidenceMatch | null = null
  let evidenceMapRow: JobEvidenceMap | null = null
  const storedMap = context.existing.evidenceMap
  if (!force.match && storedMap && storedMap.prompt_version === evidenceMatcherPrompt.version) {
    evidenceMap = matchFromRow(storedMap)
    evidenceMapRow = storedMap
  } else if (bank.experiences.length === 0) {
    errors.push('match: the Evidence Bank has no approved experiences')
  } else {
    progress('match', job.title)
    try {
      const relevant = getRelevantPersonalEvidence({ bank, mission: renderMission(mission), target: retrievalTargetForJob(job), maxExperiences: 6, maxFacts: 16, includeStories: true })
      const res = await runEvidenceMatcher(
        {
          job: fitJobInputFrom(job),
          evidenceSummaries: renderRelevantEvidence(relevant, { style: 'compact' }),
          detail: renderRelevantEvidence(relevant, { style: 'detailed', maxFactsPerExperience: 8 }),
          skills: renderSkills(bank),
          stories: renderStories(bank),
          validIds: {
            experience_ids: bank.experiences.map((e) => e.id),
            fact_ids: bank.facts.map((f) => f.id),
            metric_ids: bank.metrics.map((m) => m.id),
            skill_ids: bank.skills.map((s) => s.id),
            story_ids: bank.stories.map((s) => s.id),
          },
        },
        ctx,
        { cacheKeyParts: { job_id: job.id, description_sha: descriptionSha(job.description_text), evidence_version: evidenceVersion(bank) } }
      )
      const agentRunId = await run.trace(res, { job_id: job.id })
      if (res.output) {
        evidenceMap = res.output
        if (!noDb) {
          const w = await upsertEvidenceMap({ userId: params.userId, jobId: job.id, match: res.output, promptVersion: res.trace.prompt_version, agentRunId })
          if (w.error) errors.push(`match persist: ${w.error}`)
          evidenceMapRow = w.row
        }
      } else {
        errors.push(`match ${res.status}: ${res.error ?? 'no output'}`)
      }
    } catch (e) {
      errors.push(`match: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ─── (d) Warm paths ───
  let warmPaths: JudgedPath[] = []
  let warmPathRows: WarmPath[] = []
  if (noDb) {
    // Warm paths read the network tables; there is no in-memory network.
  } else if (!force.paths && context.existing.warmPaths.length) {
    warmPathRows = context.existing.warmPaths
    warmPaths = warmPathRows.map((w) => ({
      contact_id: w.contact_id, relationship: w.relationship, strength: Number(w.strength), why_relevant: w.why_relevant ?? '',
      suggested_action: w.suggested_action ?? '', existing_history: w.existing_history,
    }))
  } else {
    progress('paths', job.company_name)
    try {
      const slate = await findWarmPathCandidates(params.userId, {
        companyName: job.company_name, companyId: company?.id ?? null, domain: company?.domain ?? null, industry: job.industry, jobTitle: job.title,
      })
      if (slate.candidates.length > 0) {
        const res = await runNetworkPathfinder(
          { company: { name: job.company_name, domain: company?.domain ?? null, industry: job.industry }, job_title: job.title, candidates: slate.candidates },
          ctx,
          { cacheKeyParts: { company: job.company_name, job_id: job.id, contact_ids: slate.candidates.map((c) => c.contact_id).sort() } }
        )
        const agentRunId = await run.trace(res, { job_id: job.id, company_id: company?.id ?? null })
        if (res.output) {
          warmPaths = res.output.paths
          const w = await replaceWarmPaths({ userId: params.userId, jobId: job.id, companyId: company?.id ?? null, paths: warmPaths, candidates: slate.candidates, agentRunId })
          if (w.error) errors.push(`paths persist: ${w.error}`)
          warmPathRows = w.rows
        } else {
          errors.push(`paths ${res.status}: ${res.error ?? 'no output'}`)
        }
      }
    } catch (e) {
      errors.push(`paths: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const costUsd = Number((run.costUsd() - costBefore).toFixed(4))
  if (ownRun) {
    await run.finish(errors.length ? 'succeeded' : 'succeeded', {
      job_id: job.id, research_from_cache: researchFromCache, fit_from_store: fitFromStore, warm_paths: warmPaths.length, errors,
    })
  }

  return {
    research, researchFromCache, fit, fitFromStore, evidenceMap, evidenceMapRow, warmPaths, warmPathRows,
    costUsd, errors, migrationMissing: false, context, runId: run.runId,
  }
}

// ─── Batch (post-scout ranking) ──────────────────────────────────────────────

export interface BatchResult {
  results: Record<string, { fit: number | null; eligibility: string | null; errors: string[] }>
  skipped: string[]
  costUsd: number
  errors: string[]
  runId: string | null
}

/**
 * Intelligence for many jobs after a scout run. Research is per company and
 * cached, so twenty postings from one board cost one research call. Jobs not
 * started before the deadline are reported as skipped, never silently dropped.
 */
export async function runIntelligenceBatch(
  userId: string,
  jobIds: string[],
  opts: { concurrency?: number; deadlineMs?: number; force?: IntelligenceForce; skip?: IntelligenceSkip; label?: string; onProgress?: (jobId: string, stage: IntelligenceStage, detail: string) => void } = {}
): Promise<BatchResult> {
  const started = Date.now()
  const deadline = opts.deadlineMs ?? DEFAULT_PACKAGE_BUDGET.deadlineMs
  const run = await startCareerRun({ userId, kind: 'package', label: opts.label ?? `intelligence batch: ${jobIds.length} jobs`, mission: { job_ids: jobIds }, budget: DEFAULT_PACKAGE_BUDGET })
  const feedback = (await loadFeedbackRows(userId)).rows
  const results: BatchResult['results'] = {}
  const skipped: string[] = []
  const errors: string[] = []

  await mapWithConcurrency(jobIds, opts.concurrency ?? 3, async (jobId) => {
    if (Date.now() - started > deadline) {
      skipped.push(jobId)
      return
    }
    const r = await runJobIntelligence({
      userId, jobId, run, force: opts.force, skip: opts.skip, feedbackRows: feedback,
      onProgress: (stage, detail) => opts.onProgress?.(jobId, stage, detail),
    })
    results[jobId] = { fit: r.fit?.evaluation.overall ?? null, eligibility: r.fit?.judgment.eligibility ?? null, errors: r.errors }
    if (r.migrationMissing) errors.push('migration 014_career_os.sql has not been applied')
  })

  await run.finish('succeeded', { jobs: jobIds.length, skipped: skipped.length }, errors[0] ?? null)
  return { results, skipped, costUsd: Number(run.costUsd().toFixed(4)), errors, runId: run.runId }
}
