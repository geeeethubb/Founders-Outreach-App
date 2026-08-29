// Merge-chain resolution for experience proposals.
//
// Pairwise comparison emits one proposal per pair, so three duplicates A, B, C
// produce A←B, A←C and B←C — three proposals for two tombstones, and applying
// them one at a time would fold C into B after B was already tombstoned.
// Rows would then hang off a merged experience and vanish from every
// active-bank reader. This module turns pairwise HIGH verdicts into a set of
// proposals where every keep_id is a root (never itself a merge_id) and every
// merge_id appears exactly once.
//
// Rule: take the connected components of the HIGH graph inside one org group.
//   - A component in which every pair is HIGH is a clique: preferKeep gives a
//     total order, so the minimum is the root; keep the proposals whose keep
//     is the root, drop the rest as redundant (their merge already folds in).
//   - A component that is not a clique is ambiguous — e.g. an undated LinkedIn
//     row that matches two disjoint résumé summers. Nothing in the data says
//     which one it is, so every HIGH edge in it is demoted to POSSIBLE. False
//     negatives over destructive false positives.
// Pure and deterministic; proposals keep their original order.

import type { MergeProposal } from './consolidate-types'

export interface ChainResolution {
  proposals: MergeProposal[]
  warnings: string[]
}

export function resolveExperienceChains(proposals: MergeProposal[], labelOf: (id: string) => string): ChainResolution {
  const high = proposals.filter((p) => p.confidence === 'HIGH')
  if (high.length === 0) return { proposals, warnings: [] }

  // Connected components over HIGH edges.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    while (parent.get(x) !== r) { const next = parent.get(x) as string; parent.set(x, r); x = next }
    return r
  }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const p of high) union(p.keep_id, p.merge_id)

  const members = new Map<string, Set<string>>()
  for (const p of high) {
    const r = find(p.keep_id)
    const set = members.get(r) ?? new Set<string>()
    set.add(p.keep_id); set.add(p.merge_id)
    members.set(r, set)
  }
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const highEdges = new Set(high.map((p) => edgeKey(p.keep_id, p.merge_id)))

  const warnings: string[] = []
  const drop = new Set<MergeProposal>()
  const demote = new Set<MergeProposal>()
  for (const [, set] of members) {
    const ids = [...set].sort()
    if (ids.length < 3) continue
    let clique = true
    for (let i = 0; i < ids.length && clique; i++) for (let j = i + 1; j < ids.length; j++) if (!highEdges.has(edgeKey(ids[i], ids[j]))) { clique = false; break }
    const edges = high.filter((p) => set.has(p.keep_id))
    if (clique) {
      // preferKeep is a total order, so the root is the keep of every edge it touches.
      const mergeIds = new Set(edges.map((p) => p.merge_id))
      const roots = ids.filter((id) => !mergeIds.has(id))
      const root = roots[0]
      for (const p of edges) if (p.keep_id !== root) {
        drop.add(p)
        warnings.push(`redundant merge dropped: "${labelOf(p.merge_id)}" already folds into "${labelOf(root)}" (chain of ${ids.length} duplicates)`)
      }
    } else {
      for (const p of edges) demote.add(p)
      warnings.push(`ambiguous duplicate cluster demoted to POSSIBLE (${ids.length} rows, not all pairwise duplicates): ${ids.map(labelOf).map((l) => `"${l}"`).join(', ')}`)
    }
  }

  const out = proposals
    .filter((p) => !drop.has(p))
    .map((p) => demote.has(p)
      ? { ...p, confidence: 'POSSIBLE' as const, signals: { ...p.signals, downgraded: 'ambiguous_cluster' }, risk: 'needs a human: this row matches more than one distinct row', why: `${p.why}; demoted — it also matches another row that is not a duplicate of this one` }
      : p)
  return { proposals: out, warnings }
}
