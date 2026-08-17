// Deterministic checks on a reference-written draft.
//
// These run before any judge, and they are the ones with teeth. A model asked
// "does this contain a placeholder?" will usually be right; a regex always is,
// and it costs nothing. Everything mechanically checkable is checked here so the
// judge is only asked things that genuinely need judgment.

import { findPlaceholders } from '@/lib/outreach/placeholders'
import type { ReferenceStyle } from '@/lib/agents/style-analyst'

export interface DraftChecks {
  /** Placeholders that would reach a recipient. Must be zero. */
  placeholders: string[]
  wordCount: number
  targetWords: { min: number; max: number }
  referenceWords: number
  /** Draft length as a fraction of the reference. 1.0 is a perfect match. */
  lengthRatio: number
  /** Under 70% of the reference — the over-compression failure this replaces. */
  overCompressed: boolean
  overLong: boolean
  /** Reference-recipient facts that reappeared in this draft. Must be empty. */
  copiedFromReference: string[]
  /**
   * Phrases reproduced word-for-word from the reference.
   *
   * REPORTED, and only a failure when long. A six-word echo is imitation, which
   * is the job; a nine-word identical fragment is copying. Measured: at a
   * six-word threshold this flagged "I am not looking for a job or a referral" —
   * the defining move of the mentor campaign, which every email in it SHOULD
   * make — and the check would have been marking the feature working as the
   * feature failing.
   */
  verbatimSpans: string[]
  /** Longest reproduced span, in words. Fails at 9 or more. */
  longestVerbatim: number
  arrogance: string[]
  fakeFamiliarity: string[]
  aiTells: string[]
  passed: boolean
}

/** Phrases that read as self-congratulation rather than evidence. */
const ARROGANCE = [
  'i am uniquely', "i'm uniquely", 'i am the only', 'few people can', 'unlike most',
  'i have mastered', 'world-class', 'unparalleled', 'i excel at', 'i am exceptional',
  'my expertise in', 'i am confident that i can transform', 'i would be an asset',
]

/** Claims to a relationship that does not exist. */
const FAKE_FAMILIARITY = [
  'as you know', 'as we discussed', 'following up on our', 'great to connect again',
  'it was great meeting you', 'per our conversation', 'thanks again for', 'as always',
  'i have long admired', "i've been following your work for years",
]

/** The phrasings that make an email read as machine-written. */
const AI_TELLS = [
  'i hope this email finds you well', 'i hope this finds you well', 'i am reaching out',
  "i'm reaching out", 'i came across your profile', 'your impressive background',
  'in today', 'leverage my', 'synergies', 'delve into', 'i wanted to reach out',
  'it is worth noting', 'navigate the complexities', 'testament to',
  'i am passionate about', "i'm passionate about", 'at the intersection of',
]

function found(text: string, needles: string[]): string[] {
  const lower = text.toLowerCase()
  return needles.filter((n) => lower.includes(n))
}

/**
 * Grammar and filler — words that carry no identity.
 *
 * Deliberately generous. Every word left out of this set is a word that can
 * trip a copy check on its own, and a false "plagiarised" verdict on a correct
 * draft is far more damaging here than a missed marginal one: the whole
 * measurement is about whether imitation is being confused with copying.
 */
const GENERIC = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'been',
  'for', 'you', 'your', 'about', 'would', 'could', 'should', 'they', 'their', 'what',
  'which', 'there', 'here', 'when', 'where', 'into', 'onto', 'over', 'under', 'more',
  'most', 'some', 'like', 'just', 'than', 'then', 'them', 'will', 'want', 'know',
  'think', 'people', 'work', 'working', 'team', 'time', 'summer', 'winter', 'thanks',
  'best', 'hi', 'hello', 'every', 'other', 'another', 'really', 'actually', 'still',
  'again', 'first', 'second', 'thing', 'things', 'something', 'anything', 'while',
  'during', 'without', 'through', 'because', 'though', 'although', 'being', 'after',
  'before', 'much', 'many', 'also', 'even', 'only', 'very', 'each', 'both', 'same',
  'said', 'says', 'make', 'made', 'take', 'took', 'come', 'came', 'went', 'gets',
  'part', 'kind', 'sort', 'whether', 'someone', 'anyone', 'everyone', 'around',
])

/** Content words worth checking for a lift. Skips grammar and generic filler. */
function contentTokens(text: string): string[] {
  return Array.from(
    new Set(
      (text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !GENERIC.has(w))
    )
  )
}

/**
 * Vocabulary that is PATTERN, not content.
 *
 * A greeting, a sign-off and a call to action are exactly the things a new email
 * in the same campaign SHOULD reproduce — matching how the writer asks is the
 * job. Flagging "would you have twenty minutes" as plagiarism would mark the
 * feature working as the feature failing.
 */
const PATTERN_VOCAB = new Set([
  'would', 'you', 'have', 'twenty', 'thirty', 'fifteen', 'minutes', 'minute', 'hour',
  'call', 'chat', 'talk', 'coffee', 'happy', 'open', 'free', 'week', 'weeks', 'next',
  'thanks', 'best', 'regards', 'warmly', 'cheers', 'hi', 'hello', 'dear',
  'worth', 'could', 'would', 'any', 'chance', 'schedule', 'time', 'sometime',
])

/**
 * Shared word runs between the draft and the reference.
 *
 * Style imitation reproduces rhythm; copying reproduces sentences. A run counts
 * as copying only when it carries CONTENT — at least one substantial word that
 * is not part of the greeting/ask vocabulary above. Six words rather than five,
 * because five-word overlaps happen honestly between two emails about the same
 * kind of work.
 */
