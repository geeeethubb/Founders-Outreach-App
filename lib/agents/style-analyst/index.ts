// Style Analyst Agent — TIER 1 (cheap), no web search, one call per campaign.
//
// Judgment problem it owns: "what makes this email sound like this person?"
//
// Nothing else owns it. The Outreach Agent writes; Positioning decides the
// argument; Conversation reads replies. None of them can look at a real email
// the user actually sent and extract a reproducible voice from it.
//
// WHY THIS IS A SEPARATE STEP RATHER THAN "PASTE THE REFERENCE INTO THE WRITER"
//
// Three reasons, in order of how much they matter:
//
//   1. It is answerable. "What did the system learn from my reference email?"
//      has a stored answer the founder can read and correct. Pasting the
//      reference into the writer makes that unanswerable forever.
//   2. It separates STYLE from CONTENT explicitly — in particular the
//      `recipient_specific` list, which names the facts belonging to the
//      reference's recipient so the writer can be told not to reuse them. That
//      is the difference between imitating a voice and copying a template.
//   3. It is paid for once per campaign, not once per prospect.
//
// Numbers are measured in code (ADR-004): the model describes qualities, the
// arithmetic of length and pacing is not its job.

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import { styleAnalystPrompt, type StyleAnalystInput } from './prompt'

export { styleAnalystPrompt }
export type { StyleAnalystInput }

export interface ReferenceStyle {
  register: string
  directness: string
  context_depth: string
  credential_style: string
  cta_style: string
  sentence_style: string
  greeting: string
  signoff: string
  structure: string[]
  distinctive_moves: string[]
  avoid: string[]
  recipient_specific: string[]
  summary: string
  /** Measured deterministically from the reference, never by the model. */
  measured: { words: number; paragraphs: number; sentences: number; avgSentenceWords: number }
  /** The length band a new email should land in. Computed from `measured`. */
  target_words: { min: number; max: number }
}

const OUTPUT_SCHEMA = {
  properties: {
    register: { type: 'string' },
    directness: { type: 'string' },
    context_depth: { type: 'string' },
    credential_style: { type: 'string' },
    cta_style: { type: 'string' },
    sentence_style: { type: 'string' },
    greeting: { type: 'string', description: 'The literal greeting pattern, e.g. "Hi <first name>," on its own line.' },
    signoff: { type: 'string', description: 'The literal sign-off pattern.' },
    structure: {
      type: 'array',
      items: { type: 'string' },
      description: 'The ordered beats of the email, one short phrase each.',
    },
    distinctive_moves: {
      type: 'array',
      items: { type: 'string' },
      description: '2-5 things that make this sound like a person rather than a template.',
    },
    avoid: { type: 'array', items: { type: 'string' }, description: 'What this writer conspicuously does not do.' },
    recipient_specific: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every fact true only of the reference email\'s own recipient. Must not be reused.',
    },
    summary: { type: 'string', description: 'Two sentences a writer could read and immediately match the voice.' },
  },
  required: [
    'register', 'directness', 'context_depth', 'credential_style', 'cta_style', 'sentence_style',
    'greeting', 'signoff', 'structure', 'distinctive_moves', 'avoid', 'recipient_specific', 'summary',
  ],
}

export function measureEmail(body: string): ReferenceStyle['measured'] {
  const text = body.trim()
  const words = text.split(/\s+/).filter(Boolean).length
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length
  const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) ?? []).length)
  return {
    words,
    paragraphs: Math.max(1, paragraphs),
    sentences,
    avgSentenceWords: Math.round(words / sentences),
  }
}

/**
 * The length band a generated email should land in.
 *
 * ±25% of the reference, floored at 40 words. Deliberately NOT the old fixed
 * 60–120: that band is what produced the over-compression the reference system
 * exists to fix. If the user's real email is 210 words, 210 words is correct.
 */
export function targetWordsFor(measured: ReferenceStyle['measured']): { min: number; max: number } {
  const w = Math.max(40, measured.words)
  return { min: Math.max(35, Math.round(w * 0.75)), max: Math.round(w * 1.25) }
}

function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max)
}

export async function runStyleAnalyst(
  input: StyleAnalystInput,
  ctx: ToolContext
): Promise<AgentResult<ReferenceStyle>> {
  const validate = (raw: unknown): ReferenceStyle | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    const str = (k: string) => String(r[k] ?? '').trim()

    // Structure is what a new email is built on. Without it the analysis is a
    // pile of adjectives, which is exactly what this replaces.
    const structure = strList(r.structure, 8)
    if (!str('register') || structure.length === 0) return null

    return {
      register: str('register'),
      directness: str('directness'),
      context_depth: str('context_depth'),
      credential_style: str('credential_style'),
      cta_style: str('cta_style'),
      sentence_style: str('sentence_style'),
      greeting: str('greeting'),
      signoff: str('signoff'),
      structure,
      distinctive_moves: strList(r.distinctive_moves, 6),
      avoid: strList(r.avoid, 8),
      recipient_specific: strList(r.recipient_specific, 12),
      summary: str('summary'),
      measured: input.measured,
      target_words: targetWordsFor(input.measured),
    }
  }

  return runAgent<StyleAnalystInput, ReferenceStyle>({
    agentId: 'style_analyst',
    tier: 'cheap',
    modelRole: 'fast',
    prompt: styleAnalystPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 2500,
    // Keyed on the reference itself: change the email, get a new analysis;
    // change nothing, pay nothing.
    cacheKeyParts: {
      subject: input.reference.subject ?? '',
      body: input.reference.body,
      audience: input.targetAudience ?? '',
      notes: input.notes ?? '',
    },
  })
}

/** The style, rendered for the writer's prompt. */
export function renderStyle(style: ReferenceStyle): string {
  const lines = [
    `VOICE: ${style.register}`,
    `DIRECTNESS: ${style.directness}`,
    `HOW MUCH CONTEXT BEFORE THE POINT: ${style.context_depth}`,
    `HOW CREDENTIALS APPEAR: ${style.credential_style}`,
    `THE ASK: ${style.cta_style}`,
    `SENTENCES: ${style.sentence_style}`,
    `GREETING: ${style.greeting}`,
    `SIGN-OFF: ${style.signoff}`,
    `LENGTH: the reference is ${style.measured.words} words in ${style.measured.paragraphs} paragraph(s). Land between ${style.target_words.min} and ${style.target_words.max} words.`,
    `STRUCTURE — the beats, in order:\n${style.structure.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
  ]
  if (style.distinctive_moves.length) {
    lines.push(`WHAT MAKES IT SOUND LIKE THEM:\n${style.distinctive_moves.map((s) => `  • ${s}`).join('\n')}`)
  }
  if (style.avoid.length) {
    lines.push(`THIS WRITER NEVER:\n${style.avoid.map((s) => `  • ${s}`).join('\n')}`)
  }
  return lines.join('\n')
}
