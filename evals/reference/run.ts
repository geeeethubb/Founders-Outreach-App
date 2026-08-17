// Campaign-reference writing eval.
//
// The question: **does pasting one real email actually change how the system
// writes, in the direction the user asked for?**
//
// It is a CONTROLLED comparison, and that is the whole design. Every prospect is
// written twice:
//
//   treatment  reference mode — the campaign's real email defines the voice
//   control    brief mode — the house style, exactly as it shipped before
//
// Both are judged blind, in the same batch, against the same reference. Without
// the control, a reference-similarity score of 3.8 is unreadable: it could mean
// the feature works, or it could mean the house style already happened to sound
// like this user. The delta is the measurement.

import { runOutreach, type OutreachReference } from '@/lib/agents/outreach'
import { runStyleAnalyst, measureEmail, targetWordsFor, type ReferenceStyle } from '@/lib/agents/style-analyst'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'
import { buildEvidence, buildVerificationPool, evidenceFromReference, safeNamesFor } from '@/lib/outreach/evidence'
import { checkGrounding } from '@/lib/outreach/grounding'
import { RESUME_ITEMS } from '@/evals/phase3/user-profile'
import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { REFERENCE_CAMPAIGNS, type ReferenceCampaignFixture } from './campaigns'
import { PROSPECT_FIXTURES, PAIRINGS, type ProspectFixture } from './prospects'
import { checkDraft, type DraftChecks } from './checks'
import { judgeReferenceDrafts, type ReferenceJudgement, type JudgeDraftInput } from './judge'

const SENDER = { name: 'Zuyu Liu', signoffContext: 'undergraduate, chemical engineering' }

export interface DraftResult {
  id: string
  mode: 'reference' | 'control'
  campaign: string
  prospect: string
  subject: string
  body: string
  wordCount: number
  checks: DraftChecks
  groundingBlocking: number
  groundingFindings: string[]
  judgement: ReferenceJudgement | null
  error: string | null
}

export interface CampaignStyleReport {
  campaign: string
  expected: string
  referenceWords: number
  targetWords: { min: number; max: number }
  summary: string
  structure: string[]
  distinctiveMoves: string[]
  recipientSpecific: string[]
  costUsd: number
}

export interface ReferenceEvalResult {
  styles: CampaignStyleReport[]
  drafts: DraftResult[]
  totals: {
    referenceSimilarity: number
    controlSimilarity: number
    similarityDelta: number
    sameWriterRate: number
    controlSameWriterRate: number
    recipientRelevance: number
    factGrounding: number
    naturalness: number
    ctaFit: number
    templateAvoidance: number
    overall: number
    placeholderCount: number
    controlPlaceholderCount: number
    copiedFromReferenceCount: number
    overCompressedRate: number
    controlOverCompressedRate: number
    deterministicPassRate: number
  }
  costUsd: number
  judgeCostUsd: number
  errors: string[]
}

export interface RunReferenceEvalParams {
  userId: string
  /** Skip the house-style control to halve the cost. Default false. */
  skipControl?: boolean
  campaigns?: ReferenceCampaignFixture[]
  concurrency?: number
  onProgress?: (message: string) => void
}

