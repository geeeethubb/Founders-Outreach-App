// Evaluators for positioning and outreach.
//
// Separate from the agents they judge, and framed differently on purpose: the
// positioning agent is asked "what is the best angle?", the judge is asked
// "would this angle survive contact with the recipient?". A judge that shared
// the agent's framing would mostly confirm the agent's taste.
//
// Neither judge can search the web. They evaluate what the pipeline actually
// produced, not a better-informed version of it.

import { anthropicStructured } from '@/lib/providers/anthropic/client'

export const POSITIONING_JUDGE_VERSION = '1.0.0'
export const EMAIL_JUDGE_VERSION = '1.0.0'

export const POSITIONING_DIMENSIONS = [
  'relevance',
  'differentiation',
  'selectivity',
  'specificity',
  'grounding',
  'actionability',
] as const
export type PositioningDimension = (typeof POSITIONING_DIMENSIONS)[number]

export const EMAIL_DIMENSIONS = [
  'relevance',
  'specificity',
  'brevity',
  'personality',
  'credibility',
  'cta_clarity',
  'not_generic',
  'claim_grounding',
] as const
export type EmailDimension = (typeof EMAIL_DIMENSIONS)[number]

export interface DimensionScore {
  dimension: string
  score: number
  reason: string
}

export interface JudgedItem {
  id: string
  scores: DimensionScore[]
  average: number
  worst: { dimension: string; score: number }
  verdict: string
}

function averageOf(scores: DimensionScore[]): number {
  if (scores.length === 0) return 0
  return scores.reduce((s, d) => s + d.score, 0) / scores.length
}

// ─── Positioning ─────────────────────────────────────────────────────────────

export interface PositioningJudgeItem {
  id: string
  recipient: string
  title: string | null
  company: string
  companyContext: string
  personContext: string
  thesis: string
  proofPoints: { id: string; title: string; why: string }[]
  whyMe: string
  whyNow: string
  ask: string
  doNotMention: string[]
  /** Every background item that WAS available — selectivity needs the full menu. */
  availableBackground: { id: string; title: string; summary: string }[]
}

const POSITIONING_RUBRIC = `  RELEVANCE       Did it choose experiences that genuinely matter to THIS recipient, given what
                  is known about their work? 5 = the choice is obviously right for them.
                  1 = the experiences chosen have little to do with what they do.

  DIFFERENTIATION Does the angle make the sender unusually interesting, or merely qualified?
                  5 = "that specific combination is rare and I want to talk to them."
                  1 = "another strong student."

  SELECTIVITY     Did it cut? 5 = one to three tightly chosen items, and the discards are
                  defensible. 1 = it cited everything that looked good, i.e. a résumé.

  SPECIFICITY     Could this thesis be sent to a hundred other people unchanged? Mentally swap
                  in a different recipient at a different company. 5 = the sentence breaks
                  immediately. 1 = it reads fine for almost anyone.

  GROUNDING       Are the claimed experiences real items from the available background list, and
                  are the claims about the recipient consistent with their research?
                  5 = fully grounded. 1 = invented or misattributed.

  ACTIONABILITY   Could a competent writer produce a good email from this brief without asking a
                  follow-up question? 5 = the email almost writes itself. 1 = still vague.`

