// Pure metric helpers for the Career OS eval suites (docs/CAREER_OS.md §9).
//
// No model, no I/O, no dependencies. Every suite script computes its numbers
// here so that "P@20" means the same thing in the discovery report and in the
// fit report, and so the arithmetic is unit-tested once
// (scripts/test-career-evals.ts) rather than re-derived per script.

// ─── Ranking ─────────────────────────────────────────────────────────────────

/**
 * Precision at k over an already-ranked list. `verdicts` is in rank order;
 * `isGood` decides what counts. A list shorter than k is scored over what
 * exists — the caller reports the shortfall, the metric does not hide it.
 */
export function precisionAtK<T>(verdicts: T[], k: number, isGood: (v: T) => boolean): number {
  const top = verdicts.slice(0, Math.max(0, k))
  if (top.length === 0) return 0
  return top.filter(isGood).length / top.length
}

/**
 * How many (negative, positive) pairs are in the wrong order. Zero means every
 * planted negative sits below every positive; the fit eval's target. Counted
 * pairwise rather than as "any negative in top-k" so a report can say how bad,
 * not only whether.
 */
export function rankOrderViolations(ranked: string[], expectedClasses: Record<string, 'positive' | 'negative'>): number {
  let violations = 0
  for (let i = 0; i < ranked.length; i++) {
    if (expectedClasses[ranked[i]] !== 'negative') continue
    for (let j = i + 1; j < ranked.length; j++) {
      if (expectedClasses[ranked[j]] === 'positive') violations++
    }
  }
  return violations
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Share of postings that were duplicates of another posting. A cluster of size
 * n contributes n − 1 duplicates; singletons contribute nothing.
 */
export function duplicateRate(clusters: { size: number }[]): number {
  const total = clusters.reduce((s, c) => s + Math.max(0, c.size), 0)
  if (total === 0) return 0
  const dupes = clusters.reduce((s, c) => s + Math.max(0, c.size - 1), 0)
  return dupes / total
}

/**
 * Of the rows the system showed as open, how many were actually stale or
 * closed. `shownOpen` is what the pipeline claimed; `actuallyOpen` is the
 * ground truth from a re-verification pass.
 */
export function staleShownOpenRate(rows: { shownOpen: boolean; actuallyOpen: boolean }[]): number {
  const shown = rows.filter((r) => r.shownOpen)
  if (shown.length === 0) return 0
  return shown.filter((r) => !r.actuallyOpen).length / shown.length
}

/**
 * Share of canonical URLs whose host is one the benchmark expects for that
 * company: the company's own domain, or a known ATS host. An aggregator URL
 * stored as canonical is the failure this catches.
 */
export function canonicalUrlAccuracy(rows: { canonical_url: string | null }[], expectedHosts: string[]): number {
  if (rows.length === 0) return 0
  const hosts = expectedHosts.map((h) => h.toLowerCase().replace(/^www\./, ''))
  let ok = 0
  for (const r of rows) {
    const host = hostOf(r.canonical_url)
    if (host && hosts.some((h) => host === h || host.endsWith(`.${h}`))) ok++
  }
  return ok / rows.length
}

export function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

// ─── Classification ──────────────────────────────────────────────────────────

/** Exact-match accuracy over (predicted, expected) pairs. Empty input is 0, not NaN. */
export function classificationAccuracy<T>(pairs: { predicted: T; expected: T }[]): number {
  if (pairs.length === 0) return 0
  return pairs.filter((p) => p.predicted === p.expected).length / pairs.length
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** Levenshtein distance on characters. Small inputs only; résumé bullets, not documents. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Mean edit distance across (original, proposed) pairs, normalized by the
 * longer string so a long bullet and a short one are comparable. This is the
 * tailoring measurement: a matched role should score near zero.
 */
export function meanEditDistance(pairs: { original: string; proposed: string }[]): number {
  if (pairs.length === 0) return 0
  const sum = pairs.reduce((s, p) => {
    const denom = Math.max(p.original.length, p.proposed.length)
    return s + (denom === 0 ? 0 : editDistance(p.original, p.proposed) / denom)
  }, 0)
  return sum / pairs.length
}

// ─── Reporting ───────────────────────────────────────────────────────────────

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`
}

/**
 * A padded-column table for eval reports. Numbers right-align; everything else
 * left-aligns. Returns the string rather than printing so scripts can also
 * write it to a report file.
 */
export function formatTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cells = rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))))
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)))
  const isNum = (s: string) => /^-?\d+(\.\d+)?%?$/.test(s)
  const line = (r: string[]) =>
    r.map((c, i) => (isNum(c) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd()
  const out = [line(headers), widths.map((w) => '-'.repeat(w)).join('  ')]
  for (const r of cells) out.push(line(headers.map((_, i) => r[i] ?? '')))
  return out.join('\n')
}

export function printTable(headers: string[], rows: (string | number | null | undefined)[][]): void {
  console.log(formatTable(headers, rows))
}
