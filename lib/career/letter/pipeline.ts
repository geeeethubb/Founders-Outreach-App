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
}

export interface CompanyResearchForLetter {
  /** Each id is a research_facts row id; the text is the claim. */
  points: { id: string; text: string }[]
  summary: string
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
  onStep?: (info: { attempt: number; detail: string }) => void
}

function storyText(bank: EvidenceBank, id: string): string | null {
  const s = bank.stories.find((x) => x.id === id && x.approved)
  if (!s) return null
  return `${s.title}: ${[s.situation, s.task, s.actions, s.result, s.learning].filter(Boolean).join(' → ')}`
}

/** Choose the ≤10 facts and ≤2 stories the writer may argue from. Principle 5: never the whole bank. */
export function buildLetterInput(params: Omit<CoverLetterParams, 'ctx' | 'deps' | 'onStep'>): CoverLetterInput {
  const { bank, evidenceMap } = params
  let facts = factsById(bank, evidenceMap.fact_ids).filter((f) => f.approved)
  if (facts.length === 0) {
    // No matcher output: fall back to the top experiences' achievements and
    // metrics so the letter still has something specific to say.
    const top = new Set(evidenceMap.top_experience_ids)
    facts = bank.facts.filter(
      (f) => f.approved && (top.size === 0 || (f.experience_id && top.has(f.experience_id))) &&
        (f.category === 'achievement' || f.category === 'metric' || f.category === 'responsibility')
    )
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
  }
}

export function assembleLetter(out: Pick<CoverLetterOutput, 'greeting' | 'paragraphs' | 'closing'>, name: string): string {
  return [out.greeting, ...out.paragraphs, out.closing, name].join('\n\n')
}

export async function runCoverLetterPipeline(params: CoverLetterParams): Promise<CoverLetterResult> {
  const writer = params.deps?.writer ?? ((input, ctx) => runCoverLetterWriter(input, ctx))
  const base = buildLetterInput(params)
  const pools = {
    companyPool: [params.job.company, params.companyResearch.summary, ...params.companyResearch.points.map((p) => p.text)],
    personalPool: buildBankPool(params.bank),
    safeNames: [params.user.name, params.job.company, params.job.title, params.job.location ?? ''],
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
      break
    }
    const out = run.output
    // The gate reads the paragraphs only — the greeting names the company and
    // the closing names the applicant, both true by construction.
    const grounding = gateCoverLetter(out.paragraphs.join('\n\n'), pools)
    last = { out, grounding, version: run.trace.prompt_version }
    error = null
    if (grounding.ok) break
    input = { ...base, revisionNotes: revisionNotesFrom(grounding) }
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
    fullText: assembleLetter(last.out, params.user.name),
    wordCount: last.out.wordCount,
    flagged: !last.grounding.ok,
    attempts: runs.length,
    runs,
    costUsd,
    prompt_version: last.version,
    error: null,
  }
}