export async function judgePositioning(
  missionGoal: string,
  items: PositioningJudgeItem[]
): Promise<{ results: JudgedItem[]; costUsd: number; error?: string }> {
  if (items.length === 0) return { results: [], costUsd: 0 }

  const BATCH = 5
  if (items.length > BATCH) {
    const out: JudgedItem[] = []
    const errs: string[] = []
    let cost = 0
    for (let i = 0; i < items.length; i += BATCH) {
      const r = await judgePositioning(missionGoal, items.slice(i, i + BATCH))
      out.push(...r.results)
      cost += r.costUsd
      if (r.error) errs.push(r.error)
    }
    return {
      results: out,
      costUsd: cost,
      ...(out.length < items.length ? { error: `only ${out.length}/${items.length} judged — ${errs.join('; ')}` } : {}),
    }
  }

  const system = `You review outreach positioning briefs — the argument for why a specific sender should be
interesting to a specific recipient — and score each on six dimensions from 1 to 5.

${POSITIONING_RUBRIC}

CALIBRATION

Use the full range. A brief that is competent and unobjectionable is a 3, not a 4. Reserve 5 for
work you would not change. If most of your scores are 4s you are rating politeness, not quality.

The most common real failure is a thesis that sounds tailored but is not: it names the recipient's
company and their field, and is otherwise true of any candidate with a similar CV. Test every
thesis by substitution before scoring SPECIFICITY.

The second most common is over-inclusion — citing four or five experiences because each is
individually impressive. That is a SELECTIVITY failure even when every item is relevant.`

  const list = items
    .map(
      (it, i) => `── BRIEF ${i + 1} (id: ${it.id})
RECIPIENT: ${it.recipient} — ${it.title ?? 'unknown title'} at ${it.company}
About the company: ${it.companyContext.slice(0, 600)}
Known about them: ${it.personContext.slice(0, 900)}

THESIS: ${it.thesis}
WHY ME: ${it.whyMe}
WHY NOW: ${it.whyNow}
ASK: ${it.ask}
PROOF POINTS CHOSEN (${it.proofPoints.length}):
${it.proofPoints.map((p) => `  - [${p.id}] ${p.title} — ${p.why}`).join('\n')}
DELIBERATELY OMITTED: ${it.doNotMention.join('; ') || '(nothing named)'}

BACKGROUND THAT WAS AVAILABLE TO CHOOSE FROM:
${it.availableBackground.map((b) => `  [${b.id}] ${b.title}`).join('\n')}`
    )
    .join('\n\n')

  const res = await anthropicStructured<JudgedItem[]>({
    role: 'reasoning',
    tier: 'standard',
    system,
    messages: [{ role: 'user', content: `MISSION\n${missionGoal}\n\nBRIEFS\n${list}` }],
    maxTokens: 4000,
    schemaName: 'submit_positioning_scores',
    schemaDescription: 'Six dimension scores per brief.',
    schema: {
      properties: {
        judgements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              scores: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    dimension: { type: 'string', enum: POSITIONING_DIMENSIONS },
                    score: { type: 'number', description: '1 to 5.' },
                    reason: { type: 'string' },
                  },
                  required: ['dimension', 'score', 'reason'],
                },
              },
              verdict: { type: 'string', description: 'One sentence: the single biggest weakness.' },
            },
            required: ['id', 'scores', 'verdict'],
          },
        },
      },
      required: ['judgements'],
    },
    validate: (raw) => {
      const r = raw as { judgements?: unknown[] }
      if (!Array.isArray(r?.judgements)) return null
      const valid = new Set(items.map((i) => i.id))
      const out: JudgedItem[] = []
      for (const entry of r.judgements) {
        const j = entry as Record<string, unknown>
        const id = String(j.id ?? '')
        if (!valid.has(id) || !Array.isArray(j.scores)) continue
        const scores: DimensionScore[] = []
        for (const s of j.scores as Record<string, unknown>[]) {
          const dim = String(s.dimension ?? '')
          if (!(POSITIONING_DIMENSIONS as readonly string[]).includes(dim)) continue
          const score = typeof s.score === 'number' ? Math.min(5, Math.max(1, s.score)) : 0
          if (score === 0) continue
          scores.push({ dimension: dim, score, reason: String(s.reason ?? '') })
        }
        // A partial scorecard would quietly change the average's denominator.
        if (scores.length !== POSITIONING_DIMENSIONS.length) continue
        const worst = scores.reduce((a, b) => (b.score < a.score ? b : a))
        out.push({
          id,
          scores,
          average: averageOf(scores),
          worst: { dimension: worst.dimension, score: worst.score },
          verdict: String(j.verdict ?? ''),
        })
      }
      return out.length === items.length ? out : null
    },
    cacheKeyParts: {
      v: POSITIONING_JUDGE_VERSION,
      mission: missionGoal,
      items: items.map((i) => `${i.id}|${i.thesis}|${i.proofPoints.map((p) => p.id).join(',')}`),
    },
    cacheNamespace: 'positioning_judge',
  })

  return { results: res.value ?? [], costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}

// ─── Email ───────────────────────────────────────────────────────────────────

export interface EmailJudgeItem {
  id: string
  recipient: string
  title: string | null
  company: string
  personContext: string
  subject: string
  body: string
  wordCount: number
  /** What the writer was allowed to claim. Grounding is judged against this. */
  allowedClaims: string[]
}

const EMAIL_RUBRIC = `  RELEVANCE        Does the opener show real knowledge of this recipient's work?
  SPECIFICITY      Is it about THEM, or could it be sent to a hundred people unchanged?
  BREVITY          Is every sentence earning its place? Long is a failure even when well written.
  PERSONALITY      Does it sound like a person with a point of view, or like generated prose?
  CREDIBILITY      Does the sender come across as genuinely worth 20 minutes?
  CTA_CLARITY      Is the ask obvious, small, and answerable in one line?
  NOT_GENERIC      5 = no cold-email clichés at all. 1 = "I hope this finds you well",
                   "pick your brain", "reaching out", empty flattery, fake familiarity.
  CLAIM_GROUNDING  Is every factual claim supported by the allowed claims listed?
                   5 = fully supported. 1 = contains an invented detail.`

