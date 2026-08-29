// The dry-run report: a ConsolidationPlan as text a founder reads before
// typing --apply, and as JSON a file can hold.

import type { ConsolidationPlan, MergeProposal } from './consolidate-types'

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ')
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function table(rows: MergeProposal[]): string[] {
  if (rows.length === 0) return ['  (none)']
  const widths = { keep: 44, merge: 44, why: 48, data: 40, risk: 24 }
  const header = `  ${pad('KEEP', widths.keep)} | ${pad('MERGE', widths.merge)} | ${pad('WHY', widths.why)} | ${pad('DATA PRESERVED', widths.data)} | RISK`
  const lines = [header, `  ${'-'.repeat(header.length - 2)}`]
  for (const p of rows) {
    lines.push(
      `  ${pad(clip(p.keep_label, widths.keep), widths.keep)} | ${pad(clip(p.merge_label, widths.merge), widths.merge)} | ` +
      `${pad(clip(`[${p.rule}] ${p.why}`, widths.why), widths.why)} | ${pad(clip(p.data_preserved, widths.data), widths.data)} | ${clip(p.risk, widths.risk)}`
    )
    lines.push(`    ids: keep ${p.keep_id}  merge ${p.merge_id}`)
  }
  return lines
}

function section(title: string, proposals: MergeProposal[]): string[] {
  const out: string[] = []
  for (const cls of ['HIGH', 'POSSIBLE', 'CONFLICT'] as const) {
    const rows = proposals.filter((p) => p.confidence === cls)
    if (rows.length === 0 && cls !== 'HIGH') continue
    out.push('', `${title} — ${cls} (${rows.length})`)
    out.push(...table(rows))
  }
  return out
}

export function renderPlanReport(plan: ConsolidationPlan): string {
  const s = plan.summary
  const lines: string[] = [
    `Consolidation plan — user ${plan.user_id || '(unknown)'} — ${plan.generated_at}`,
    `migration 015: ${plan.migration015 ? 'applied' : 'NOT applied (dry run only; --apply will refuse)'}`,
    '',
    `experiences: ${s.experiences.active} active · HIGH ${s.experiences.high} · POSSIBLE ${s.experiences.possible} · CONFLICT ${s.experiences.conflict}`,
    `facts:       ${s.facts.active} active · HIGH ${s.facts.high} · POSSIBLE ${s.facts.possible} · CONFLICT ${s.facts.conflict}`,
    `metrics:     ${s.metrics.active} active · HIGH ${s.metrics.high} · POSSIBLE ${s.metrics.possible} · orphaned ${s.metrics.orphaned}`,
    `organizations: ${s.organizations.proposed} to create · ${s.organizations.existing} existing`,
    `provenance:  ${plan.provenance.facts_missing_provenance.length} facts and ${plan.provenance.experiences_missing_provenance.length} experiences without a source row · ${plan.provenance.sources_to_create.length} source records to create`,
    `if every HIGH merge were applied: ${s.would_tombstone} rows tombstoned, ${s.would_repoint} child rows re-pointed, 0 rows deleted`,
  ]
  lines.push(...section('EXPERIENCES', plan.experiences))
  lines.push(...section('FACTS', plan.facts))
  lines.push(...section('METRICS', plan.metrics))

  lines.push('', `ORGANIZATIONS (${plan.organizations.length})`)
  for (const o of plan.organizations) {
    lines.push(`  ${pad(o.canonical_name, 40)} key="${o.normalized_name}" ${o.existing_id ? 'existing' : 'new'} · ${o.experience_ids.length} experiences · aliases: ${o.aliases.join(' | ')}`)
  }

  lines.push('', `CONFLICTS (${plan.conflicts.length})`)
  if (plan.conflicts.length === 0) lines.push('  (none)')
  for (const c of plan.conflicts) {
    lines.push(`  ${c.entity_type} ${c.entity_id} · ${c.field}: ${c.candidates.map((k) => `"${clip(k.value, 60)}" (${k.source_label})`).join(' vs ')}`)
  }

  lines.push('', `SOURCES TO CREATE (${plan.provenance.sources_to_create.length})`)
  for (const src of plan.provenance.sources_to_create) lines.push(`  ${pad(src.kind, 18)} ${src.label} (${src.count} rows)`)

  lines.push('', `CANONICAL SUMMARIES THAT WOULD CHANGE (${plan.summaries.length})`)
  for (const sm of plan.summaries) lines.push(`  ${clip(sm.label, 60)}`, `    → ${sm.summary}`)

  if (plan.suppressed.length) {
    lines.push('', `KEPT SEPARATE BY THE USER (${plan.suppressed.length})`)
    for (const p of plan.suppressed) lines.push(`  ${p.entity_type} ${p.keep_id} / ${p.merge_id}`)
  }

  lines.push('', `WARNINGS (${plan.warnings.length})`)
  if (plan.warnings.length === 0) lines.push('  (none)')
  for (const w of plan.warnings) lines.push(`  - ${w}`)
  return lines.join('\n')
}

export function planToJson(plan: ConsolidationPlan): string {
  return JSON.stringify(plan, null, 2)
}
