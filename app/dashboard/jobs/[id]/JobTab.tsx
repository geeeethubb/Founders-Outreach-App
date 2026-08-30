'use client'

import { useState } from 'react'
import type { JobDetail } from '@/components/career/packageTypes'
import { fmtDate } from '@/components/career/api'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800 mt-0.5">{children}</dd>
    </div>
  )
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items?.length) return <p className="text-xs text-slate-400">{empty}</p>
  return (
    <ul className="list-disc pl-5 text-sm text-slate-700 space-y-0.5">
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  )
}

export default function JobTab({ detail }: { detail: JobDetail }) {
  const [showDesc, setShowDesc] = useState(false)
  const j = detail.job
  const desc = j.description_text ?? detail.snapshot?.description_text ?? null

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Field label="Location">
          {j.location_raw ?? '—'}
          {j.location_tier ? <span className="text-slate-500"> · tier {j.location_tier}</span> : null}
          {j.work_mode && j.work_mode !== 'unknown' ? <span className="text-slate-500"> · {j.work_mode}</span> : null}
        </Field>
        <Field label="Type / season">
          {j.employment_type.replace('_', '-')} · {j.season_relevance.replace('_', ' ')}
          {j.role_family ? <span className="text-slate-500"> · {j.role_family}</span> : null}
        </Field>
        <Field label="Dates">
          posted {fmtDate(j.posted_at)} · deadline {fmtDate(j.deadline)}
          <span className="text-slate-500"> · first seen {fmtDate(j.first_seen_at)}</span>
        </Field>
        {/* The status badge (with re-check) is in the page header; this is only the verifier's note. */}
        <Field label="Is it open?">
          {j.verification_note ? <p className="text-xs text-slate-500">{j.verification_note}</p> : <span className="text-slate-400">see the badge above</span>}
        </Field>
        <Field label="Links">
          <div className="flex flex-wrap gap-3">
            {j.canonical_url ? (
              <a href={j.canonical_url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                Posting ↗
              </a>
            ) : (
              <span className="text-slate-400">no canonical page (lead only)</span>
            )}
            {j.apply_url && j.apply_url !== j.canonical_url && (
              <a href={j.apply_url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                Apply ↗
              </a>
            )}
          </div>
        </Field>
        <Field label="Compensation">{j.compensation ?? '—'}</Field>
        {j.graduation_eligibility && <Field label="Graduation eligibility (verbatim)">{j.graduation_eligibility}</Field>}
        {j.work_authorization && <Field label="Work authorization (verbatim)">{j.work_authorization}</Field>}
        {j.industry && <Field label="Industry">{j.industry}</Field>}
      </dl>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Minimum qualifications</h3>
          <List items={j.min_qualifications ?? []} empty="None extracted." />
        </div>
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Preferred qualifications</h3>
          <List items={j.preferred_qualifications ?? []} empty="None extracted." />
        </div>
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Responsibilities</h3>
          <List items={j.responsibilities ?? []} empty="None extracted." />
        </div>
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Skills named</h3>
          {j.skills?.length ? (
            <div className="flex flex-wrap gap-1">
              {j.skills.map((s) => (
                <span key={s} className="text-[11px] px-1.5 py-0.5 rounded border bg-slate-50 text-slate-600 border-slate-200">
                  {s}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">None extracted.</p>
          )}
        </div>
      </div>

      <div>
        <button type="button" onClick={() => setShowDesc((s) => !s)} className="text-sm text-indigo-600 hover:underline">
          {showDesc ? 'Hide description' : 'Show full description'}
        </button>
        {showDesc && (
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-slate-700 rounded-md border border-slate-200 bg-slate-50 p-3 max-h-[32rem] overflow-y-auto">
            {desc ?? 'No description text was captured.'}
          </pre>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium text-slate-900 mb-1">Sources</h3>
        {detail.sources.length === 0 ? (
          <p className="text-xs text-slate-400">No source rows.</p>
        ) : (
          <ul className="text-xs text-slate-600 space-y-0.5">
            {detail.sources.map((s) => (
              <li key={s.id}>
                <span className="font-medium text-slate-800">{s.source_type}</span>
                {s.source_url ? (
                  <>
                    {' '}
                    ·{' '}
                    <a href={s.source_url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all">
                      {s.source_url}
                    </a>
                  </>
                ) : null}
                <span className="text-slate-400"> · {fmtDate(s.discovered_at)}</span>
              </li>
            ))}
          </ul>
        )}
        {j.extraction_confidence !== null && (
          <p className="text-[11px] text-slate-400 mt-1">
            extraction confidence {Math.round((j.extraction_confidence ?? 0) * 100)}% · {j.extraction_version ?? '—'}
          </p>
        )}
      </div>
    </div>
  )
}
