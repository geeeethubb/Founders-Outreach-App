// LLM judge for reference-written emails.
//
// DELIBERATELY NOT "is this a good cold email?"
//
// That question has a house answer, and the house answer is exactly what this
// milestone removes: a generic ideal that compresses everything to 90 punchy
// words and calls the result high-signal. The judge here is given the user's own
// email and asked whether the new one belongs beside it.
//
// It never sees which mode produced a draft. The control (house style, no
// reference) and the treatment (reference mode) are judged blind and in the same
// batch, because a judge that knows which is which will find what it expects.

import { anthropicStructured } from '@/lib/providers/anthropic/client'

export const REFERENCE_JUDGE_VERSION = '1.0.0'

export interface ReferenceJudgement {
  draft_id: string
  reference_similarity: number
  recipient_relevance: number
  fact_grounding: number
  naturalness: number
  cta_fit: number
  template_avoidance: number
  overall: number
  same_writer: boolean
  strongest: string
  weakest: string
}

const CRITERIA = `  reference_similarity   Does this read as though the SAME PERSON wrote it, in the same campaign,
                         to a different recipient? Judge length, pacing, warmth, directness, how
                         much context comes before the point, how credentials appear, and how the
                         ask is made. A draft that is noticeably shorter, cooler or punchier than
                         the reference scores low here even if it is a fine email on its own.

  recipient_relevance    Is it genuinely adapted to THIS recipient, or would it work equally well
                         sent to a hundred others?

  fact_grounding         Is every claim about the recipient supported by the research shown? A
                         confident specific that appears nowhere in the research is the worst
                         failure available and should sink this score to 1.

  naturalness            Does it read as written by a person? Penalise machine cadence, stacked
                         subordinate clauses, "at the intersection of", and any sentence whose
                         removal would not change the meaning.

  cta_fit                Does the ask make sense for this recipient, and does it match the SHAPE
                         of the ask in the reference — its softness, its position, whether it
                         offers an out?

  template_avoidance     Did it avoid transplanting details that belong to the reference email's
                         OWN recipient? Reusing the reference's company, project or numbers is a
                         1. Reproducing only its structure and voice is a 5.`

export interface JudgeDraftInput {
  draft_id: string
  reference: { subject: string | null; body: string }
  recipient: { name: string; title: string; company: string }
  research: string
  draft: { subject: string; body: string }
}

