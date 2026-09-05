'use client'

// "Can this scout run here?" — shown before anyone pays for a run.
//
// GET /api/scout/readiness answers a verdict per scout kind. A blocking reason
// is rendered loudly with the fix beside it and the page disables its start
// button; warnings (Apollo missing, cron secret unset) are a soft notice. The
// page decides what to do when the check itself cannot be made — this only
// says so.

import InlineNotice from './InlineNotice'

export interface KindReadinessLike {
  ready: boolean
  reason: string | null
  remedy: string | null
  code?: string | null
  warnings: string[]
}

export default function ReadinessNotice({
  readiness,
  loading,
  error,
  what = 'Scouting',
  onRecheck,
}: {
  readiness: KindReadinessLike | null
  loading: boolean
  /** The readiness check itself failed (network, signed out). */
  error: string | null
  what?: string
  onRecheck?: () => void
}) {
  if (loading && !readiness) return <p className="text-xs text-slate-500">Checking whether {what.toLowerCase()} can run here…</p>

  if (error && !readiness) {
    return (
      <InlineNotice kind="warn">
        Could not check whether {what.toLowerCase()} can run here: {error}. The server checks again when a run starts.
        {onRecheck && (
          <button type="button" onClick={onRecheck} className="ml-2 underline">
            Check again
          </button>
        )}
      </InlineNotice>
    )
  }

  if (!readiness) return null

  return (
    <div className="space-y-2">
      {!readiness.ready && (
        <InlineNotice kind="error">
          <div className="font-medium">
            {what} is unavailable: {readiness.reason ?? 'the server did not say why'}
            {readiness.code ? <span className="ml-1 font-mono text-xs opacity-70">[{readiness.code}]</span> : null}
          </div>
          <div className="mt-1">Fix: {readiness.remedy ?? 'see the server logs for the failing check.'}</div>
          {onRecheck && (
            <button type="button" onClick={onRecheck} className="mt-1 text-xs underline">
              Check again
            </button>
          )}
        </InlineNotice>
      )}
      {readiness.warnings.length > 0 && (
        <InlineNotice kind="warn">
          <ul className="space-y-0.5">
            {readiness.warnings.map((w, i) => (
              <li key={i}>· {w}</li>
            ))}
          </ul>
        </InlineNotice>
      )}
    </div>
  )
}
