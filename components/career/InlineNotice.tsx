'use client'

import type { ReactNode } from 'react'

export type NoticeKind = 'error' | 'ok' | 'info' | 'warn'

const STYLE: Record<NoticeKind, string> = {
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  info: 'border-slate-200 bg-slate-50 text-slate-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
}

/** Feedback lives next to the thing it is about. No toast library (CLAUDE.md). */
export default function InlineNotice({ kind = 'info', children, className = '' }: { kind?: NoticeKind; children: ReactNode; className?: string }) {
  return <div className={`rounded-md border px-3 py-2 text-sm ${STYLE[kind]} ${className}`}>{children}</div>
}

/** The one notice every Career OS page needs before migration 014 is applied. */
export function MigrationNotice() {
  return (
    <InlineNotice kind="warn">
      <div className="font-medium">The Career OS tables do not exist yet.</div>
      <ol className="mt-1 list-decimal space-y-0.5 pl-5">
        <li>
          Apply <code className="rounded bg-white px-1">supabase/migrations/014_career_os.sql</code> then{' '}
          <code className="rounded bg-white px-1">015_evidence_canonical.sql</code> in the Supabase SQL editor.
        </li>
        <li>
          Run <code className="rounded bg-white px-1">npm run career:seed -- --approve</code> to import the master résumé.
        </li>
      </ol>
    </InlineNotice>
  )
}
