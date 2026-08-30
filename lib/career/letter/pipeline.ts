// The cover-letter pipeline. Pure: bank + job + research in, a gated letter
// out. The orchestrator persists to cover_letters.
//
// One retry. A draft that fails the grounding gate goes back to the writer
// once with the exact findings as revision notes; if the second draft still
// fails it is returned FLAGGED, never discarded (ADR-010). The human sees the
// letter and the findings, and the package cannot advance until they act.

import { runCoverLetterWriter, DEFAULT_LENGTH, NARRATIVE, type CoverLetterInput, type CoverLetterOutput } from '@/lib/agents/cover-letter-writer'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { buildBankPool, factsById } from '../evidence/render'
import { getRelevantPersonalEvidence } from '../evidence/retrieval'
import { retrievalTargetForLetterJob } from '../evidence/retrieval-targets'
import { printableName } from '../identity'
import { gateCoverLetter, revisionNotesFrom, type LetterGrounding } from './grounding'
import type { CoverLetterClaim, EvidenceBank, JobEvidenceMap } from '../types'

export const MAX_LETTER_FACTS = 10
export const MAX_LETTER_STORIES = 2

export interface CoverLetterJob {
  title: string
  company: string
  location: string | null
  /** A few sentences on the role — responsibilities or the description's opening. */
  summary: string
  /** The full posting text, when known — the gate lets the letter echo what the posting itself says. */
  postingText?: string | null
}

export interface CompanyResearchForLetter {
  /** Each id is a research_facts row id; the text is the claim. */
  points: { id: string; text: string }[]
  summary: string
  /**
   * FACT-typed claim texts (each backed by a retrieved URL). Citable by the
   * gate alongside the points. INFERENCE claims are deliberately NOT accepted
   * here: the first live letter named two competitors that existed only in
   * an inference and the summary, and the gate let them through.
   */
  factClaims?: string[]
  /** The company's domain, so "kairospower.com" in a letter is not an unknown entity. */
  domain?: string | null
}

export type EvidenceMapForLetter = Pick<JobEvidenceMap, 'why_i_fit' | 'fact_ids' | 'story_ids' | 'top_experience_ids'>

export interface LetterDeps {
  writer: (input: CoverLetterInput, ctx: ToolContext) => Promise<AgentResult<CoverLetterOutput>>
}

export interface CoverLetterResult {
  greeting: string | null
  paragraphs: string[]
  closing: string | null
  claims: CoverLetterClaim[]
  grounding: LetterGrounding | null
  fullText: string | null
  wordCount: number | null
  /** True when the letter still has blocking findings after the retry. */
  flagged: boolean
  attempts: number
  runs: AgentResult<unknown>[]
  costUsd: number
  prompt_version: string | null
  error: string | null
}

export interface CoverLetterParams {
  bank: EvidenceBank
  job: CoverLetterJob
  companyResearch: CompanyResearchForLetter
  evidenceMap: EvidenceMapForLetter
  ctx: ToolContext
  user: { name: string }
  deps?: Partial<LetterDeps>
  length?: { min: number; max: number }
  /** Notes for the first draft — the package layer's one-page retry uses this. */
  revisionNotes?: string[]
  onStep?: (info: { attempt: number; detail: string }) => void
}

/**
 * What the gate accepts as a company fact: the name, the domain, the grounded
 * points and FACT claims. Not the summary and not inferences — the summary is
 * the researcher's prose and an inference is a guess, and neither is a
 * source a hiring manager can be pointed to.
 */
export function companyPoolFor(job: Pick<CoverLetterJob, 'company'>, research: CompanyResearchForLetter): string[] {
  return [job.company, research.domain ?? '', ...research.points.map((p) => p.text), ...(research.factClaims ?? [])].filter((s) => s.trim().length > 0)
}

function storyText(bank: EvidenceBank, id: string): string | null {
  const s = bank.stories.find((x) => x.id === id && x.approved)
  if (!s) return null
  return `${s.title}: ${[s.situation, s.task, s.actions, s.result, s.learning].filter(Boolean).join(' → ')}`
}

/**
 * Choose the ≤10 facts and ≤2 stories the writer may argue from. Principle 5:
 * never the whole bank. The matcher's chosen facts come first (it judged
 * them for this job); retrieval-ranked facts fill the remaining slots, those
 * from the matcher's top experiences before the rest.
 */
