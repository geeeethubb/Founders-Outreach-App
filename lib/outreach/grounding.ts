// The claim-safety gate.
//
// Deterministic. No model is asked whether the email "looks grounded" — that is
// the failure mode this exists to prevent. ADR-006 / ADR-011: fight fabrication
// with structure, not exhortation.
//
// The gate runs on the text that will ACTUALLY be sent (the user's edit if there
// is one), at approval and again at send. Editing is exactly how an unsupported
// claim gets back into a draft that already passed.
//
// WHAT IS BLOCKING vs WHAT WARNS
//
// Blocking findings are hard — they stop approve and stop send, with no
// override. So the blocking set is restricted to categories where a false
// positive is rare and a false negative is a lie in the recipient's inbox:
//
//   quantity      dollar amounts, percentages, multipliers, rankings, and any
//                 counted claim (>= 10, or carrying a k/M/B scale)
//   entity        acronyms and proper nouns — the shape a company initiative,
//                 programme or system name takes
//   superlative   "largest", "flagship", "first-of-its-kind"
//   responsibility "you lead X", "your team owns Y"
//
// Warnings are the genuinely ambiguous cases ("most", "best", a bare capitalised
// word that may be prose). They are surfaced and never block, because a gate
// that blocks good drafts gets switched off, and then it protects nothing.

export type FindingKind = 'quantity' | 'entity' | 'superlative' | 'responsibility'

export interface GroundingFinding {
  severity: 'blocking' | 'warning'
  kind: FindingKind
  /** The exact span that could not be grounded. */
  claim: string
  /** The sentence it appeared in, so the user can see it in context. */
  sentence: string
  reason: string
  /** A concrete, grounded alternative — never just "fix this". */
  revision: string
}

export interface GroundingResult {
  ok: boolean
  findings: GroundingFinding[]
  blocking: GroundingFinding[]
  warnings: GroundingFinding[]
  stats: {
    evidenceItems: number
    quantitiesChecked: number
    entitiesChecked: number
  }
}

export interface GroundingInput {
  subject: string
  /** The final body — pass the user's edit when there is one. */
  body: string
  /**
   * The evidence pool. Same strings handed to the writer as VERIFIED FACTS:
   * `SENDER: ...` for the user's background, `RECIPIENT: ...` / `THEIR COMPANY:`
   * for stored research. Prefixes are ignored here; the text is what matters.
   */
  evidence: string[]
  /**
   * Names that are true by construction — the recipient, their company, the
   * sender, the mission timeframe. Checking these against research would block
   * every email for naming the person it is addressed to.
   */
  safeNames?: string[]
}

// ─── Quantities ──────────────────────────────────────────────────────────────

type QuantityKind = 'money' | 'percent' | 'multiplier' | 'ordinal' | 'count'

interface Quantity {
  raw: string
  kind: QuantityKind
  value: number
  index: number
}

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
}

/** Units that make a number scheduling, not a claim. "20 minutes" is the CTA. */
const SCHEDULING_UNITS = new Set([
  'minute', 'minutes', 'min', 'mins', 'hour', 'hours', 'hr', 'hrs',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'am', 'pm',
])

function num(s: string): number {
  return Number(s.replace(/,/g, ''))
}

function scaled(digits: string, suffix: string | undefined): number {
  const base = num(digits)
  if (!suffix) return base
  return base * (SCALE[suffix.toLowerCase()] ?? 1)
}

/**
 * Pull claim-bearing quantities out of text.
 *
 * Deliberately NOT every integer. Small bare counts ("one or two things", "3
 * proof points") and calendar years are ordinary prose; blocking on them would
 * make the gate unusable, and neither is the category that misleads a reader.
 */
