'use client'

import Link from 'next/link'
import type { JobDetail } from '@/components/career/packageTypes'

const RELATIONSHIP_LABEL: Record<string, string> = {
  current_employee: 'works there',
  former_employee: 'used to work there',
  alumni: 'alumni',
  founder: 'founder',
  investor: 'investor',
  mentor: 'mentor',
  prior_outreach: 'prior outreach',
  second_degree: 'second degree',
  portfolio: 'portfolio',
  other: 'other',
}

/**
 * People you already know who can help with this job. Nothing here sends
 * anything — outreach goes through the Outreach queue with approval, as
 * always (CLAUDE.md principle 10).
 */
export default function WarmPathsTab({ paths, busy, onFind }: { paths: JobDetail['warm_paths']; busy: boolean; onFind: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        Suggested actions are suggestions. Outreach happens through the{' '}
        <Link href="/dashboard/outreach" className="text-indigo-600 hover:underline">
          Outreach queue
        </Link>{' '}
        with your approval — nothing here sends.
      </p>
      {paths.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-slate-700 font-medium">No warm paths found yet.</p>
          <p className="text-sm text-slate-500 mt-1 mb-3">Searches your contacts and past outreach for anyone connected to this company.</p>
          <button type="button" onClick={onFind} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {busy ? 'Searching…' : 'Find warm paths'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {paths.map((p) => (
            <div key={p.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link href={`/dashboard/contacts/${p.contact_id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                    {p.contact?.name ?? 'Unnamed contact'}
                  </Link>
                  <span className="text-sm text-slate-500">
                    {p.contact?.title ? ` · ${p.contact.title}` : ''}
                    {p.contact?.company ? ` @ ${p.contact.company}` : ''}
                  </span>
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded border bg-violet-50 text-violet-700 border-violet-200">
                    {RELATIONSHIP_LABEL[p.relationship] ?? p.relationship}
                  </span>
                </div>
                <div className="w-28 shrink-0" title={`strength ${Math.round(p.strength * 100)}%`}>
                  <div className="h-1.5 rounded bg-slate-100 overflow-hidden">
                    <div className="h-1.5 bg-violet-500" style={{ width: `${Math.round(Math.max(0, Math.min(1, p.strength)) * 100)}%` }} />
                  </div>
                  <div className="text-[10px] text-slate-400 text-right">strength {Math.round(p.strength * 100)}%</div>
                </div>
              </div>
              {p.why_relevant && <p className="text-sm text-slate-700 mt-1.5">{p.why_relevant}</p>}
              {p.existing_history && (
                <p className="text-xs text-slate-500 mt-1">
                  <span className="font-medium text-slate-600">History:</span> {p.existing_history}
                </p>
              )}
              {p.suggested_action && (
                <p className="text-xs text-indigo-700 mt-1">
                  <span className="font-medium">Suggested:</span> {p.suggested_action}
                </p>
              )}
              {p.retrieval_basis?.length ? <p className="text-[11px] text-slate-400 mt-1">found via {p.retrieval_basis.join(', ')}</p> : null}
            </div>
          ))}
          <button type="button" onClick={onFind} disabled={busy} className="text-xs text-indigo-600 hover:underline disabled:opacity-50">
            {busy ? 'Searching…' : 'Search again'}
          </button>
        </div>
      )}
    </div>
  )
}
