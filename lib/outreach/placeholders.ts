// Placeholder detection — deterministic, blocking.
//
// "No placeholders" is stated three times in the writer's prompt. That is the
// weakest possible enforcement, and the repo's whole grounding philosophy says
// so: never fight a failure mode with instructions alone when you can make it
// structurally impossible (ADR-006, ADR-011).
//
// A placeholder that reaches a real recipient is unrecoverable in a way almost
// nothing else here is. "Hi [First Name]" is not a quality problem; it is proof
// the sender did not read their own email.
//
// The detector is deliberately conservative about ONE case: square brackets are
// also legitimate prose ("[sic]", a bracketed aside). Those are so rare in a
// cold email, and the cost of missing a real placeholder so high, that brackets
// containing a short capitalised or snake_case token are treated as blocking and
// everything else bracketed is a warning.

export type PlaceholderKind = 'bracket' | 'mustache' | 'angle' | 'token' | 'stub_name'

export interface PlaceholderFinding {
  severity: 'blocking' | 'warning'
  kind: PlaceholderKind
  /** The exact text found. */
  match: string
  sentence: string
  reason: string
  revision: string
}

/** Names writers reach for when they mean "fill this in later". */
const STUB_NAMES = [
  'xyz corp', 'xyz company', 'xyz inc', 'acme corp', 'acme inc', 'acme company',
  'company name', 'your company', 'their company', 'insert name', 'insert company',
  'first name', 'last name', 'full name', 'recipient name', 'lorem ipsum',
  'tbd', 'todo', 'fixme',
]

/** Bracketed content that reads like a slot rather than an aside. */
function bracketIsSlot(inner: string): boolean {
  const t = inner.trim()
  if (!t || t.length > 60) return false
  // snake_case / camelCase / kebab tokens are always slots.
  if (/^[a-z]+([_-][a-z]+)+$/i.test(t)) return true
  if (/^[a-z]+[A-Z][a-zA-Z]*$/.test(t)) return true
  // Title Case or ALL CAPS short phrases: [Company], [First Name], [ROLE].
  const words = t.split(/\s+/)
  if (words.length <= 4 && words.every((w) => /^[A-Z][a-zA-Z]*$/.test(w) || /^[A-Z]{2,}$/.test(w))) return true
  // Imperatives that describe what to write rather than saying it.
  if (/^(insert|add|mention|name|describe|your|their|specific|e\.g\.|choose|pick)\b/i.test(t)) return true
  return false
}

function sentenceAround(text: string, index: number): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/)
  let cursor = 0
  for (const s of sentences) {
    const at = text.indexOf(s, cursor)
    if (at < 0) continue
    if (index >= at && index <= at + s.length) return s.trim()
    cursor = at + s.length
  }
  return text.slice(Math.max(0, index - 60), index + 60).trim()
}

export function findPlaceholders(subject: string, body: string): PlaceholderFinding[] {
  const text = `${subject}\n\n${body}`
  const out: PlaceholderFinding[] = []
  // Spans already reported. "[First Name]" is ONE placeholder; reporting it
  // again as the stub name "First Name" inside it makes the count wrong and the
  // UI say "2 placeholders" about one bracket.
  const claimed: Array<[number, number]> = []
  const overlaps = (start: number, end: number) => claimed.some(([s, e]) => start < e && end > s)

  const push = (
    severity: PlaceholderFinding['severity'],
    kind: PlaceholderKind,
    match: string,
    index: number,
    reason: string,
    revision: string
  ) => {
    if (overlaps(index, index + match.length)) return
    claimed.push([index, index + match.length])
    out.push({ severity, kind, match, sentence: sentenceAround(text, index), reason, revision })
  }

  let m: RegExpExecArray | null

  // {{ mustache }} and { single } — never prose in an email.
  const mustache = /\{\{?\s*([^{}]{1,60}?)\s*\}?\}/g
  while ((m = mustache.exec(text))) {
    push(
      'blocking',
      'mustache',
      m[0],
      m.index,
      `"${m[0]}" is a template variable that was never filled in.`,
      `Replace "${m[0]}" with the real value, or rewrite the sentence without it.`
    )
  }

  // <angle brackets> — but not an email address or an HTML tag.
  const angle = /<\s*([A-Za-z][^<>@]{1,58})\s*>/g
  while ((m = angle.exec(text))) {
    const inner = m[1].trim()
    if (/^\/?(a|b|i|p|br|em|strong|div|span|ul|li|h[1-6])\b/i.test(inner)) continue
    push(
      'blocking',
      'angle',
      m[0],
      m.index,
      `"${m[0]}" is an unfilled slot.`,
      `Replace "${m[0]}" with the real value, or rewrite without it.`
    )
  }

  // [square brackets]
  const square = /\[([^\][]{1,80})\]/g
  while ((m = square.exec(text))) {
    const inner = m[1]
    const slot = bracketIsSlot(inner)
    push(
      slot ? 'blocking' : 'warning',
      'bracket',
      m[0],
      m.index,
      slot
        ? `"${m[0]}" is a placeholder that was never filled in.`
        : `"${m[0]}" is bracketed text — check it is deliberate and not a leftover slot.`,
      slot
        ? `Write the actual value in place of "${m[0]}", or rewrite the sentence without it.`
        : `Remove the brackets if the text is meant to be read.`
    )
  }

  // Bare stand-in names.
  for (const stub of STUB_NAMES) {
    const re = new RegExp(`\\b${stub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    while ((m = re.exec(text))) {
      push(
        'blocking',
        'stub_name',
        m[0],
        m.index,
        `"${m[0]}" is a stand-in, not a real name.`,
        `Use the recipient's actual name or company.`
      )
    }
  }

  // ALL-CAPS instruction tokens the model left behind: NAME, COMPANY, TOPIC.
  // Anything already inside a reported bracket is skipped by `push`.
  const token = /(?<![A-Za-z])(NAME|COMPANY|TOPIC|ROLE|TITLE|PROJECT|REASON|DATE|CITY|X{2,})(?![A-Za-z])/g
  while ((m = token.exec(text))) {
    push(
      'blocking',
      'token',
      m[0],
      m.index,
      `"${m[0]}" is an unreplaced instruction token.`,
      `Write the real value instead of "${m[0]}".`
    )
  }

  return out.sort((a, b) => text.indexOf(a.match) - text.indexOf(b.match))
}

/** One line for a UI that has room for one line. */
export function summarizePlaceholders(findings: PlaceholderFinding[]): string {
  const blocking = findings.filter((f) => f.severity === 'blocking')
  if (blocking.length === 0) return findings.length === 0 ? 'No placeholders.' : `${findings.length} bracketed span(s) to check.`
  return `${blocking.length} placeholder${blocking.length === 1 ? '' : 's'} left in: ${blocking
    .map((f) => `"${f.match}"`)
    .slice(0, 4)
    .join(', ')}`
}
