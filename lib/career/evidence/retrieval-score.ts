// Query building and lexical scoring for the retrieval layer. Pure.
//
// Reuses retrieve.ts's tokenizer, stemmer and synonym families — the tables
// live there and are not duplicated. What is added here: an outreach-oriented
// stop-list, one-hit-per-family scoring, and an idf dampener over the bank.

import { familyOf, terms, type Weighted } from './retrieve'
import type { RetrievalTarget } from './retrieval-types'

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * Words a mission or a person's title uses that say nothing about the user.
 * retrieve.ts's stop-list is tuned for job descriptions; this one covers the
 * outreach vocabulary ("find me people who might…", "Head of Community").
 */
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'of', 'on', 'in', 'or', 'to', 'at', 'by', 'as', 'is', 'be', 'me', 'my', 'we', 'us', 'it', 'its',
  'find', 'meet', 'reach', 'connect', 'reconnect', 'invite', 'hire', 'mentor', 'might', 'could', 'would', 'should',
  'people', 'person', 'someone', 'anyone', 'who', 'whom', 'whose', 'where', 'which', 'when', 'how', 'why',
  'head', 'chief', 'senior', 'junior', 'vice', 'vp', 'director', 'manager', 'lead', 'partner', 'principal', 'associate',
  'officer', 'founder', 'co-founder', 'ceo', 'cto', 'coo', 'cfo',
  'back', 'run', 'get', 'help', 'want', 'need', 'look', 'active', 'relevant', 'realistic', 'strong', 'good', 'high-value',
  'series', 'campus', 'winter', 'summer', 'spring', 'fall', 'term', 'month', 'week',
])

/** Title and keywords weigh most; the mission and description are prose. Stop-words never enter the query. */
export function buildRetrievalQuery(mission: string | null | undefined, target: RetrievalTarget | null | undefined): Weighted[] {
  const weights = new Map<string, number>()
  const add = (text: string | null | undefined, w: number) => {
    if (!text) return
    for (const t of new Set(terms(text))) {
      if (t.length < 3 || QUERY_STOPWORDS.has(t)) continue
      weights.set(t, Math.max(weights.get(t) ?? 0, w))
    }
  }
  add(target?.title, 3)
  for (const k of target?.keywords ?? []) add(k, 3)
  add(mission, 1.5)
  add(target?.company, 1)
  add(target?.description, 1)
  return [...weights.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([term, weight]) => ({ term, weight }))
}

// ─── Document frequency ──────────────────────────────────────────────────────

/**
 * How common each query term (and each synonym family) is across the bank.
 * "startup" in the bank of someone with five startup rows separates nothing;
 * "catalysis" in one row separates everything. BM25-style idf, normalized to
 * (0, 1] so weights stay comparable across banks of different sizes.
 */
export interface DocFreq {
  idfTerm: Map<string, number>
  idfFamily: Map<number, number>
}

export function buildDocFreq(docs: string[], query: Weighted[]): DocFreq {
  const n = Math.max(1, docs.length)
  const sets = docs.map((d) => new Set(terms(d)))
  const familySets = sets.map((s) => {
    const fams = new Set<number>()
    for (const t of s) { const f = familyOf(t); if (f !== null) fams.add(f) }
    return fams
  })
  const idf = (df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5)) / Math.log(1 + (n + 0.5) / 0.5)
  const idfTerm = new Map<string, number>()
  const idfFamily = new Map<number, number>()
  for (const q of query) {
    if (!idfTerm.has(q.term)) idfTerm.set(q.term, idf(sets.filter((s) => s.has(q.term)).length))
    const f = familyOf(q.term)
    if (f !== null && !idfFamily.has(f)) idfFamily.set(f, idf(familySets.filter((s) => s.has(f)).length))
  }
  return { idfTerm, idfFamily }
}

/**
 * Score one text: exact stem hits at full weight × idf; ONE family hit per
 * family at half the family's strongest unmatched query weight × the family's
 * idf — so "founder", "startup" and "venture" in a query are one signal, not
 * three. Normalized by log length so a long description does not outrank a
 * short, precise fact just by containing more words.
 */
export function scoreDoc(text: string, query: Weighted[], df: DocFreq): { score: number; matched: string[] } {
  const present = new Set(terms(text))
  const families = new Set<number>()
  for (const t of present) { const f = familyOf(t); if (f !== null) families.add(f) }
  let score = 0
  const matched: string[] = []
  const familyBest = new Map<number, { weight: number; term: string }>()
  for (const q of query) {
    if (present.has(q.term)) {
      score += q.weight * (df.idfTerm.get(q.term) ?? 1)
      matched.push(q.term)
      continue
    }
    const f = familyOf(q.term)
    if (f !== null && families.has(f)) {
      const best = familyBest.get(f)
      if (!best || q.weight > best.weight) familyBest.set(f, { weight: q.weight, term: q.term })
    }
  }
  for (const [f, best] of familyBest) {
    score += best.weight * 0.5 * (df.idfFamily.get(f) ?? 1)
    matched.push(`~${best.term}`)
  }
  const norm = Math.log2(8 + present.size)
  return { score: score / norm, matched: matched.sort() }
}
