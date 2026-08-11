// Bounded-concurrency map.
//
// Scoring and judging batches are independent, so running them sequentially
// wastes most of the wall clock on network latency. A small pool keeps the
// eval loop fast enough to actually iterate on, without hammering rate limits.

/**
 * Deterministic stride interleave.
 *
 * Candidates arrive in discovery order, i.e. grouped by the query that found
 * them. Batching that order directly hands the scorer eight near-identical
 * companies at a time, so it has no contrast to calibrate against and collapses
 * every score into one narrow band (iteration 2: all top-20 components between
 * 0.88 and 0.98). Striding across the pool puts genuinely different candidates
 * in each batch, which is what makes relative scoring work.
 *
 * Deterministic — no RNG — so an eval re-run produces the same batches and a
 * metric change stays attributable to a code change.
 */
export function interleave<T>(items: T[], stride: number): T[] {
  if (items.length <= stride || stride < 2) return [...items]
  const out: T[] = []
  for (let offset = 0; offset < stride; offset++) {
    for (let i = offset; i < items.length; i += stride) out.push(items[i])
  }
  return out
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}
