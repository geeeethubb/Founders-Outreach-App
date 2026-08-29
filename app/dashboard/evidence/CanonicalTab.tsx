'use client'

// The bank as one canonical tree: organization → role → projects / key facts /
// metrics. Read-only and scannable; edits happen on the Experiences tab.

import { useEffect, useState } from 'react'
import { Chip, KIND_TONE, Notice, SourceChip, StatusBadge } from './shared'
import type { CanonicalFact, CanonicalOrganization, CanonicalRole, CanonicalView } from '@/app/api/career/evidence/canonical/build'

export interface CanonicalResponse extends CanonicalView {
  migration015: boolean
  migrationMissing?: boolean
  errors?: string[]
  error?: string
}

const ORG_TONE: Record<string, 'slate' | 'indigo' | 'emerald' | 'amber' | 'sky' | 'violet'> = {
  company: 'indigo', university: 'emerald', lab: 'sky', student_org: 'violet', program: 'amber', other: 'slate',
}

export default function CanonicalTab({ onExperiences }: { onExperiences: () => void }) {
  const [data, setData] = useState<CanonicalResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/career/evidence/canonical')
      .then(async (res) => {
        const body = (await res.json()) as CanonicalResponse
        if (!res.ok && !body.migrationMissing) throw new Error(body.error || `Failed (${res.status})`)
        if (!cancelled) setData(body)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load') })
    return () => { cancelled = true }
  }, [])

  if (error) return <Notice kind="error">{error}</Notice>
  if (!data) return <div className="text-sm text-slate-500">Loading…</div>
  if (data.migrationMissing) return <Notice kind="error">{data.error || 'Apply supabase/migrations/014_career_os.sql first.'}</Notice>
  if (data.organizations.length === 0 && data.unattached.facts.length === 0) return <div className="text-sm text-slate-500">No experiences yet.</div>

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {data.organizations.length} organizations · {data.organizations.reduce((n, o) => n + o.roles.length, 0)} roles
          {!data.migration015 && ' · migration 015 not applied: grouped by normalized name, no provenance rows'}
        </span>
        <button type="button" onClick={onExperiences} className="font-medium text-indigo-600 hover:underline">edit on the Experiences tab →</button>
      </div>
      {data.errors && data.errors.length > 0 && <Notice kind="error">{data.errors.join(' · ')}</Notice>}
      {data.organizations.map((o) => <OrganizationCard key={o.id ?? o.canonical_name} org={o} />)}
      {data.unattached.facts.length > 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Facts not attached to an experience ({data.unattached.facts.length})</div>
          <FactList facts={data.unattached.facts} />
        </div>
      )}
      <div className="text-xs text-slate-400">Also in the bank: {data.unattached.skills} skills · {data.unattached.stories} stories (see their tabs).</div>
    </div>
  )
}

function OrganizationCard({ org }: { org: CanonicalOrganization }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400">{open ? '▾' : '▸'}</span>
          <span className="font-medium text-slate-900">{org.canonical_name}</span>
          <Chip tone={ORG_TONE[org.kind] ?? 'slate'}>{org.kind.replace('_', ' ')}</Chip>
          {org.aliases.length > 0 && <span className="text-xs text-slate-400" title={org.aliases.join(', ')}>also “{org.aliases[0]}”{org.aliases.length > 1 ? ` +${org.aliases.length - 1}` : ''}</span>}
        </div>
        <span className="text-xs text-slate-500">{org.roles.length} {org.roles.length === 1 ? 'role' : 'roles'}</span>
      </button>
      {open && (
        <div className="divide-y divide-slate-100 border-t border-slate-100">
          {org.roles.map((r) => <RoleBlock key={r.experience.id} role={r} />)}
        </div>
      )}
    </div>
  )
}

function RoleBlock({ role }: { role: CanonicalRole }) {
  const [all, setAll] = useState(false)
  const e = role.experience
  const shown = all ? role.allFacts : role.keyFacts
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-800">{e.title}</span>
        <Chip tone={KIND_TONE[e.kind] ?? 'slate'}>{e.kind}</Chip>
        {e.period && <span className="text-xs text-slate-500">{e.period}</span>}
        <StatusBadge status={e.merge_status} approved={e.approved} />
        <span className="text-[11px] text-slate-400">{e.source_count} {e.source_count === 1 ? 'source' : 'sources'}</span>
      </div>
      {e.canonical_summary && <p className="mt-1 text-sm text-slate-600">{e.canonical_summary}</p>}
      {role.projects.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {role.projects.map((p) => (
            <li key={p.id} className="text-sm text-slate-700">
              <span className="font-medium">{p.name}</span>
              {p.description && <span className="text-slate-500"> — {p.description}</span>}
              <span className="ml-1 text-[11px] text-slate-400">{p.factCount} facts</span>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{all ? 'All facts' : 'Key facts'}</div>
          <FactList facts={shown} />
        </div>
      )}
      {role.allFacts.length > role.keyFacts.length && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-[11px] font-medium text-indigo-600 hover:underline">
          {all ? 'Show key facts only' : `Show all facts (${role.allFacts.length})`}
        </button>
      )}
      {role.metrics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {role.metrics.map((m) => (
            <span key={m.id} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs">
              <span className="font-semibold text-slate-900">{m.value}</span>
              {m.unit && <span className="text-slate-600"> {m.unit}</span>}
              {m.context && <span className="text-slate-500"> — {m.context}</span>}
            </span>
          ))}
        </div>
      )}
      {role.sources.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-slate-400">
          sources: {role.sources.map((s) => <SourceChip key={s} label={s} />)}
        </div>
      )}
    </div>
  )
}

function FactList({ facts }: { facts: CanonicalFact[] }) {
  return (
    <ul className="mt-1 space-y-1">
      {facts.map((f) => (
        <li key={f.id} className="flex items-start gap-2 text-sm">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
          <span className="flex-1 text-slate-800">
            {f.statement}
            <span className="ml-1.5 inline-flex flex-wrap items-center gap-1 align-middle">
              {f.sources.map((s) => <SourceChip key={s} label={s} />)}
              {f.support_count > 1 && <Chip tone="emerald">×{f.support_count}</Chip>}
              {f.fact_status === 'CONFLICTING' && <Chip tone="amber">conflicting</Chip>}
              {!f.approved && <Chip tone="amber">pending</Chip>}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}
