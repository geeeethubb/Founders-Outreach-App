'use client'

// Reply and follow-up, for one outreach.
//
// Both agents produce suggestions only. Nothing here has a code path that sends
// — the suggested reply is copy for the user to send from the thread they are
// already in, and the follow-up is a proposal with a date attached.

import { useState } from 'react'
import Link from 'next/link'
import { GroundingReport, type Grounding } from '../scout/OutreachPanel'

export interface ReplyState {
  id: string
  repliedAt: string | null
  /** The Conversations thread this reply lives in, once linked. */
  conversationId: string | null
  replyClassification: string | null
  replyAction: string | null
  replySummary: string | null
  suggestedReply: {
    subject: string | null
    body: string | null
    confidence: number
    reasoning: string
    grounding: Grounding | null
  } | null
  followupCount: number
  followupSuggestion: {
    should_follow_up: boolean
    rationale: string
    send_after_days: number | null
    subject: string | null
    body: string | null
    new_value: string | null
    grounding: Grounding | null
  } | null
  outcome: string | null
  /** Widened here on purpose: the conversation route returns the new state as a
   *  string and the queue owns the union. */
  state: string
}

export type ReplyPatch = Partial<Omit<ReplyState, 'state'>> & { state?: string }

const OUTCOMES = [
  'NO_RESPONSE',
  'REPLIED',
  'CALL_BOOKED',
  'REFERRED',
  'RESUME_REQUESTED',
  'PROJECT_DISCUSSION',
  'INTERNSHIP_DISCUSSION',
  'OPPORTUNITY_CREATED',
  'NOT_INTERESTED',
]

const CLASSIFICATION_STYLE: Record<string, string> = {
  MEETING_REQUEST: 'bg-emerald-100 text-emerald-800',
  POSITIVE: 'bg-emerald-50 text-emerald-700',
  REFERRAL: 'bg-teal-100 text-teal-800',
  QUESTION: 'bg-sky-100 text-sky-800',
  NOT_NOW: 'bg-amber-100 text-amber-800',
  NO_FIT: 'bg-slate-200 text-slate-700',
  NEGATIVE: 'bg-red-100 text-red-800',
  NEUTRAL: 'bg-slate-100 text-slate-600',
  OTHER: 'bg-slate-100 text-slate-600',
}