export async function judgeReferenceDrafts(
  drafts: JudgeDraftInput[]
): Promise<{ results: ReferenceJudgement[]; costUsd: number; error?: string }> {
  if (drafts.length === 0) return { results: [], costUsd: 0 }

  const BATCH = 4
  if (drafts.length > BATCH) {
    const results: ReferenceJudgement[] = []
    const errors: string[] = []
    let costUsd = 0
    for (let i = 0; i < drafts.length; i += BATCH) {
      const r = await judgeReferenceDrafts(drafts.slice(i, i + BATCH))
      results.push(...r.results)
      costUsd += r.costUsd
      if (r.error) errors.push(r.error)
    }
    return {
      results,
      costUsd,
      ...(results.length < drafts.length
        ? { error: `${results.length}/${drafts.length} judged — ${errors.join('; ') || 'unknown'}` }
        : {}),
    }
  }

  const system = `You compare emails against a writer's own example.

For each item you are shown a REFERENCE EMAIL that a person actually wrote and sent, and a NEW
DRAFT written for a different recipient in the same campaign. Your job is to say how well the new
draft belongs beside the reference.

You are NOT judging the reference. It is the standard. If it is long and warm, then long and warm
is correct, and a shorter sharper draft is WORSE, not better. If it stacks two asks, a draft with
one crisp ask has failed to match it. Do not apply your own idea of what a good cold email looks
like — that is precisely the failure being measured.

Score each criterion 1 to 5.

${CRITERIA}

  overall                Your holistic view: would this writer send this draft as-is?

  same_writer            true only if a reader shown both, cold, would believe one person wrote
                         them. This is a higher bar than "similar tone".

CALIBRATION

  5  Indistinguishable in voice; adapted specifically to the recipient; nothing unsupported.
  4  Clearly the same writer, one small slip.
  3  Related but noticeably off on one dimension — usually length or warmth.
  2  A competent email in a different voice.
  1  A different writer entirely, or an unsupported claim about the recipient.

Be strict on reference_similarity. Most drafts that fail do so by being shorter, cooler and more
clipped than the reference while remaining perfectly good emails, and calling that a 4 hides the
one thing this measurement exists to catch.

strongest and weakest: one short phrase each.`

  const list = drafts
    .map(
      (d, i) => `── ITEM ${i + 1} (id: ${d.draft_id})

REFERENCE EMAIL the writer actually sent:
${d.reference.subject ? `Subject: ${d.reference.subject}` : '(no subject)'}
${d.reference.body}

NEW RECIPIENT: ${d.recipient.name}, ${d.recipient.title} at ${d.recipient.company}

RESEARCH AVAILABLE ABOUT THE NEW RECIPIENT (nothing outside this may be asserted):
${d.research}

NEW DRAFT:
Subject: ${d.draft.subject}
${d.draft.body}`
    )
    .join('\n\n')

  const res = await anthropicStructured<ReferenceJudgement[]>({
    role: 'reasoning',
    system,
    messages: [{ role: 'user', content: `${list}\n\nScore every item, by id.` }],
    maxTokens: 4000,
    schemaName: 'submit_reference_judgements',
    schemaDescription: 'One judgement per item.',
    schema: {
      properties: {
        judgements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              draft_id: { type: 'string' },
              reference_similarity: { type: 'number' },
              recipient_relevance: { type: 'number' },
              fact_grounding: { type: 'number' },
              naturalness: { type: 'number' },
              cta_fit: { type: 'number' },
              template_avoidance: { type: 'number' },
              overall: { type: 'number' },
              same_writer: { type: 'boolean' },
              strongest: { type: 'string' },
              weakest: { type: 'string' },
            },
            required: [
              'draft_id', 'reference_similarity', 'recipient_relevance', 'fact_grounding',
              'naturalness', 'cta_fit', 'template_avoidance', 'overall', 'same_writer',
              'strongest', 'weakest',
            ],
          },
        },
      },
      required: ['judgements'],
    },
    validate: (raw) => {
      const r = raw as { judgements?: unknown[] }
      if (!Array.isArray(r?.judgements)) return null
      const valid = new Set(drafts.map((d) => d.draft_id))
      const clamp = (v: unknown) => Math.min(5, Math.max(1, typeof v === 'number' && Number.isFinite(v) ? v : 1))
      const out: ReferenceJudgement[] = []
      for (const entry of r.judgements) {
        const j = entry as Record<string, unknown>
        const id = String(j.draft_id ?? '')
        if (!valid.has(id)) continue
        out.push({
          draft_id: id,
          reference_similarity: clamp(j.reference_similarity),
          recipient_relevance: clamp(j.recipient_relevance),
          fact_grounding: clamp(j.fact_grounding),
          naturalness: clamp(j.naturalness),
          cta_fit: clamp(j.cta_fit),
          template_avoidance: clamp(j.template_avoidance),
          overall: clamp(j.overall),
          same_writer: j.same_writer === true,
          strongest: String(j.strongest ?? ''),
          weakest: String(j.weakest ?? ''),
        })
      }
      const covered = new Set(out.map((o) => o.draft_id))
      return drafts.every((d) => covered.has(d.draft_id)) ? out : null
    },
    cacheKeyParts: {
      v: REFERENCE_JUDGE_VERSION,
      drafts: drafts.map((d) => `${d.draft_id}|${d.reference.body}|${d.draft.subject}|${d.draft.body}`),
    },
    cacheNamespace: 'reference_judge',
  })

  return { results: res.value ?? [], costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}