export async function runReferenceEval(params: RunReferenceEvalParams): Promise<ReferenceEvalResult> {
  const log = params.onProgress ?? (() => {})
  const campaigns = params.campaigns ?? REFERENCE_CAMPAIGNS
  const concurrency = params.concurrency ?? 3
  const errors: string[] = []

  resetAnthropicUsage()

  const ctx: ToolContext = {
    user_id: params.userId,
    run_id: null,
    budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 5 },
  }

  // ─── 1. Analyse each reference once ───
  log('analysing reference emails…')
  const styles = new Map<string, ReferenceStyle>()
  const styleReports: CampaignStyleReport[] = []

  for (const c of campaigns) {
    const measured = measureEmail(c.body)
    const run = await runStyleAnalyst(
      {
        campaignName: c.name,
        campaignGoal: c.goal,
        targetAudience: c.targetAudience,
        notes: c.notes,
        reference: { subject: c.subject, body: c.body },
        measured,
      },
      ctx
    )
    if (!run.output) {
      errors.push(`style_analyst(${c.key}): ${run.error}`)
      continue
    }
    const style: ReferenceStyle = { ...run.output, measured, target_words: targetWordsFor(measured) }
    styles.set(c.key, style)
    styleReports.push({
      campaign: c.key,
      expected: c.expected,
      referenceWords: measured.words,
      targetWords: style.target_words,
      summary: style.summary,
      structure: style.structure,
      distinctiveMoves: style.distinctive_moves,
      recipientSpecific: style.recipient_specific,
      costUsd: run.trace.cost_usd,
    })
    log(`  ${c.key}: ${measured.words} words → target ${style.target_words.min}-${style.target_words.max}`)
  }

  // ─── 2. Write every pairing, twice ───
  const prospectByKey = new Map(PROSPECT_FIXTURES.map((p) => [p.key, p]))
  const campaignByKey = new Map(campaigns.map((c) => [c.key, c]))
  const pairings = PAIRINGS.filter((p) => campaignByKey.has(p.campaign) && prospectByKey.has(p.prospect))

  const jobs: { campaign: ReferenceCampaignFixture; prospect: ProspectFixture; mode: 'reference' | 'control' }[] = []
  for (const p of pairings) {
    const campaign = campaignByKey.get(p.campaign)!
    const prospect = prospectByKey.get(p.prospect)!
    jobs.push({ campaign, prospect, mode: 'reference' })
    if (!params.skipControl) jobs.push({ campaign, prospect, mode: 'control' })
  }

  log(`writing ${jobs.length} drafts (${pairings.length} pairings${params.skipControl ? '' : ' × 2 modes'})…`)

  const drafts = await mapWithConcurrency(jobs, concurrency, async (job): Promise<DraftResult | null> => {
    const style = styles.get(job.campaign.key)
    if (!style) return null

    const chosen = job.prospect.proofPointIds
      .map((id) => RESUME_ITEMS.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))

    const allowed = buildEvidence({
      companyContext: job.prospect.companyContext,
      personContext: job.prospect.personContext,
      recipientTitle: job.prospect.title,
      recipientCompany: job.prospect.company,
      chosenBackground: chosen,
    })

    const reference: OutreachReference = {
      campaignName: job.campaign.name,
      campaignGoal: job.campaign.goal,
      targetAudience: job.campaign.targetAudience,
      notes: job.campaign.notes,
      subject: job.campaign.subject,
      body: job.campaign.body,
      style,
    }

    const out = await runOutreach(
      {
        mission: { goal: job.campaign.goal, timeframe: 'Summer 2027' },
        sender: SENDER,
        person: {
          name: job.prospect.name,
          firstName: job.prospect.firstName,
          title: job.prospect.title,
          company: job.prospect.company,
        },
        positioning: job.prospect.positioning,
        groundedFacts: allowed,
        // The control is the house band, exactly as it shipped.
        wordTarget: job.mode === 'reference' ? style.target_words : { min: 60, max: 120 },
        reference: job.mode === 'reference' ? reference : null,
        relationshipNote: job.prospect.relationshipNote,
      },
      ctx
    )

    const id = `${job.campaign.key}__${job.prospect.key}__${job.mode}`
    if (!out.output) {
      return {
        id,
        mode: job.mode,
        campaign: job.campaign.key,
        prospect: job.prospect.key,
        subject: '',
        body: '',
        wordCount: 0,
        checks: checkDraft({
          subject: '',
          body: '',
          reference: { subject: job.campaign.subject, body: job.campaign.body },
          style,
          safeNames: [],
        }),
        groundingBlocking: 0,
        groundingFindings: [],
        judgement: null,
        error: out.error,
      } satisfies DraftResult
    }

    const verificationPool = [
      ...buildVerificationPool(
        allowed,
        RESUME_ITEMS.map((r) => ({ id: r.id, title: r.title, org: r.org, period: r.period, summary: r.summary })),
        chosen.map((c) => c.id)
      ),
      // Reference mode only: what the user asserted about themselves in their
      // own email counts as evidence; what they said about its recipient does not.
      ...(job.mode === 'reference' ? evidenceFromReference(job.campaign.body, style.recipient_specific) : []),
    ]
    const grounding = checkGrounding({
      subject: out.output.subject,
      body: out.output.body,
      evidence: verificationPool,
      safeNames: safeNamesFor({
        recipientName: job.prospect.name,
        recipientCompany: job.prospect.company,
        senderName: SENDER.name,
        timeframe: 'Summer 2027',
      }),
    })

    const checks = checkDraft({
      subject: out.output.subject,
      body: out.output.body,
      reference: { subject: job.campaign.subject, body: job.campaign.body },
      style,
      safeNames: [job.prospect.name, job.prospect.firstName, job.prospect.company, SENDER.name],
      // The sender's own record. Reusing "P&G's Tabler Station" or "Founders:
      // Illinois Entrepreneurs" across two emails by the same person is the
      // campaign working, not a lift from the reference.
      senderVocab: [
        SENDER.name,
        SENDER.signoffContext,
        'Founders Illinois Entrepreneurs UIUC undergraduate chemical engineering',
        ...RESUME_ITEMS.map((r) => `${r.title} ${r.org} ${r.summary}`),
      ],
      hasPriorRelationship: Boolean(job.prospect.relationshipNote),
    })

    return {
      id,
      mode: job.mode,
      campaign: job.campaign.key,
      prospect: job.prospect.key,
      subject: out.output.subject,
      body: out.output.body,
      wordCount: out.output.wordCount,
      checks,
      groundingBlocking: grounding.blocking.length,
      groundingFindings: grounding.blocking.map((f) => `${f.kind}: ${f.claim}`),
      judgement: null,
      error: null,
    } satisfies DraftResult
  })

  const written = drafts.filter((d): d is DraftResult => d !== null)
  const productionCost = anthropicUsage().costUsd
  log(`${written.filter((d) => !d.error).length}/${written.length} drafts written · $${productionCost.toFixed(4)}`)

  // ─── 3. Judge, blind ───
  const judgeInputs: JudgeDraftInput[] = written
    .filter((d) => !d.error && d.body)
    .map((d) => {
      const campaign = campaignByKey.get(d.campaign)!
      const prospect = prospectByKey.get(d.prospect)!
      return {
        draft_id: d.id,
        reference: { subject: campaign.subject, body: campaign.body },
        recipient: { name: prospect.name, title: prospect.title, company: prospect.company },
        research: `${prospect.companyContext}\n\n${prospect.personContext}`,
        draft: { subject: d.subject, body: d.body },
      }
    })

  log(`judging ${judgeInputs.length} drafts…`)
  const judged = await judgeReferenceDrafts(judgeInputs)
  if (judged.error) errors.push(`judge: ${judged.error}`)
  const byId = new Map(judged.results.map((j) => [j.draft_id, j]))
  for (const d of written) d.judgement = byId.get(d.id) ?? null

  // ─── 4. Totals ───
  const ref = written.filter((d) => d.mode === 'reference' && d.judgement)
  const ctl = written.filter((d) => d.mode === 'control' && d.judgement)
  const mean = (list: DraftResult[], pick: (j: ReferenceJudgement) => number) =>
    list.length ? list.reduce((s, d) => s + pick(d.judgement!), 0) / list.length : 0
  const rate = (list: DraftResult[], pred: (d: DraftResult) => boolean) =>
    list.length ? list.filter(pred).length / list.length : 0

  const refAll = written.filter((d) => d.mode === 'reference' && !d.error)
  const ctlAll = written.filter((d) => d.mode === 'control' && !d.error)

  return {
    styles: styleReports,
    drafts: written,
    totals: {
      referenceSimilarity: mean(ref, (j) => j.reference_similarity),
      controlSimilarity: mean(ctl, (j) => j.reference_similarity),
      similarityDelta: mean(ref, (j) => j.reference_similarity) - mean(ctl, (j) => j.reference_similarity),
      sameWriterRate: rate(ref, (d) => d.judgement?.same_writer === true),
      controlSameWriterRate: rate(ctl, (d) => d.judgement?.same_writer === true),
      recipientRelevance: mean(ref, (j) => j.recipient_relevance),
      factGrounding: mean(ref, (j) => j.fact_grounding),
      naturalness: mean(ref, (j) => j.naturalness),
      ctaFit: mean(ref, (j) => j.cta_fit),
      templateAvoidance: mean(ref, (j) => j.template_avoidance),
      overall: mean(ref, (j) => j.overall),
      placeholderCount: refAll.reduce((s, d) => s + d.checks.placeholders.length, 0),
      controlPlaceholderCount: ctlAll.reduce((s, d) => s + d.checks.placeholders.length, 0),
      copiedFromReferenceCount: refAll.reduce((s, d) => s + d.checks.copiedFromReference.length, 0),
      overCompressedRate: rate(refAll, (d) => d.checks.overCompressed),
      controlOverCompressedRate: rate(ctlAll, (d) => d.checks.overCompressed),
      deterministicPassRate: rate(refAll, (d) => d.checks.passed && d.groundingBlocking === 0),
    },
    costUsd: productionCost,
    judgeCostUsd: judged.costUsd,
    errors,
  }
}
