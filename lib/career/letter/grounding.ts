// The cover-letter grounding gate. Deterministic; reads the TEXT.
//
// The writer lists its claims with ids, and validate() checks those ids. But
// a claim the model forgot to list is still a claim, so this gate ignores the
// list entirely and scans the letter the way lib/outreach/grounding.ts scans
// an email: every number, proper noun, acronym and hard superlative must
// appear in the company research or in the Evidence Bank, and a placeholder
// is proof nobody read it.
//
// Two pools, one scan. Company facts and personal facts are checked against
// the union: separating them would require deciding, per number, whether the
// sentence is about the company or the applicant, and that decision is a
// judgment call this gate is not allowed to make. A figure grounded by either
// pool is on record somewhere the human can look.
//
// Warnings, never blocking: banned filler phrases (the letter is bad, not
// false) and résumé repetition (a paragraph that re-reads the bullets).

import { checkGrounding } from '@/lib/outreach/grounding'
import { stripMarkdown } from '../documents/docx-read'
import { bannedPhrasesIn } from '@/lib/agents/cover-letter-writer'
import type { EvidencePool } from '../evidence/render'

export type LetterFindingKind =
  | 'quantity' | 'entity' | 'superlative' | 'placeholder' | 'responsibility' | 'banned_phrase' | 'repetition'

export interface LetterFinding {
  kind: LetterFindingKind
  span: string
  reason: string
  /** The sentence or paragraph it appeared in. */
  context: string
}

export interface LetterGrounding {
  ok: boolean
  blocking: LetterFinding[]
  warnings: LetterFinding[]
  stats: { quantitiesChecked: number; entitiesChecked: number; companyPoolLines: number; personalPoolLines: number }
}

export interface LetterPools {
  /** Research fact claims + company name + the research points. */
  companyPool: string[]
  /** buildBankPool(bank). */
  personalPool: EvidencePool
  /** True by construction: the applicant's name, the company, the role title. */
  safeNames?: string[]
  /**
   * The posting's own text. A term the hiring manager wrote into the job
   * description ("GD&T", "Platform 2") is theirs to be echoed back; the
   * cover-letter eval saw a letter blocked for naming a skill the posting
   * itself asked for. Kept apart from companyPool, which stays FACT-only.
   */
  postingPool?: string[]
}

/** Share of a paragraph's 6-word shingles found in the bullets above which it is narration. */
export const REPETITION_THRESHOLD = 0.4
const SHINGLE = 6

function normWords(s: string): string[] {
  return stripMarkdown(s).toLowerCase().match(/[a-z0-9$%+'’-]+/g) ?? []
}

function shingles(words: string[], n = SHINGLE): string[] {
  const out: string[] = []
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '))
  return out
}

/** How much of each paragraph is lifted from the pool, verbatim in six-word runs. */
export function repetitionScore(paragraph: string, poolLines: string[]): number {
  const mine = shingles(normWords(paragraph))
  if (mine.length === 0) return 0
  const theirs = new Set(poolLines.flatMap((l) => shingles(normWords(l))))
  const hits = mine.filter((s) => theirs.has(s)).length
  return hits / mine.length
}

export function gateCoverLetter(text: string, pools: LetterPools): LetterGrounding {
  const evidence = [...pools.companyPool, ...(pools.postingPool ?? []), ...pools.personalPool.lines]
  const shared = checkGrounding({ subject: '', body: text, evidence, safeNames: pools.safeNames ?? [] })

  const blocking: LetterFinding[] = []
  const warnings: LetterFinding[] = []
  for (const f of shared.findings) {
    // Responsibility patterns are about a recipient ("you lead X"); a letter
    // addressed to a hiring team almost never trips them, and when it does the
    // human should see it — as a warning.
    const finding: LetterFinding = { kind: f.kind, span: f.claim, reason: f.reason, context: f.sentence }
    if (f.kind === 'responsibility') warnings.push(finding)
    else if (f.severity === 'blocking') blocking.push(finding)
    else warnings.push(finding)
  }

  for (const phrase of bannedPhrasesIn(text)) {
    warnings.push({
      kind: 'banned_phrase',
      span: phrase,
      reason: `"${phrase}" is filler no one writes by hand; say the specific thing instead.`,
      context: text.split(/\n+/).find((p) => p.toLowerCase().includes(phrase)) ?? '',
    })
  }

  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  paragraphs.forEach((p, i) => {
    const score = repetitionScore(p, pools.personalPool.lines)
    if (score >= REPETITION_THRESHOLD) {
      warnings.push({
        kind: 'repetition',
        span: `paragraph ${i + 1}`,
        reason: `${Math.round(score * 100)}% of this paragraph repeats the résumé word for word. A letter that narrates the bullets adds nothing to them.`,
        context: p.slice(0, 160),
      })
    }
  })

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    stats: {
      quantitiesChecked: shared.stats.quantitiesChecked,
      entitiesChecked: shared.stats.entitiesChecked,
      companyPoolLines: pools.companyPool.length,
      personalPoolLines: pools.personalPool.lines.length,
    },
  }
}

/** The findings as revision notes for the writer's one retry. */
export function revisionNotesFrom(g: LetterGrounding): string[] {
  return g.blocking.map((f) => `${f.kind}: "${f.span}" — ${f.reason}`)
}