export async function judgeEmails(
  items: EmailJudgeItem[]
): Promise<{ results: JudgedItem[]; costUsd: number; error?: string }> {
  if (items.length === 0) return { results: [], costUsd: 0 }

  const BATCH = 5
  if (items.length > BATCH) {
    const out: JudgedItem[] = []
    let cost = 0
    const errs: string[] = []
    for (let i = 0; i < items.length; i += BATCH) {
      const r = await judgeEmails(items.slice(i, i + BATCH))
      out.push(...r.results)
      cost += r.costUsd
      if (r.error) errs.push(r.error)
    }
    return {
      results: out,
      costUsd: cost,
      ...(out.length < items.length ? { error: `only ${out.length}/${items.length} judged — ${errs.join('; ')}` } : {}),
    }
  }

  const system = `You are a blunt reader of cold emails. Score each on eight dimensions from 1 to 5.

${EMAIL_RUBRIC}

CALIBRATION

Read each email as the recipient: a busy person who gets several of these a week. The question is
not "is this well written" but "would I reply".

Be hard on genericness. Cold email fails in a specific way — it is polite, competent, and
indistinguishable from every other one. An email with no clichés but no point is still a 2 on
NOT_GENERIC.

Be hard on CLAIM_GROUNDING. Any detail about the recipient or the sender that is not in the
allowed claims is a 1, regardless of how plausible it sounds. An invented detail reaches a real
person under the sender's name and cannot be repaired afterwards.

A 5 on BREVITY means you could not remove a sentence without losing something.`

  const list = items
    .map(
      (it, i) => `── EMAIL ${i + 1} (id: ${it.id})
TO: ${it.recipient} — ${it.title ?? 'unknown'} at ${it.company}
Known about them: ${it.personContext.slice(0, 700)}

SUBJECT: ${it.subject}
BODY (${it.wordCount} words):
${it.body}

CLAIMS THE WRITER WAS ALLOWED TO MAKE:
${it.allowedClaims.map((c) => `  - ${c}`).join('\n')}`
    )
    .join('\n\n')

  const res = await anthropicStructured<JudgedItem[]>({
    role: 'reasoning',
    tier: 'standard',
    system,
    messages: [{ role: 'user', content: `EMAILS\n${list}` }],
    maxTokens: 4000,
    schemaName: 'submit_email_scores',
    schemaDescription: 'Eight dimension scores per email.',
    schema: {
      properties: {
        judgements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              scores: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    dimension: { type: 'string', enum: EMAIL_DIMENSIONS },
                    score: { type: 'number', description: '1 to 5.' },
                    reason: { type: 'string' },
                  },
                  required: ['dimension', 'score', 'reason'],
                },
              },
              verdict: { type: 'string', description: 'One sentence: would you reply, and why not if not.' },
            },
            required: ['id', 'scores', 'verdict'],
          },
        },
      },
      required: ['judgements'],
    },
    validate: (raw) => {
      const r = raw as { judgements?: unknown[] }
      if (!Array.isArray(r?.judgements)) return null
      const valid = new Set(items.map((i) => i.id))
      const out: JudgedItem[] = []
      for (const entry of r.judgements) {
        const j = entry as Record<string, unknown>
        const id = String(j.id ?? '')
        if (!valid.has(id) || !Array.isArray(j.scores)) continue
        const scores: DimensionScore[] = []
        for (const s of j.scores as Record<string, unknown>[]) {
          const dim = String(s.dimension ?? '')
          if (!(EMAIL_DIMENSIONS as readonly string[]).includes(dim)) continue
          const score = typeof s.score === 'number' ? Math.min(5, Math.max(1, s.score)) : 0
          if (score === 0) continue
          scores.push({ dimension: dim, score, reason: String(s.reason ?? '') })
        }
        if (scores.length !== EMAIL_DIMENSIONS.length) continue
        const worst = scores.reduce((a, b) => (b.score < a.score ? b : a))
        out.push({
          id,
          scores,
          average: averageOf(scores),
          worst: { dimension: worst.dimension, score: worst.score },
          verdict: String(j.verdict ?? ''),
        })
      }
      return out.length === items.length ? out : null
    },
    cacheKeyParts: { v: EMAIL_JUDGE_VERSION, items: items.map((i) => `${i.id}|${i.subject}|${i.body}`) },
    cacheNamespace: 'email_judge',
  })

  return { results: res.value ?? [], costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}
