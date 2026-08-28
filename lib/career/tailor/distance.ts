// Edit distance for résumé patches.
//
// The minimum-edit objective is enforced by MEASURING, not by asking the
// tailor to be restrained. Every patch records how far the final bullets are
// from the master, and the minimal-edit eval fails a run that rewrote more
// than it needed to. Token-level, so "$4M+" is one token and a reworded verb
// is one edit rather than five characters.

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\*\*/g, '')
    .match(/[a-z0-9$%+#&.,'’/-]+/g) ?? []
}

function levenshtein(a: string[], b: string[]): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** Normalised token-level Levenshtein distance between two bullets, 0 = identical, 1 = nothing shared. */
export function bulletDistance(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  const longest = Math.max(ta.length, tb.length)
  if (longest === 0) return 0
  return levenshtein(ta, tb) / longest
}

/** How many word-level edits separate two bullets, and the share of the original that changed. */
export function wordsChanged(original: string, revised: string): { edits: number; fraction: number } {
  const to = tokens(original)
  const tr = tokens(revised)
  const edits = levenshtein(to, tr)
  return { edits, fraction: to.length === 0 ? (tr.length ? 1 : 0) : edits / to.length }
}

export interface PatchDistance {
  /** Mean bullet distance over the aligned pairs, plus a share for added/removed bullets. 0–1. */
  distance: number
  /** Share of master bullets whose text changed or which were removed. */
  changedFraction: number
  reordered: boolean
}

/**
 * Distance between the master's bullets and the final bullets for one
 * experience (or the whole résumé, concatenated in order).
 *
 * Alignment: each final bullet is matched to its nearest master bullet; a
 * bullet that matches nothing well counts as fully new. Reordering is detected
 * separately because it costs nothing in truthfulness and should not read as
 * a rewrite — the eval wants to see "moved two bullets" and "rewrote two
 * bullets" as different numbers.
 */
export function patchDistance(masterBullets: string[], finalBullets: string[]): PatchDistance {
  if (masterBullets.length === 0 && finalBullets.length === 0) return { distance: 0, changedFraction: 0, reordered: false }

  const assigned = new Map<number, number>() // final index → master index
  const usedMaster = new Set<number>()
  const perBullet: number[] = []

  finalBullets.forEach((text, fi) => {
    let best = -1
    let bestDist = 1
    masterBullets.forEach((m, mi) => {
      if (usedMaster.has(mi)) return
      const d = bulletDistance(m, text)
      if (d < bestDist) {
        bestDist = d
        best = mi
      }
    })
    // A match sharing fewer than half its tokens is a different bullet.
    if (best >= 0 && bestDist < 0.5) {
      assigned.set(fi, best)
      usedMaster.add(best)
      perBullet.push(bestDist)
    } else {
      perBullet.push(1)
    }
  })
  // Master bullets with no partner were removed.
  const removed = masterBullets.length - usedMaster.size
  for (let i = 0; i < removed; i++) perBullet.push(1)

  const distance = perBullet.length ? perBullet.reduce((a, b) => a + b, 0) / perBullet.length : 0

  let changed = removed
  for (const [fi, mi] of assigned) if (bulletDistance(masterBullets[mi], finalBullets[fi]) > 0) changed++
  const changedFraction = masterBullets.length ? Math.min(1, changed / masterBullets.length) : finalBullets.length ? 1 : 0

  const order = [...assigned.entries()].sort((a, b) => a[0] - b[0]).map(([, mi]) => mi)
  const reordered = order.some((mi, i) => i > 0 && mi < order[i - 1])

  return { distance: Number(distance.toFixed(4)), changedFraction: Number(changedFraction.toFixed(4)), reordered }
}
