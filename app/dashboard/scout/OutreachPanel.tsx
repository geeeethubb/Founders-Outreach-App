'use client'

// The approval surface for one prospect.
//
// Approve and Send are two buttons, never one. Approving is reversible and
// cheap; sending puts mail in a stranger's inbox under the user's name. Merging
// them would put the irreversible action one mis-click from the reversible one.
//
// Every decision here is a server round-trip. Nothing is client state, because
// the whole point of this phase is that a refresh does not lose the decision.

import { useState } from 'react'

export interface GroundingFinding {
  severity: 'blocking' | 'warning'
  kind: string
  claim: string
  sentence: string
  reason: string
  revision: string
}

export interface Grounding {
  ok: boolean
  blocking: GroundingFinding[]
  warnings: GroundingFinding[]
  stats: { evidenceItems: number; quantitiesChecked: number; entitiesChecked: number }
}

export type OutreachState =
  | 'draft' | 'ready_for_review' | 'approved' | 'skipped' | 'sending'
  | 'sent' | 'failed' | 'replied' | 'meeting' | 'referred' | 'closed'

export interface OutreachSnapshot {
  id: string
  state: OutreachState
  subject: string
  body: string
  wordCount: number | null
  grounding: Grounding | null
  sentAt?: string | null
  sendError?: string | null
  recipientEmail?: string | null
}

const STATE_LABEL: Record<OutreachState, string> = {
  draft: 'DRAFT',
  ready_for_review: 'READY FOR REVIEW',
  approved: 'APPROVED',
  skipped: 'SKIPPED',
  sending: 'SENDING…',
  sent: 'SENT',
  failed: 'SEND FAILED',
  replied: 'REPLIED',
  meeting: 'MEETING',
  referred: 'REFERRED',
  closed: 'CLOSED',
}

const STATE_STYLE: Record<OutreachState, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  ready_for_review: 'bg-sky-100 text-sky-800 border-sky-200',
  approved: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  skipped: 'bg-slate-200 text-slate-600 border-slate-300',
  sending: 'bg-amber-100 text-amber-800 border-amber-200',
  sent: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
  replied: 'bg-violet-100 text-violet-800 border-violet-200',
  meeting: 'bg-emerald-200 text-emerald-900 border-emerald-300',
  referred: 'bg-teal-100 text-teal-800 border-teal-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200',
}

/** DRAFT → APPROVED → SENT → REPLIED, with the current step marked. */
export function StateTrail({ state }: { state: OutreachState }) {
  const trail: OutreachState[] = ['draft', 'approved', 'sent', 'replied']
  const reached = (s: OutreachState) => {
    const order: OutreachState[] = ['draft', 'ready_for_review', 'approved', 'sending', 'sent', 'replied', 'meeting', 'referred', 'closed']
    return order.indexOf(state) >= order.indexOf(s)
  }
  return (
    <div className="flex items-center gap-1 text-[11px] tracking-wide">
      {trail.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-300">→</span>}
          <span className={reached(s) ? 'font-semibold text-slate-800' : 'text-slate-300'}>
            {STATE_LABEL[s]}
          </span>
        </span>
      ))}
    </div>
  )
}

export function StateBadge({ state }: { state: OutreachState }) {
  return (
    <span className={`px-2 py-0.5 text-[11px] font-medium rounded border ${STATE_STYLE[state]}`}>
      {STATE_LABEL[state]}
    </span>
  )
}

