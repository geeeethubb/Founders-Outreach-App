// Cover Letter Writer Agent.
//
// Judgment problem it owns: "say why this company, this person, and growth —
// specifically, briefly, and only with claims that resolve."
//
// Validation here is the schema boundary: paragraph count, length, claim ids
// against the pools the code supplied, at least one company claim, no banned
// phrases. The deterministic grounding gate in lib/career/letter/grounding.ts
// then reads the TEXT, not the claim list — a claim the model forgot to list
// is still a claim.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import type { AgentResult, ToolContext } from '../runtime/types'
import type { CoverLetterClaim } from '@/lib/career/types'
import { BANNED_PHRASES, coverLetterWriterPrompt, type CoverLetterInput } from './prompt'

export type { CoverLetterInput } from './prompt'
export { BANNED_PHRASES, DEFAULT_LENGTH, NARRATIVE } from './prompt'

export interface CoverLetterOutput {
  greeting: string
  paragraphs: string[]
  closing: string
  claims: CoverLetterClaim[]
  wordCount: number
  /** Claims whose id the code never supplied. Stripped, counted. */
  dropped_claims: number
}

export const OUTPUT_SCHEMA = {
  properties: {
    greeting: { type: 'string', description: '"Dear <Company> Hiring Team," unless a name is known.' },
    paragraphs: { type: 'array', minItems: 4, maxItems: 5, items: { type: 'string' } },
    closing: { type: 'string', description: '"Sincerely,"' },
    claims: {
      type: 'array',
      description: 'Every company-specific fact and every personal number/scope claim in the letter, with its source id.',
      items: {
        type: 'object',
        properties: {
          claim_text: { type: 'string' },
          kind: { type: 'string', enum: ['company', 'personal'] },
          research_fact_id: { type: ['string', 'null'], description: 'company claims: the research point id.' },
          evidence_fact_id: { type: ['string', 'null'], description: 'personal claims: the fact id.' },
        },
        required: ['claim_text', 'kind', 'research_fact_id', 'evidence_fact_id'],
      },
    },
  },
  required: ['greeting', 'paragraphs', 'closing', 'claims'],
}

/** Words above length.max the validator still accepts. */
export const MAX_SLACK = 25

export function countWords(text: string): number {
  return (text.match(/[A-Za-z0-9$%][A-Za-z0-9$%+'’.,-]*/g) ?? []).length
}

export function bannedPhrasesIn(text: string): string[] {
  const lower = text.toLowerCase()
  return BANNED_PHRASES.filter((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z])${escaped}(?=$|[^a-z])`).test(lower)
  })
}

/** Exported so the offline test can exercise it. Rejects, never repairs. */
export function validateCoverLetterOutput(raw: unknown, input: CoverLetterInput, reasons?: string[]): CoverLetterOutput | null {
  // The loop's validate() contract is T | null, so the reason a draft was
  // refused would otherwise die here. `reasons` is a sink the runner reads so
  // the pipeline's retry can say what to fix instead of "re-read the schema".
  const reject = (why: string): null => {
    reasons?.push(why)
    return null
  }
  if (!raw || typeof raw !== 'object') return reject('output was not an object')
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.paragraphs)) return reject('paragraphs missing')
  const paragraphs = r.paragraphs
    .map((p) => normalizeModelText(p))
    .filter((p) => p.length > 0)
  if (paragraphs.length < 3 || paragraphs.length > 6) return reject(`${paragraphs.length} paragraphs; 4 or 5 are expected`)

  const words = paragraphs.reduce((n, p) => n + countWords(p), 0)
  // Slack on both sides: the model counts loosely, and a retry over ten words
  // costs more than ten words are worth. The upper slack is 25, not 40: the
  // ceiling exists so the letter fits one page, and 40 words of slack was
  // exactly how a 377-word letter got through and rendered to two.
  if (words < input.length.min - 20 || words > input.length.max + MAX_SLACK) return reject(`${words} words; the band is ${input.length.min}–${input.length.max}`)

  const text = paragraphs.join('\n\n')
  const banned = bannedPhrasesIn(text)
  if (banned.length > 0) return reject(`banned phrase${banned.length > 1 ? 's' : ''} ${banned.map((p) => `"${p}"`).join(', ')}`)

  const researchIds = new Set(input.companyResearch.points.map((p) => p.id))
  const factIds = new Set(input.evidence.facts.map((f) => f.id))
  let dropped = 0
  const claims: CoverLetterClaim[] = []
  for (const c of Array.isArray(r.claims) ? r.claims : []) {
    if (!c || typeof c !== 'object') continue
    const x = c as Record<string, unknown>
    const kind = x.kind === 'company' || x.kind === 'personal' ? x.kind : null
    const claimText = normalizeModelText(x.claim_text)
    if (!kind || !claimText) {
      dropped++
      continue
    }
    if (kind === 'company') {
      const id = typeof x.research_fact_id === 'string' ? x.research_fact_id : null
      if (!id || !researchIds.has(id)) {
        dropped++
        continue
      }
      claims.push({ claim_text: claimText, kind, research_fact_id: id, evidence_fact_id: null })
    } else {
      const id = typeof x.evidence_fact_id === 'string' ? x.evidence_fact_id : null
      if (!id || !factIds.has(id)) {
        dropped++
        continue
      }
      claims.push({ claim_text: claimText, kind, research_fact_id: null, evidence_fact_id: id })
    }
  }
  // A letter with research available that cites none of it is generic by
  // construction, which is the failure the writer exists to avoid.
  if (researchIds.size > 0 && !claims.some((c) => c.kind === 'company')) return reject('no claim of kind "company" cites a research point although points were provided')

  const greeting = normalizeModelText(r.greeting) || `Dear ${input.job.company} Hiring Team,`
  const closing = normalizeModelText(r.closing) || 'Sincerely,'

  return { greeting, paragraphs, closing, claims, wordCount: words, dropped_claims: dropped }
}

export async function runCoverLetterWriter(
  input: CoverLetterInput,
  ctx: ToolContext,
  opts: { onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<CoverLetterOutput>> {
  const reasons: string[] = []
  const res = await runAgent<CoverLetterInput, CoverLetterOutput>({
    agentId: 'cover_letter_writer',
    tier: 'standard',
    modelRole: 'writing',
    prompt: coverLetterWriterPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: (raw) => validateCoverLetterOutput(raw, input, reasons),
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 3000,
    cacheKeyParts: {
      job: [input.job.title, input.job.company, input.job.summary],
      points: input.companyResearch.points.map((p) => `${p.id}:${p.text}`),
      facts: input.evidence.facts.map((f) => `${f.id}:${f.text}`),
      stories: input.evidence.stories.map((s) => s.id),
      why: input.evidence.why_i_fit,
      user: input.user.name,
      length: input.length,
      revision: input.revisionNotes ?? [],
    },
    onStep: opts.onStep,
  })
  // The last rejection is the one that ended the loop; parenthesised so the
  // pipeline can lift it into a revision note.
  const last = reasons[reasons.length - 1]
  return res.status === 'invalid_output' && last ? { ...res, error: `${res.error ?? 'invalid output'} (${last})` } : res
}