function verbatimRuns(
  draft: string,
  reference: string,
  senderVocab: Set<string>,
  minRun = 6
): { spans: string[]; longest: number } {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  const d = norm(draft)
  const r = norm(reference)
  const refSet = new Set<string>()
  for (let i = 0; i + minRun <= r.length; i++) refSet.add(r.slice(i, i + minRun).join(' '))

  // A run counts only if it carries content that is none of: ordinary grammar,
  // the shared greeting/ask vocabulary, or the sender's own identity.
  const carriesForeignContent = (words: string[]) =>
    words.some((w) => w.length >= 5 && !GENERIC.has(w) && !PATTERN_VOCAB.has(w) && !senderVocab.has(w))

  // Maximal spans, not fixed windows. Overlapping six-word windows report the
  // same overlap five times and make a nine-word lift indistinguishable from a
  // six-word echo — which is the distinction that actually matters.
  const spans: string[] = []
  let longest = 0
  let i = 0
  while (i + minRun <= d.length) {
    if (!refSet.has(d.slice(i, i + minRun).join(' '))) {
      i++
      continue
    }
    let end = i + minRun
    while (end < d.length && refSet.has(d.slice(end - minRun + 1, end + 1).join(' '))) end++
    const words = d.slice(i, end)
    if (carriesForeignContent(words)) {
      spans.push(words.join(' '))
      longest = Math.max(longest, words.length)
    }
    i = end
  }
  return { spans: spans.slice(0, 5), longest }
}

/**
 * A `recipient_specific` entry only counts as transplantable when it names
 * something concrete.
 *
 * The Style Analyst legitimately emits abstract entries — "the unspoken
 * assumption that they work in process-oriented industry". Nothing in that can
 * be copied, but its generic words ("worked", "plant") appear in any email about
 * plants, so the overlap test fired on three correct drafts. A fact you could
 * transplant has a name, a place, or a number in it.
 */
function isConcreteFact(item: string): boolean {
  if (/\d/.test(item)) return true
  const words = item.split(/\s+/)
  // A capitalised word that is not merely the first word of the sentence.
  return words.slice(1).some((w) => /^[A-Z][a-zA-Z&.-]{2,}$/.test(w.replace(/[^A-Za-z&.-]/g, '')))
}

export function checkDraft(params: {
  subject: string
  body: string
  reference: { subject: string | null; body: string }
  style: ReferenceStyle
  /** Names true by construction for THIS recipient — never a copy violation. */
  safeNames: string[]
  /**
   * The SENDER's own vocabulary — their employer, their projects, their club.
   *
   * The reference and every new draft have the same sender, so sender facts
   * recur by necessity: "I help run Founders: Illinois Entrepreneurs at UIUC"
   * appearing in both is the campaign working, not plagiarism. Without this the
   * verbatim check flagged five correct drafts.
   */
  senderVocab?: string[]
  /**
   * True when the sender genuinely has prior history with this recipient.
   *
   * "Following up on our conversation" is only FAKE familiarity when there was
   * no conversation. Sent to someone who replied positively in March it is
   * simply true, and flagging it punishes the system for using the relationship
   * history it was built to use.
   */
  hasPriorRelationship?: boolean
}): DraftChecks {
  const { subject, body, reference, style } = params
  const full = `${subject}\n\n${body}`
  const words = body.trim().split(/\s+/).filter(Boolean).length
  const referenceWords = style.measured.words
  const ratio = referenceWords > 0 ? words / referenceWords : 1

  // ─── template copying ───
  // A recipient-specific item from the reference counts as copied when a
  // distinctive content word from it reappears in the draft. Words that are
  // legitimately about THIS recipient are excluded first, so naming the new
  // company is never a violation.
  const safe = new Set(contentTokens([...params.safeNames, ...(params.senderVocab ?? [])].join(' ')))
  const draftTokens = new Set(contentTokens(body))
  const copied: string[] = []
  for (const item of style.recipient_specific) {
    if (!isConcreteFact(item)) continue
    const distinctive = contentTokens(item).filter((t) => !safe.has(t) && t.length >= 5)
    if (distinctive.length === 0) continue
    const overlap = distinctive.filter((t) => draftTokens.has(t))
    // Two or more distinctive words from one reference-specific fact is a lift,
    // not a coincidence. One can happen honestly — both emails may say
    // "operators" because both are about plants.
    if (overlap.length >= 2) copied.push(`${item} → reused: ${overlap.join(', ')}`)
  }

  const placeholders = findPlaceholders(subject, body)
    .filter((p) => p.severity === 'blocking')
    .map((p) => p.match)

  const overCompressed = ratio < 0.7
  const overLong = ratio > 1.4

  const verbatim = verbatimRuns(
    body,
    reference.body,
    new Set(contentTokens((params.senderVocab ?? []).join(' ')))
  )

  const checks: DraftChecks = {
    placeholders,
    wordCount: words,
    targetWords: style.target_words,
    referenceWords,
    lengthRatio: Number(ratio.toFixed(2)),
    overCompressed,
    overLong,
    copiedFromReference: copied,
    verbatimSpans: verbatim.spans,
    longestVerbatim: verbatim.longest,
    arrogance: found(full, ARROGANCE),
    fakeFamiliarity: params.hasPriorRelationship ? [] : found(full, FAKE_FAMILIARITY),
    // A tell the reference itself uses is not a tell — the reference wins.
    aiTells: found(full, AI_TELLS).filter((t) => !reference.body.toLowerCase().includes(t)),
    passed: false,
  }

  checks.passed =
    checks.placeholders.length === 0 &&
    checks.copiedFromReference.length === 0 &&
    checks.longestVerbatim < 9 &&
    !checks.overCompressed &&
    !checks.overLong &&
    checks.arrogance.length === 0 &&
    checks.fakeFamiliarity.length === 0 &&
    checks.aiTells.length === 0

  return checks
}