export function buildLetterInput(params: Omit<CoverLetterParams, 'ctx' | 'deps' | 'onStep'>): CoverLetterInput {
  const { bank, evidenceMap } = params
  const live = (f: EvidenceBank['facts'][number]) => f.approved && f.status !== 'merged'
  const chosen = factsById(bank, evidenceMap.fact_ids).filter(live)
  const seen = new Set(chosen.map((f) => f.id))
  const facts = [...chosen]
  if (facts.length < MAX_LETTER_FACTS) {
    const relevant = getRelevantPersonalEvidence({
      bank,
      target: retrievalTargetForLetterJob(params.job),
      maxExperiences: Math.max(1, bank.experiences.length),
      maxFacts: Math.max(MAX_LETTER_FACTS, bank.facts.length),
    })
    const top = new Set(evidenceMap.top_experience_ids)
    const ranked = relevant.facts.map((r) => r.fact).filter((f) => live(f) && !seen.has(f.id))
    const prefer = (f: EvidenceBank['facts'][number]) => f.experience_id !== null && top.has(f.experience_id)
    for (const f of [...ranked.filter(prefer), ...ranked.filter((f) => !prefer(f))]) {
      if (facts.length >= MAX_LETTER_FACTS) break
      facts.push(f)
      seen.add(f.id)
    }
  }
  const stories = evidenceMap.story_ids
    .map((id) => ({ id, text: storyText(bank, id) }))
    .filter((s): s is { id: string; text: string } => s.text !== null)
    .slice(0, MAX_LETTER_STORIES)

  return {
    job: params.job,
    companyResearch: params.companyResearch,
    evidence: {
      why_i_fit: evidenceMap.why_i_fit,
      facts: facts.slice(0, MAX_LETTER_FACTS).map((f) => ({ id: f.id, text: f.statement })),
      stories,
    },
    user: params.user,
    narrative: NARRATIVE,
    length: params.length ?? DEFAULT_LENGTH,
    ...(params.revisionNotes?.length ? { revisionNotes: params.revisionNotes } : {}),
  }
}

/** greeting + paragraphs + closing + signature. The signature is never an email local-part. */
export function assembleLetter(out: Pick<CoverLetterOutput, 'greeting' | 'paragraphs' | 'closing'>, name: string): string {
  return [out.greeting, ...out.paragraphs, out.closing, printableName(name)].join('\n\n')
}

export async function runCoverLetterPipeline(params: CoverLetterParams): Promise<CoverLetterResult> {
  const writer = params.deps?.writer ?? ((input, ctx) => runCoverLetterWriter(input, ctx))
  // A caller that was handed profiles.name unresolved (an eval fixture, an old
  // signer) still gets the résumé's name here, not "zuyu.alex06".
  const name = printableName(params.user.name, params.bank)
  const base = buildLetterInput({ ...params, user: { name } })
  const pools = {
    companyPool: companyPoolFor(params.job, params.companyResearch),
    personalPool: buildBankPool(params.bank),
    safeNames: [name, params.job.company, params.job.title, params.job.location ?? ''],
    postingPool: [params.job.summary, params.job.postingText ?? ''].filter((s) => s.trim().length > 0),
  }

  const runs: AgentResult<unknown>[] = []
  let input: CoverLetterInput = base
  let last: { out: CoverLetterOutput; grounding: LetterGrounding; version: string } | null = null
  let error: string | null = null

  for (let attempt = 1; attempt <= 2; attempt++) {
    params.onStep?.({ attempt, detail: attempt === 1 ? 'draft' : 'revision after grounding findings' })
    const run = await writer(input, params.ctx)
    runs.push(run as AgentResult<unknown>)
    if (run.status !== 'succeeded' || !run.output) {
      error = `writer ${run.status}: ${run.error ?? 'no output'}`
      // A validator rejection is a draft that missed the band, not a model
      // that broke — the loop's own retry only says "re-read the schema". One
      // more draft with the actual reason as a note; the cover-letter eval
      // lost a letter (Rondo) to exactly this.
      const reason = run.status === 'invalid_output' ? run.error?.match(/\((.+)\)\s*$/)?.[1] : null
      if (attempt === 1 && reason) {
        params.onStep?.({ attempt, detail: `rejected before review: ${reason}` })
        input = { ...base, revisionNotes: [...(base.revisionNotes ?? []), `The previous draft was rejected before review: ${reason}. Fix that and change nothing else.`] }
        continue
      }
      break
    }
    const out = run.output
    // The gate reads the paragraphs only — the greeting names the company and
    // the closing names the applicant, both true by construction.
    const grounding = gateCoverLetter(out.paragraphs.join('\n\n'), pools)
    last = { out, grounding, version: run.trace.prompt_version }
    error = null
    if (grounding.ok) break
    input = { ...base, revisionNotes: [...(base.revisionNotes ?? []), ...revisionNotesFrom(grounding)] }
  }

  const costUsd = Number(runs.reduce((s, r) => s + (r.trace?.cost_usd ?? 0), 0).toFixed(4))
  if (!last) {
    return {
      greeting: null, paragraphs: [], closing: null, claims: [], grounding: null, fullText: null, wordCount: null,
      flagged: true, attempts: runs.length, runs, costUsd, prompt_version: null, error,
    }
  }
  return {
    greeting: last.out.greeting,
    paragraphs: last.out.paragraphs,
    closing: last.out.closing,
    claims: last.out.claims,
    grounding: last.grounding,
    fullText: assembleLetter(last.out, name),
    wordCount: last.out.wordCount,
    flagged: !last.grounding.ok,
    attempts: runs.length,
    runs,
    costUsd,
    prompt_version: last.version,
    error: null,
  }
}
