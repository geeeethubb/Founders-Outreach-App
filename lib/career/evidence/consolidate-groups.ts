// Organization groups, provenance gaps and canonical summaries — the parts of
// a ConsolidationPlan that describe the bank rather than propose merges.
// Pure; split out of consolidate.ts to keep that file under 400 lines.

import type { EvidenceBank, EvidenceExperience, OrganizationKind } from '../types'
import type { ConsolidationPlan, OrganizationProposal, ProvenanceProposal } from './consolidate-types'
import { orgHead, orgKey } from './consolidate-rules'
import { normalizeOrg } from './normalize'
import { sourceKindFor, splitSourceLocation } from './sources'
import { buildCanonicalSummary } from './summary'

const active = <T extends { status?: string }>(rows: T[]): T[] => rows.filter((r) => (r.status ?? 'active') === 'active')

function experienceLabelShort(e: EvidenceExperience): string {
  const dates = [e.start_date, e.end_date].filter(Boolean).join('–')
  return `${e.organization} | ${e.title}${dates ? ` | ${dates}` : ''}`
}

// ─── Organizations, provenance, summaries ────────────────────────────────────

export function organizationKindFor(name: string): OrganizationKind {
  const s = name.toLowerCase()
  if (/\b(university|college|academy|school)\b/.test(s) && !/school of/.test(s)) return 'university'
  if (/\b(lab|laboratory|national laboratory)\b/.test(s)) return 'lab'
  if (/\b(consulting|entrepreneurs|club|council|society|association)\b/.test(s)) return 'student_org'
  if (/\b(accelerator|program|programme|school of|fellow|fellowship|incubator)\b/.test(s)) return 'program'
  return 'company'
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | null = null
  let n = 0
  for (const [v, c] of [...counts.entries()].sort()) if (c > n) { best = v; n = c }
  return best
}

export function planOrganizations(bank: EvidenceBank): OrganizationProposal[] {
  const byKey = new Map<string, EvidenceExperience[]>()
  for (const e of active(bank.experiences)) byKey.set(orgKey(e.organization), [...(byKey.get(orgKey(e.organization)) ?? []), e])
  const existing = new Map(bank.organizations.map((o) => [o.normalized_name, o.id]))
  return [...byKey.entries()].sort().map(([key, rows]) => {
    const master = rows.filter((r) => r.source === 'master_resume').map((r) => orgHead(r.organization))
    const canonical = mostCommon(master) ?? mostCommon(rows.map((r) => orgHead(r.organization))) ?? rows[0].organization
    return {
      canonical_name: canonical,
      normalized_name: key,
      aliases: [...new Set(rows.map((r) => r.organization.trim()))].sort(),
      experience_ids: rows.map((r) => r.id),
      existing_id: existing.get(key) ?? existing.get(normalizeOrg(canonical)) ?? null,
    }
  })
}

export function planProvenance(bank: EvidenceBank): ProvenanceProposal {
  const covered = new Set(bank.factSources.map((fs) => fs.fact_id))
  const coveredExp = new Set((bank.experienceSources ?? []).map((es) => es.experience_id))
  const facts = active(bank.facts).filter((f) => !covered.has(f.id)).map((f) => {
    const { label, location } = splitSourceLocation(f.source, f.source_location)
    return { fact_id: f.id, source: label, source_location: location }
  })
  const experiences = active(bank.experiences).filter((e) => !coveredExp.has(e.id)).map((e) => ({ experience_id: e.id, source: e.source }))
  const counts = new Map<string, { label: string; kind: string; count: number }>()
  const bump = (label: string, kind: string) => {
    const k = `${kind}:${label}`
    const cur = counts.get(k) ?? { label, kind, count: 0 }
    cur.count++
    counts.set(k, cur)
  }
  for (const f of active(bank.facts)) if (!covered.has(f.id)) bump(splitSourceLocation(f.source, f.source_location).label, sourceKindFor(f.source))
  for (const e of experiences) bump(e.source, sourceKindFor(e.source))
  return { facts_missing_provenance: facts, experiences_missing_provenance: experiences, sources_to_create: [...counts.values()].sort((a, b) => a.label.localeCompare(b.label)) }
}

export function planSummaries(bank: EvidenceBank): ConsolidationPlan['summaries'] {
  return active(bank.experiences)
    .filter((e) => !e.edited_by_user)
    .map((e) => {
      const { summary } = buildCanonicalSummary(bank, e.id)
      return { experience_id: e.id, label: experienceLabelShort(e), summary, changed: summary !== (e.canonical_summary ?? '') }
    })
    .filter((s) => s.changed && s.summary.length > 0)
}

