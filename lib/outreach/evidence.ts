// The allowed-claims pool.
//
// ONE builder, used by the writer AND by the claim-safety gate. That identity is
// the whole design: if the writer is given a fact the gate has never seen, the
// gate blocks honest drafts; if the gate sees a fact the writer was not given,
// it waves through claims that came from nowhere. Two copies of this logic
// drifted apart within a day of existing, which is how it got extracted here.
//
// Two evidence classes, deliberately separate (see docs/PHASE_POSITIONING.md §3):
//   * the positioning brief is the ARGUMENT — it contains inferences
//   * these strings are the EVIDENCE — only these may be asserted as fact

export interface BackgroundItem {
  id: string
  title: string
  org: string
  period?: string
  summary: string
}

export interface EvidenceInput {
  /** Free text about the company, from research. */
  companyContext: string
  /** The person dossier, bulleted, from research. */
  personContext: string
  recipientTitle: string | null
  recipientCompany: string
  /** The background items positioning actually chose — never the whole résumé. */
  chosenBackground: BackgroundItem[]
}

/**
 * Sentence-split on a real full stop.
 *
 * The obvious-looking `/(?<=.)\s+/` is a different regex from `/(?<=\.)\s+/`:
 * unescaped, the dot is "any character". A dropped backslash in an earlier copy
 * of this split on the letter "s" instead, producing evidence lines like
 * "ection the candidate already ha" — which starved the writer of company facts
 * and was invisible until the grounding gate started reading the same pool.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Build the evidence pool.
 *
 * Background items contribute title, org and period as well as the summary.
 * The summary alone omits exactly the specifics that make an email concrete —
 * the site name, the scale, the dates — so the writer would reach for them from
 * the brief and the gate would then correctly flag them as unsupported.
 */
export function buildEvidence(input: EvidenceInput): string[] {
  const companyFacts = sentences(input.companyContext)
    .filter((s) => s.length > 30)
    .slice(0, 4)
    .map((s) => `THEIR COMPANY: ${s}`)

  const personFacts = input.personContext
    .split('\n')
    .filter((l) => l.trim().startsWith('•'))
    .map((l) => `RECIPIENT: ${l.replace(/^\s*•\s*/, '').trim()}`)
    .slice(0, 8)

  const senderFacts = input.chosenBackground.map((b) =>
    `SENDER: ${b.title} — ${b.org}${b.period ? ` (${b.period})` : ''}: ${b.summary}`
  )

  return [
    ...companyFacts,
    ...personFacts,
    `RECIPIENT: ${input.recipientTitle ?? 'unknown title'} at ${input.recipientCompany}`,
    ...senderFacts,
  ]
}

/**
 * The gate's verification corpus — a superset of the writer's pool.
 *
 * These are two different questions and they need two different pools:
 *
 *   the writer asks  "what may I ARGUE from?"   -> the chosen items only
 *   the gate asks    "is this claim TRUE?"      -> the user's whole record
 *
 * Collapsing them fails in both directions. Handing the writer everything
 * re-dumps the résumé and destroys the ≤3-proof-point selectivity that
 * positioning exists to enforce (CLAUDE.md principle 5). Restricting the gate to
 * the chosen three blocks statements that are simply true: eight of ten measured
 * drafts said "P&G's largest global manufacturing site", which is on the user's
 * record — on a DIFFERENT item from the one being cited.
 *
 * So the extra lines are identity only — title, org, period — never summaries,
 * and no model ever sees this pool. Selectivity is a writing decision; truth is
 * a verification decision.
 */
export function buildVerificationPool(
  writerEvidence: string[],
  allBackground: BackgroundItem[],
  chosenIds: string[],
  /**
   * Evidence Bank facts behind the CHOSEN items only. A BackgroundItem's
   * summary is two facts at most; the draft may honestly cite a third one
   * from the same experience, and the gate must be able to see it. Facts of
   * experiences positioning did not choose are never admitted — that would be
   * the whole bank by another door.
   */
  bankFacts?: { id: string; statement: string; experienceId: string }[]
): string[] {
  const chosen = new Set(chosenIds)
  const rest = allBackground
    .filter((b) => !chosen.has(b.id))
    .map((b) => `ON RECORD: ${b.title} — ${b.org}${b.period ? ` (${b.period})` : ''}`)
  const seen = new Set(writerEvidence)
  const factLines: string[] = []
  for (const f of bankFacts ?? []) {
    if (!chosen.has(f.experienceId)) continue
    const line = `SENDER: ${f.statement}`
    if (seen.has(line)) continue
    seen.add(line)
    factLines.push(line)
  }
  return [...writerEvidence, ...factLines, ...rest]
}

/**
 * The campaign's reference email, as verification evidence.
 *
 * The reference is an email the USER WROTE AND SENT. Facts in it about
 * themselves — their club, their site, the size of their cohort — are verified
 * by construction, exactly as an inbound reply is verified by the fact that the
 * recipient wrote it (see `evidenceForReply` below).
 *
 * Found by running the eval: a sponsorship reference said "roughly 300 students",
 * every generated draft in that campaign repeated it, and the gate blocked all
 * of them for an unsupported quantity. The gate was right that 300 was in no
 * stored fact, and wrong that it was unsupported — the user had asserted it
 * themselves, in the example they supplied.
 *
 * The exclusion is the whole safety of this. Sentences carrying a distinctive
 * token from `recipientSpecific` — the reference's OWN recipient's company,
 * project or numbers — are dropped, so admitting the reference can never
 * legitimise transplanting them into a stranger's inbox.
 */
export function evidenceFromReference(referenceBody: string, recipientSpecific: string[]): string[] {
  if (!referenceBody.trim()) return []

  const stop = new Set([
    'the', 'and', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'been',
    'for', 'you', 'your', 'about', 'would', 'could', 'they', 'their', 'what', 'which',
    'there', 'here', 'when', 'where', 'into', 'over', 'more', 'most', 'some', 'work',
    'like', 'just', 'than', 'then', 'them', 'will', 'want', 'know', 'think', 'people',
    'recipient', 'their', 'company', 'email', 'writer', 'fact', 'implied', 'unspoken',
  ])
  const tokens = (s: string) =>
    (s.toLowerCase().match(/[a-z][a-z'-]{4,}|\d[\d,.]*/g) ?? []).filter((t) => !stop.has(t))

  const banned = new Set<string>()
  for (const item of recipientSpecific) for (const t of tokens(item)) banned.add(t)

  return referenceBody
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((sentence) => !tokens(sentence).some((t) => banned.has(t)))
    .map((sentence) => `SENDER WROTE THIS BEFORE: ${sentence}`)
}

/**
 * Evidence for a reply, which is the writer's pool plus what they just told you.
 *
 * Anything in an inbound message is verified by definition — they wrote it. The
 * first eval run flagged a suggested response for naming "Dana", the colleague
 * the recipient had referred in the very email being answered. Excluding the
 * reply would make every referral follow-up unsendable.
 */
export function evidenceForReply(writerEvidence: string[], replyBody: string): string[] {
  return [...writerEvidence, `THEY WROTE: ${replyBody.slice(0, 4000)}`]
}

/**
 * Names that are true by construction and must never be treated as claims —
 * you cannot write to someone without naming them.
 */
export function safeNamesFor(opts: {
  recipientName: string
  recipientCompany: string
  senderName: string
  timeframe?: string | null
}): string[] {
  return [
    opts.recipientName,
    opts.recipientCompany,
    opts.senderName,
    opts.timeframe ?? '',
  ].filter(Boolean)
}
