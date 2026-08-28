'use client'

import { useState } from 'react'
import { formatRelativeTime } from '@/lib/utils'
import { api } from './api'

const STYLE: Record<string, { cls: string; label: string }> = {
  VERIFIED_OPEN: { cls: 'bg-emerald-100 text-emerald-800 border-emerald-200', label: 'Verified open' },
  LIKELY_OPEN: { cls: 'bg-sky-100 text-sky-800 border-sky-200', label: 'Likely open' },
  UNVERIFIED: { cls: 'bg-slate-100 text-slate-600 border-slate-200', label: 'Unverified' },
  STALE: { cls: 'bg-amber-100 text-amber-800 border-amber-200', label: 'Stale' },
  CLOSED: { cls: 'bg-rose-100 text-rose-800 border-rose-200', label: 'Closed' },
  ERROR: { cls: 'bg-rose-50 text-rose-700 border-rose-200', label: 'Check failed' },
}

export interface VerifyOutcome {
  status: string
  note: string | null
  last_verified_at: string | null
  changed: boolean
  from: string
}

/**
 * "Is it open?" — the badge plus an optional re-check that POSTs the verify
 * route. The parent owns the job state, so the result is handed back rather
 * than kept here: a refresh must show the same answer as the click did.
 */
export default function VerificationBadge({
  status,
  note,
  lastVerifiedAt,
  jobId,
  onVerified,
}: {
  status: string
  note?: string | null
  lastVerifiedAt?: string | null
  jobId?: string
  onVerified?: (o: VerifyOutcome) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const s = STYLE[status] ?? STYLE.UNVERIFIED

  async function recheck() {
    if (!jobId) return
    setBusy(true)
    setErr(null)
    const r = await api<VerifyOutcome>(`/api/career/jobs/${jobId}/verify`, { method: 'POST' })
    setBusy(false)
    if (!r.ok || !r.data) {
      setErr(r.error)
      return
    }
    onVerified?.(r.data)
  }

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span title={note ?? undefined} className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${s.cls}`}>
        {s.label}
      </span>
      {lastVerifiedAt && (
        <span className="text-[11px] text-slate-400">checked {formatRelativeTime(lastVerifiedAt).toLowerCase()}</span>
      )}
      {jobId && (
        <button type="button" onClick={recheck} disabled={busy} className="text-[11px] text-indigo-600 hover:underline disabled:opacity-50">
          {busy ? 'checking…' : 're-check'}
        </button>
      )}
      {err && <span className="text-[11px] text-rose-600">{err}</span>}
    </span>
  )
}
