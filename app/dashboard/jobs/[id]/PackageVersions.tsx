'use client'

import { useState } from 'react'
import type { PackageSummary } from '@/components/career/packageTypes'
import DocLinks, { documentsFromPaths } from '@/components/career/DocLinks'
import { fmtDate } from '@/components/career/api'

/** Older package versions, collapsed. Superseded ones are history; a locked one is the record of what was submitted. */
export default function PackageVersions({ packages }: { packages: PackageSummary[] }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="border-t border-slate-200 pt-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-slate-500 hover:text-slate-900">
        {open ? '▾' : '▸'} {packages.length} older version{packages.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {packages.map((p) => (
            <li key={p.id} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-700">v{p.version}</span>
                <span className={`px-1.5 py-0.5 rounded border ${p.status === 'locked' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                  {p.status.replace(/_/g, ' ')}
                </span>
                <span className="text-slate-400">{fmtDate(p.created_at)}</span>
                {p.error && <span className="text-rose-600">{p.error}</span>}
              </div>
              <div className="mt-1.5">
                <DocLinks documents={documentsFromPaths(p)} compact />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