export function GroundingReport({ grounding }: { grounding: Grounding | null }) {
  if (!grounding) return null

  if (grounding.ok && grounding.warnings.length === 0) {
    return (
      <p className="text-xs text-emerald-700">
        ✓ Claim check passed — {grounding.stats.quantitiesChecked} figures and{' '}
        {grounding.stats.entitiesChecked} names resolve to stored evidence.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {grounding.blocking.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-3">
          <div className="text-xs font-semibold text-red-800">
            {grounding.blocking.length} unsupported claim
            {grounding.blocking.length === 1 ? '' : 's'} — this cannot be approved or sent
          </div>
          <ul className="mt-2 space-y-2">
            {grounding.blocking.map((f, i) => (
              <li key={i} className="text-xs text-red-900">
                <span className="font-medium">“{f.claim}”</span> — {f.reason}
                <div className="mt-0.5 text-red-700">Suggested fix: {f.revision}</div>
                <div className="mt-0.5 italic text-red-600">in: {f.sentence}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {grounding.warnings.length > 0 && (
        <details className="text-xs text-amber-800">
          <summary className="cursor-pointer">
            {grounding.warnings.length} warning{grounding.warnings.length === 1 ? '' : 's'} (not blocking)
          </summary>
          <ul className="mt-1 space-y-1 pl-4">
            {grounding.warnings.map((f, i) => (
              <li key={i}>
                “{f.claim}” — {f.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

interface Props {
  outreach: OutreachSnapshot
  onChange(next: OutreachSnapshot): void
  /** Rendered under the buttons — the alternate angle, cost, etc. */
  footnote?: React.ReactNode
}

export default function OutreachPanel({ outreach, onChange, footnote }: Props) {
  const [body, setBody] = useState(outreach.body)
  const [subject, setSubject] = useState(outreach.subject)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmSend, setConfirmSend] = useState(false)

  const dirty = body !== outreach.body || subject !== outreach.subject
  const locked = ['sending', 'sent', 'replied', 'meeting', 'referred', 'closed'].includes(outreach.state)
  const blocked = outreach.grounding ? !outreach.grounding.ok : false

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/outreach/${outreach.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const data = await res.json()
      if (!res.ok) {
        // A gate rejection still carries the findings — show them rather than
        // just the message, or the user cannot act on it.
        if (data.grounding) {
          onChange({ ...outreach, grounding: data.grounding, state: data.grounding.ok ? outreach.state : 'draft' })
        }
        throw new Error(data.error || 'Failed')
      }
      onChange({
        ...outreach,
        state: data.outreach.state,
        body: data.outreach.body_edited ?? data.outreach.body,
        subject: data.outreach.subject,
        wordCount: data.outreach.word_count,
        grounding: data.grounding ?? data.outreach.grounding ?? outreach.grounding,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  async function send() {
    setBusy('send')
    setError(null)
    try {
      const res = await fetch(`/api/outreach/${outreach.id}/send`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        if (data.grounding) onChange({ ...outreach, grounding: data.grounding })
        throw new Error(data.error || 'Send failed')
      }
      onChange({
        ...outreach,
        state: data.outreach?.state ?? 'sent',
        sentAt: data.outreach?.sent_at ?? new Date().toISOString(),
        sendError: null,
      })
      setConfirmSend(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border border-slate-200 rounded p-3">
      <div className="flex items-center justify-between gap-3">
        <StateBadge state={outreach.state} />
        <StateTrail state={outreach.state} />
      </div>

      <div className="mt-3 text-sm">
        <label className="text-slate-500 text-xs">Subject</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={locked}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:bg-slate-50 disabled:text-slate-500"
        />
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={locked}
        rows={9}
        className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
      />
      <div className="mt-1 text-xs text-slate-500">
        {body.trim().split(/\s+/).filter(Boolean).length} words
        {dirty && !locked && <span className="ml-2 text-amber-700">unsaved changes</span>}
      </div>

      <div className="mt-3">
        <GroundingReport grounding={outreach.grounding} />
      </div>

      {outreach.sendError && (
        <p className="mt-2 text-xs text-red-700">Last send failed: {outreach.sendError}</p>
      )}

      {!locked && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => act('edit', { body, subject })}
            disabled={!dirty || !!busy}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:text-slate-300"
          >
            {busy === 'edit' ? 'Saving…' : 'Save edit'}
          </button>

          {outreach.state !== 'approved' ? (
            <button
              onClick={() => act('approve')}
              disabled={!!busy || dirty || blocked}
              title={
                dirty ? 'Save your edit first' : blocked ? 'Unsupported claims must be fixed first' : ''
              }
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          ) : (
            <button
              onClick={() => act('unapprove')}
              disabled={!!busy}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
            >
              Approved — undo
            </button>
          )}

          <button
            onClick={() => act('skip')}
            disabled={!!busy}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            {outreach.state === 'skipped' ? 'Skipped' : 'Skip'}
          </button>

          {outreach.state === 'approved' &&
            (confirmSend ? (
              <span className="flex items-center gap-2 ml-auto">
                <span className="text-xs text-slate-600">
                  Send to {outreach.recipientEmail ?? 'this contact'}?
                </span>
                <button
                  onClick={send}
                  disabled={!!busy}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 text-white hover:bg-slate-700"
                >
                  {busy === 'send' ? 'Sending…' : 'Yes, send now'}
                </button>
                <button
                  onClick={() => setConfirmSend(false)}
                  className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmSend(true)}
                disabled={!!busy || !outreach.recipientEmail}
                title={outreach.recipientEmail ? '' : 'No email address on record for this contact'}
                className="ml-auto px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-200 disabled:text-slate-400"
              >
                Send
              </button>
            ))}

          {outreach.state === 'failed' && (
            <button
              onClick={send}
              disabled={!!busy}
              className="ml-auto px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 text-white hover:bg-slate-700"
            >
              {busy === 'send' ? 'Retrying…' : 'Retry send'}
            </button>
          )}
        </div>
      )}

      {locked && outreach.sentAt && (
        <p className="mt-3 text-xs text-slate-500">
          Sent {new Date(outreach.sentAt).toLocaleString()}. The draft is frozen so the record keeps
          matching what they read.
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      {footnote && <div className="mt-2 text-xs text-slate-500">{footnote}</div>}
    </div>
  )
}
