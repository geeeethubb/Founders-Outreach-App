'use client'

import { useState } from 'react'
import Link from 'next/link'
import { api } from '@/components/career/api'
import InlineNotice from '@/components/career/InlineNotice'

interface ManualResult {
  jobId: string
  job: { title: string; company_name: string; verification_status: string; verification_note: string | null }
  warnings: string[]
}

/** Paste a posting URL. LinkedIn/Indeed cannot be read — the route says so with a 422, shown verbatim. */
export default function AddByUrl({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [added, setAdded] = useState<ManualResult | null>(null)

  async function submit() {
    if (!url.trim()) return
    setBusy(true)
    setError(null)
    setWarnings([])
    setAdded(null)
    const r = await api<ManualResult>('/api/career/jobs/manual', { json: { url: url.trim() } })
    setBusy(false)
    const w = (r.body?.warnings as string[] | undefined) ?? []
    if (!r.ok) {
      setError(r.error)
      setWarnings(w)
      return
    }
    setAdded(r.data)
    setWarnings(r.data?.warnings ?? [])
    setUrl('')
    onAdded()
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Add by URL — paste a company careers / ATS posting link"
          className="flex-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm"
        />
        <button type="button" onClick={submit} disabled={busy || !url.trim()} className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {busy ? 'Reading…' : 'Add'}
        </button>
      </div>
      {error && (
        <div className="mt-2">
          <InlineNotice kind="error">
            {error}
            {warnings.length > 0 && (
              <ul className="list-disc pl-5 mt-1 text-xs">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </InlineNotice>
        </div>
      )}
      {added && (
        <div className="mt-2">
          <InlineNotice kind="ok">
            Added <Link href={`/dashboard/jobs/${added.jobId}`} className="font-medium underline">{added.job.title}</Link> at {added.job.company_name} ·{' '}
            {added.job.verification_status.replace('_', ' ').toLowerCase()}
            {added.job.verification_note ? ` — ${added.job.verification_note}` : ''}
            {warnings.length > 0 && (
              <ul className="list-disc pl-5 mt-1 text-xs">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </InlineNotice>
        </div>
      )}
    </div>
  )
}