/** "at 10", "10:30", "2pm", "9 a.m." — times a meeting is proposed for. */
function isClockTime(text: string, index: number, digits: string, value: number): boolean {
  if (value > 24 || digits.includes(',') || digits.includes('.')) return false
  const after = text.slice(index + digits.length, index + digits.length + 6).toLowerCase()
  if (/^\s*:\s*\d{2}/.test(after)) return true
  if (/^\s*(am|pm|a\.m|p\.m|o'clock)/.test(after)) return true
  const before = text.slice(Math.max(0, index - 4), index).toLowerCase()
  return /\bat\s$/.test(before)
}

export function extractQuantities(text: string): Quantity[] {
  const found: Quantity[] = []
  // Spans already consumed, so "$3M" is one money claim rather than also a count.
  const taken: Array<[number, number]> = []
  const free = (start: number, end: number) => !taken.some(([s, e]) => start < e && end > s)
  const take = (start: number, end: number) => taken.push([start, end])

  const push = (m: RegExpExecArray, kind: QuantityKind, value: number, raw = m[0]) => {
    if (!free(m.index, m.index + m[0].length)) return
    take(m.index, m.index + m[0].length)
    if (!Number.isFinite(value)) return
    found.push({ raw: raw.trim(), kind, value, index: m.index })
  }

  let m: RegExpExecArray | null

  // 1. Money — always a claim.
  const money = /(?:US\$|USD\s*|\$)\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|b|bn|thousand|million|billion)?\+?/gi
  while ((m = money.exec(text))) push(m, 'money', scaled(m[1], m[2]))

  // 2. Percentages — the most abusable figure in a cold email.
  const percent = /(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent|per cent)/gi
  while ((m = percent.exec(text))) push(m, 'percent', num(m[1]))

  // 3. Multipliers: "3x", "10-fold".
  const mult = /\b(\d[\d,]*(?:\.\d+)?)\s*(?:x\b|-fold\b)/gi
  while ((m = mult.exec(text))) push(m, 'multiplier', num(m[1]))

  // 4. Rankings.
  const ordinal = /(?:#\s?(\d+)|\btop[-\s](\d+)\b|\bno\.?\s?(\d+)\b|\branked\s+(\d+)\b)/gi
  while ((m = ordinal.exec(text))) push(m, 'ordinal', num(m[1] ?? m[2] ?? m[3] ?? m[4]))

  // 5. Scaled counts: "73k CPU-hours", "2.4 million tonnes".
  const scaledCount = /\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|b|bn|thousand|million|billion)\b/gi
  while ((m = scaledCount.exec(text))) push(m, 'count', scaled(m[1], m[2]))

  // 6. Plain counts. A number is a claim when it is >= 10 and is not a calendar
  //    year and not a scheduling duration.
  // The unit may be hyphenated ("a 15-minute call") — matching only whitespace
  // let every compound duration through as a fabricated quantity.
  const plain = /\b(\d[\d,]*(?:\.\d+)?)\b(?:\s*[-–]\s*\d{2,4})?([-\s]+[A-Za-z][A-Za-z-]*)?/g
  while ((m = plain.exec(text))) {
    const value = num(m[1])
    if (!Number.isFinite(value) || value < 10) continue
    // Clock times. Proposing "Thursday at 10" is scheduling, not a claim, and
    // treating it as one flagged every meeting-booking reply.
    if (isClockTime(text, m.index, m[1], value)) continue
    // Calendar years and year ranges ("2026", "2026-27") come from the mission,
    // not from research.
    if (/^\d{4}$/.test(m[1].replace(/,/g, '')) && value >= 1900 && value <= 2100) continue
    const unit = (m[2] ?? '').trim().toLowerCase().replace(/^[-\s]+/, '').replace(/[^a-z-]/g, '')
    if (unit && SCHEDULING_UNITS.has(unit.replace(/-.*$/, ''))) continue
    push(m, 'count', value, m[1])
  }

  return found.sort((a, b) => a.index - b.index)
}

function quantityGrounded(q: Quantity, evidence: Quantity[]): boolean {
  return evidence.some((e) => {
    if (e.value !== q.value) return false
    // A percentage must come from a percentage. "40%" borrowed from "40 people"
    // is a different claim wearing the same digits.
    if (q.kind === 'percent' || e.kind === 'percent') return q.kind === e.kind
    return true
  })
}

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * Acronyms and technology names generic enough that using one asserts nothing
 * about the recipient. Anything company-specific is deliberately absent.
 */
const ACRONYM_STOPLIST = new Set([
  'I', 'A', 'AI', 'ML', 'US', 'USA', 'UK', 'EU', 'UN', 'NA',
  'CEO', 'CTO', 'COO', 'CFO', 'CIO', 'CDO', 'CSO', 'VP', 'SVP', 'EVP', 'GM',
  'PHD', 'MS', 'BS', 'BA', 'MBA', 'MSC', 'BSC', 'MENG', 'BENG',
  'HR', 'IT', 'PM', 'QA', 'QC', 'RD', 'R&D', 'API', 'APIS', 'SAAS', 'B2B', 'B2C',
  'OK', 'PS', 'FYI', 'ASAP', 'NDA', 'CV', 'ID', 'URL', 'PDF', 'HTML', 'CSS', 'SQL',
  'AWS', 'GCP', 'IOT', 'EV', 'EVS', 'CPU', 'GPU', 'HPC', 'LLM', 'LLMS',
  'ROI', 'KPI', 'KPIS', 'ESG', 'CAPEX', 'OPEX', 'SME', 'SMES', 'OEM', 'OEMS',
  'EHS', 'PPE', 'GMP', 'SOP', 'ERP', 'MES', 'PLC', 'SCADA', 'CFD', 'FEA',
])

/**
 * Words that get capitalised for grammar rather than because they name
 * something. A capitalised token here is prose, not a claim.
 */
const COMMON_CAPITALISED = new Set(
  (
    'I Im Ive Id Ill A An The This That These Those There Here It Its We Our Us You Your Yours ' +
    'My Mine He She They Them Their His Her If When While Since Because Although Though After ' +
    'Before Both And But So Then Also However Given Having Both Each Every Most Many Much Few ' +
    'Some Any All None Now Today Tomorrow Yesterday Recently Currently What How Why Where Who ' +
    'Would Could Should Will Can May Might Must Let Lets Please Thanks Thank Best Regards Sincerely ' +
    'Hi Hello Dear Yes No Maybe Happy Glad Worth Either Neither One Two Three Four Five Six Seven ' +
    'Eight Nine Ten First Second Third Last Next Over Under For From With Without Across Between ' +
    'January February March April May June July August September October November December ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
    'Winter Spring Summer Autumn Fall Q1 Q2 Q3 Q4 ' +
    // Reply and forward markers. "Re" reads as an acronym and flagged every
    // suggested response the Conversation Agent produced.
    'Re RE Fwd FW Subject Sent To From Cc'
  )
    .split(/\s+/)
    .map((w) => w.toUpperCase())
)

const CONNECTORS = new Set(['of', 'for', 'and', 'the', 'de', 'van', 'von', '&', 'at', 'in', 'on'])

/**
 * Strip what English grammar adds and the claim does not: possessives and a
 * trailing abbreviation dot. "P&G's" and "IT." are the same claims as "P&G"
 * and "IT" — treating them as different names blocked five real drafts.
 */
function baseForm(token: string): string {
  return token.replace(/['’]s$/i, '').replace(/\.$/, '')
}

/** "I've" and "That's" are prose; compare on the word before the apostrophe. */
function isProse(token: string): boolean {
  const bare = token.toUpperCase().replace(/['’].*$/, '')
  if (COMMON_CAPITALISED.has(bare)) return true
  // "AI-flagged", "AI-in-manufacturing": a generic acronym plus lowercase prose
  // is a description, not the name of anything.
  if (token.includes('-')) {
    const parts = token.split('-')
    if (ACRONYM_STOPLIST.has(parts[0].toUpperCase()) && parts.slice(1).every((p) => /^[a-z]/.test(p))) {
      return true
    }
  }
  return false
}

interface Entity {
  raw: string
  tokens: string[]
  sentence: string
  /** Multi-token runs and acronyms are strong signals; a lone word is weaker. */
  strong: boolean
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function stripPunct(t: string): string {
  return t.replace(/^[^A-Za-z0-9&#$]+|[^A-Za-z0-9&.]+$/g, '')
}

function isCapitalised(t: string): boolean {
  return /^[A-Z][A-Za-z0-9'’&.-]*$/.test(t)
}

function isAcronym(t: string): boolean {
  const b = baseForm(t)
  return /^[A-Z][A-Z0-9&.\-/]{1,7}$/.test(b) && /[A-Z]{2}/.test(b)
}

/** Proper nouns and acronyms — the shape an invented initiative takes. */
export function extractEntities(text: string): Entity[] {
  const out: Entity[] = []

  for (const sentence of splitSentences(text)) {
    const rawTokens = sentence.split(/\s+/)
    let i = 0
    let firstRun = true

    while (i < rawTokens.length) {
      const tok = stripPunct(rawTokens[i])
      if (!tok || !isCapitalised(tok)) {
        i++
        continue
      }

      // Grow a run across capitalised tokens, allowing lowercase connectors
      // ("Argonne National Laboratory", "Institute for Molecular Engineering").
      const run: string[] = [tok]
      let j = i + 1
      while (j < rawTokens.length) {
        const next = stripPunct(rawTokens[j])
        if (!next) break
        if (isCapitalised(next)) {
          run.push(next)
          j++
          continue
        }
        const nextNext = j + 1 < rawTokens.length ? stripPunct(rawTokens[j + 1]) : ''
        if (CONNECTORS.has(next.toLowerCase()) && nextNext && isCapitalised(nextNext)) {
          run.push(next, nextNext)
          j += 2
          continue
        }
        break
      }

      const trimmed = [...run]
      // A run opening the sentence may just be grammar ("Since then I ran...").
      // Drop leading prose words; if nothing survives it was never an entity.
      if (i === 0 && firstRun) {
        while (trimmed.length && isProse(trimmed[0])) trimmed.shift()
      }
      // Prose words anywhere in the run are noise, not part of the name.
      const content = trimmed.filter((t) => !isProse(t) && !CONNECTORS.has(t.toLowerCase()))

      // A lone capitalised word opening a sentence is grammar, not a name, so
      // it carries no signal worth reporting. Multi-word runs are still caught
      // at sentence start ("Argonne National Laboratory operates...").
      //
      // Only when NOTHING was trimmed, though: in "The ACME rollout", the
      // survivor is ACME, which is capitalised because it is a name and not
      // because a sentence started. Suppressing it here let an invented
      // acronym through.
      const sentenceInitialLoneWord =
        i === 0 && firstRun && content.length === 1 && trimmed.length === run.length

      if (content.length > 0 && !sentenceInitialLoneWord) {
        const acronyms = content.filter(
          (t) => isAcronym(t) && !ACRONYM_STOPLIST.has(baseForm(t).toUpperCase())
        )
        const words = content.filter((t) => !isAcronym(t)).map(baseForm)

        // Each acronym is its own claim — "MMIC and APP" is two names.
        for (const a of acronyms) {
          out.push({ raw: baseForm(a), tokens: [baseForm(a)], sentence, strong: true })
        }
        if (words.length > 0) {
          out.push({
            raw: words.join(' '),
            tokens: words,
            sentence,
            strong: words.length > 1,
          })
        }
      }

      firstRun = false
      i = j > i ? j : i + 1
    }
  }

  return out
}

// ─── Evidence matching ───────────────────────────────────────────────────────

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9&'’-]+/g) ?? []
}

/**
 * A token is grounded when the evidence contains it, or contains an
 * abbreviation of it (or vice versa). "Laboratory" is grounded by "Lab";
 * "Aurora" is grounded by nothing.
 */
function tokenGrounded(token: string, evidenceWords: Set<string>, initialisms?: Set<string>): boolean {
  const t = token.toLowerCase().replace(/[^a-z0-9&'’-]/g, '')
  if (!t) return true
  if (evidenceWords.has(t)) return true
  // "P&G" is Procter & Gamble. An initialism of something on record is not an
  // invented name, and treating it as one blocked a draft for abbreviating the
  // company the user actually worked at.
  if (initialisms && initialisms.has(t.replace(/[^a-z0-9]/g, ''))) return true
  if (t.length >= 3) {
    for (const w of evidenceWords) {
      if (w.length >= 3 && (w.startsWith(t) || t.startsWith(w))) return true
    }
  }
  return false
}

/** Initials of every multi-word capitalised name in the evidence. */
function initialismsIn(text: string): Set<string> {
  const out = new Set<string>()
  for (const e of extractEntities(text)) {
    if (e.tokens.length < 2) continue
    out.add(e.tokens.map((t) => t[0]).join('').toLowerCase())
  }
  return out
}

// ─── Superlatives ────────────────────────────────────────────────────────────

// Words that assert a ranking almost every time they appear. "most", "best" and
// "top" are deliberately absent — they are quantifiers as often as claims, and
// blocking them produced false positives on ordinary sentences.
const HARD_SUPERLATIVES = [
  'largest', 'biggest', 'flagship', 'world-class', 'best-in-class',
  'first-of-its-kind', 'record-breaking', 'unprecedented', 'fastest-growing',
  'industry-leading', 'market-leading', 'pioneering', 'foremost',
]

const SOFT_SUPERLATIVES = ['most', 'best', 'top', 'highest', 'leading', 'only', 'premier']

// ─── Recipient responsibility ────────────────────────────────────────────────

/** Long-but-empty words. Present in every email, so they anchor nothing. */
const FILLER = new Set([
  'there', 'their', 'these', 'those', 'which', 'where', 'while', 'would', 'could',
  'should', 'about', 'after', 'before', 'being', 'other', 'another', 'thing',
  'things', 'something', 'anything', 'really', 'across', 'around', 'towards',
  'currently', 'exactly', 'actually', 'entire', 'whole', 'happy', 'worth',
])

const RESPONSIBILITY_PATTERNS: RegExp[] = [
  /\b(?:you|you're|you are|your team|your group)\s+(?:currently\s+|now\s+)?(?:lead|leads|leading|run|runs|running|head|heads|heading|own|owns|owning|oversee|oversees|overseeing|manage|manages|managing|drive|drives|driving|build|builds|building|built|launch|launched|launching|scaled?|scaling)\b/i,
  /\byou(?:'re| are)\s+responsible for\b/i,
  /\byour\s+\w+\s+(?:team|group|org|organisation|organization|programme|program|initiative|mandate|remit)\b/i,
]

// ─── The gate ────────────────────────────────────────────────────────────────

function sentenceContaining(text: string, index: number): string {
  const sentences = splitSentences(text)
  let cursor = 0
  for (const s of sentences) {
    const at = text.indexOf(s, cursor)
    if (at < 0) continue
    if (index >= at && index <= at + s.length) return s
    cursor = at + s.length
  }
  return sentences[0] ?? text.slice(0, 160)
}

export function checkGrounding(input: GroundingInput): GroundingResult {
  const draft = `${input.subject}\n\n${input.body}`
  const evidenceText = input.evidence.join('\n')
  const safeText = (input.safeNames ?? []).join('\n')
  const pool = `${evidenceText}\n${safeText}`
  const evidenceWords = new Set([...words(evidenceText), ...words(safeText)])
  const initialisms = initialismsIn(pool)
  const poolLower = pool.toLowerCase()

  const findings: GroundingFinding[] = []

  // ─── quantities ───
  const draftQuantities = extractQuantities(draft)
  const evidenceQuantities = extractQuantities(pool)

  for (const q of draftQuantities) {
    if (quantityGrounded(q, evidenceQuantities)) continue
    const sameKind = evidenceQuantities.filter((e) => e.kind === q.kind).map((e) => e.raw)
    const available = sameKind.length
      ? sameKind.slice(0, 4).join(', ')
      : evidenceQuantities.slice(0, 4).map((e) => e.raw).join(', ') || 'no figures at all'
    findings.push({
      severity: 'blocking',
      kind: 'quantity',
      claim: q.raw,
      sentence: sentenceContaining(draft, q.index),
      reason: `No stored evidence contains the figure "${q.raw}".`,
      revision: `Drop "${q.raw}", or replace it with a figure that is on record: ${available}.`,
    })
  }

  // ─── entities ───
  const entities = extractEntities(draft)
  for (const e of entities) {
    const full = e.raw.toLowerCase()
    if (poolLower.includes(full)) continue
    const ungrounded = e.tokens.filter((t) => !tokenGrounded(t, evidenceWords, initialisms))
    if (ungrounded.length === 0) continue

    const known = Array.from(
      new Set(
        extractEntities(pool)
          .map((x) => x.raw)
          .filter((x) => x.length > 2)
      )
    ).slice(0, 6)

    findings.push({
      severity: e.strong ? 'blocking' : 'warning',
      kind: 'entity',
      claim: ungrounded.join(' '),
      sentence: e.sentence,
      reason: `"${ungrounded.join(' ')}" appears in no stored research fact or background item.`,
      revision: known.length
        ? `Name only things on record: ${known.join(', ')}. Otherwise remove the reference.`
        : `Remove the reference — there is no research backing any named programme here.`,
    })
  }

  // ─── superlatives ───
  // Note: the scanning regex and the rewriting regex are separate objects on
  // purpose. String.replace with a /g/ regex resets that regex's lastIndex,
  // which restarts the scan from zero — an infinite loop that allocates until
  // the process dies. Found by running it, not by reading it.
  for (const word of HARD_SUPERLATIVES) {
    const pattern = `\\b${word.replace(/-/g, '[- ]?')}\\b`
    if (new RegExp(pattern, 'i').test(pool)) continue
    const scan = new RegExp(pattern, 'gi')
    let m: RegExpExecArray | null
    while ((m = scan.exec(draft))) {
      const sentence = sentenceContaining(draft, m.index)
      findings.push({
        severity: 'blocking',
        kind: 'superlative',
        claim: m[0],
        sentence,
        reason: `"${m[0]}" is a ranking claim and no stored evidence makes it.`,
        revision: sentence.replace(new RegExp(pattern, 'gi'), '').replace(/\s{2,}/g, ' ').trim(),
      })
    }
  }
  for (const word of SOFT_SUPERLATIVES) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(pool)) continue
    const scan = new RegExp(`\\bthe ${word}\\b`, 'gi')
    let m: RegExpExecArray | null
    while ((m = scan.exec(draft))) {
      findings.push({
        severity: 'warning',
        kind: 'superlative',
        claim: m[0],
        sentence: sentenceContaining(draft, m.index),
        reason: `"${m[0]}" reads as a ranking claim; nothing on record supports it.`,
        revision: `Soften to a description, or cite the source that ranks them.`,
      })
    }
  }

  // ─── recipient responsibilities ───
  for (const sentence of splitSentences(draft)) {
    if (!RESPONSIBILITY_PATTERNS.some((p) => p.test(sentence))) continue
    // The sentence asserts what this person does. At least one content word in
    // it must trace back to research about them.
    //
    // Exact match, not the prefix match entities use. Prefix matching let
    // "there" ground itself against "the" and waved through
    // "You lead the quantum photonics roadmap there."
    const content = words(sentence).filter((w) => w.length >= 5 && !FILLER.has(w))
    const anchored = content.some((w) => evidenceWords.has(w))
    if (anchored) continue
    const recipientEvidence = input.evidence
      .filter((e) => /^RECIPIENT|^THEIR COMPANY/i.test(e))
      .slice(0, 2)
      .join(' | ')
    findings.push({
      severity: 'blocking',
      kind: 'responsibility',
      claim: sentence.slice(0, 120),
      sentence,
      reason: 'Asserts what the recipient is responsible for, with nothing on record to support it.',
      revision: recipientEvidence
        ? `Rewrite from what is on record: ${recipientEvidence}`
        : `Ask instead of assert — "is that your side of it?" — or research the claim first.`,
    })
  }

  const blocking = findings.filter((f) => f.severity === 'blocking')
  const warnings = findings.filter((f) => f.severity === 'warning')

  return {
    ok: blocking.length === 0,
    findings,
    blocking,
    warnings,
    stats: {
      evidenceItems: input.evidence.length,
      quantitiesChecked: draftQuantities.length,
      entitiesChecked: entities.length,
    },
  }
}

/** One line for the UI and the API error body. */
export function summarizeGrounding(r: GroundingResult): string {
  if (r.ok && r.warnings.length === 0) {
    return `Grounded — ${r.stats.quantitiesChecked} figures and ${r.stats.entitiesChecked} names checked against ${r.stats.evidenceItems} evidence items.`
  }
  if (r.ok) return `Grounded, with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}.`
  return `${r.blocking.length} unsupported claim${r.blocking.length === 1 ? '' : 's'}: ${r.blocking
    .map((f) => `"${f.claim}"`)
    .join(', ')}`
}