export default function ReplyPanel({
  row,
  onChange,
}: {
  row: ReplyState
  onChange(patch: Partial<ReplyState>): void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [replyText, setReplyText] = useState<string | null>(null)

  async function interpret() {
    setBusy('interpret')
    setError(null)
    try {
      const res = await fetch(`/api/outreach/${row.id}/conversation`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setReplyText(data.reply?.body ?? null)
      onChange({
        replyClassification: data.verdict.classification,
        replyAction: data.verdict.action,
        replySummary: data.verdict.summary,
        suggestedReply: {
          subject: data.verdict.suggested_subject,
          body: data.verdict.suggested_body,
          confidence: data.verdict.confidence,
          reasoning: data.verdict.reasoning,
          grounding: data.grounding,
        },
        state: data.state,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  async function suggestFollowUp() {
    setBusy('followup')
    setError(null)
    try {
      const res = await fetch(`/api/outreach/${row.id}/followup`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      onChange({
        followupCount: row.followupCount + 1,
        followupSuggestion: { ...data.suggestion, grounding: data.grounding },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  async function setOutcome(outcome: string) {
    setBusy('outcome')
    setError(null)
    try {
      const res = await fetch(`/api/outreach/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'outcome', outcome }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      onChange({ outcome })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  const sent = ['sent', 'replied', 'meeting', 'referred', 'closed'].includes(row.state)
  if (!sent) return null

  return (
    <div className="mt-3 border-t border-slate-200 pt-3 space-y-3">
      {/* ─── Reply ─────────────────────────────────────────────────── */}
      {row.repliedAt ? (
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Reply</span>
            <span className="text-xs text-slate-500">
              {new Date(row.repliedAt).toLocaleString()}
            </span>
            {row.replyClassification && (
              <span
                className={`px-2 py-0.5 text-[11px] font-medium rounded ${
                  CLASSIFICATION_STYLE[row.replyClassification] ?? 'bg-slate-100 text-slate-600'
                }`}
              >
                {row.replyClassification}
              </span>
            )}
            {row.replyAction && (
              <span className="px-2 py-0.5 text-[11px] rounded bg-slate-100 text-slate-600">
                next: {row.replyAction}
              </span>
            )}
            <button
              onClick={interpret}
              disabled={!!busy}
              className="ml-auto px-2.5 py-1 text-xs rounded-md bg-white border border-slate-300 hover:bg-slate-50 disabled:text-slate-300"
            >
              {busy === 'interpret'
                ? 'Reading…'
                : row.replyClassification
                  ? 'Re-interpret'
                  : 'Interpret reply'}
            </button>
          </div>

          {row.replySummary && <p className="mt-1 text-sm text-slate-700">{row.replySummary}</p>}

          {replyText && (
            <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-600 bg-slate-50 rounded p-3 max-h-48 overflow-auto">
              {replyText}
            </pre>
          )}

          {row.suggestedReply?.body && (
            <div className="mt-2 rounded border border-sky-200 bg-sky-50 p-3">
              <div className="text-xs font-medium text-sky-800">
                Suggested response — confidence{' '}
                {(row.suggestedReply.confidence * 100).toFixed(0)}%
              </div>
              {row.suggestedReply.subject && (
                <div className="mt-1 text-xs text-slate-600">
                  Subject: {row.suggestedReply.subject}
                </div>
              )}
              <pre className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
                {row.suggestedReply.body}
              </pre>
              <div className="mt-2">
                <GroundingReport grounding={row.suggestedReply.grounding} />
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Not sent from here — open the thread, paste or edit, and send.
                {row.conversationId && (
                  <>
                    {' '}
                    <Link
                      href={`/dashboard/conversations/${row.conversationId}`}
                      className="text-indigo-600 hover:underline"
                    >
                      Open the thread to reply →
                    </Link>
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">No reply yet.</span>
          {row.followupCount === 0 && (
            <button
              onClick={suggestFollowUp}
              disabled={!!busy}
              className="px-2.5 py-1 text-xs rounded-md bg-white border border-slate-300 hover:bg-slate-50 disabled:text-slate-300"
            >
              {busy === 'followup' ? 'Thinking…' : 'Suggest a follow-up'}
            </button>
          )}
          {row.followupCount > 0 && !row.followupSuggestion && (
            <span className="text-xs text-slate-400">Follow-up already considered.</span>
          )}
        </div>
      )}

      {/* ─── Follow-up ─────────────────────────────────────────────── */}
      {row.followupSuggestion && (
        <div
          className={`rounded border p-3 ${
            row.followupSuggestion.should_follow_up
              ? 'border-amber-200 bg-amber-50'
              : 'border-slate-200 bg-slate-50'
          }`}
        >
          <div className="text-xs font-medium text-slate-700">
            {row.followupSuggestion.should_follow_up
              ? `Follow-up suggested${row.followupSuggestion.send_after_days ? ` — day ${row.followupSuggestion.send_after_days}` : ''}`
              : 'Recommends NOT following up'}
          </div>
          <p className="mt-1 text-xs text-slate-600">{row.followupSuggestion.rationale}</p>
          {row.followupSuggestion.new_value && (
            <p className="mt-1 text-xs text-slate-600">
              <span className="font-medium">Adds:</span> {row.followupSuggestion.new_value}
            </p>
          )}
          {row.followupSuggestion.body && (
            <>
              <pre className="mt-2 whitespace-pre-wrap text-sm text-slate-800">
                {row.followupSuggestion.body}
              </pre>
              <div className="mt-2">
                <GroundingReport grounding={row.followupSuggestion.grounding} />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Not sent. One suggested follow-up per prospect, and this was it.
              </p>
            </>
          )}
        </div>
      )}

      {/* ─── Outcome ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Outcome</span>
        <select
          value={row.outcome ?? ''}
          onChange={(e) => e.target.value && setOutcome(e.target.value)}
          disabled={!!busy}
          className="text-xs rounded border border-slate-300 px-2 py-1"
        >
          <option value="">not recorded</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-slate-400">
          This is the ground truth a learning layer will need later.
        </span>
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
