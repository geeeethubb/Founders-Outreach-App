'use client'

// The review queue.
//
// Everything on this page comes from the database, so it survives a refresh —
// which is the entire point of the phase. The scout page is where drafts are
// created; this is where they are decided on, sent, and tracked afterwards.

import { useCallback, useEffect, useState } from 'react'
import OutreachPanel, { StateBadge, type Grounding, type OutreachState } from '../scout/OutreachPanel'
import ReplyPanel, { type ReplyState } from './ReplyPanel'

interface Row extends ReplyState {
  id: string
  state: OutreachState
  name: string
  email: string | null
  title: string | null
  company: string | null
  subject: string | null
  body: string | null
  wordCount: number | null
  angle: string | null
  grounding: Grounding | null
  score: number | null
  sentAt: string | null
  sendError: string | null
}

interface Funnel {
  stages: { label: string; count: number; ofPrevious: number | null }[]
  bySegment: Breakdown[]
  byCta: Breakdown[]
  byLength: Breakdown[]
  byProofPoint: Breakdown[]
  outcomes: { outcome: string; count: number }[]
  medianDaysToReply: number | null
}

interface Breakdown {
  key: string
  drafted: number
  sent: number
  replies: number
  conversations: number
  replyRate: number | null
}

const GROUPS: { label: string; states: OutreachState[] }[] = [
  { label: 'Needs review', states: ['ready_for_review', 'draft'] },
  { label: 'Approved — ready to send', states: ['approved', 'failed'] },
  { label: 'Sent', states: ['sending', 'sent'] },
  { label: 'In conversation', states: ['replied', 'meeting', 'referred'] },
  { label: 'Closed and skipped', states: ['closed', 'skipped'] },
]

export default function OutreachPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [funnel, setFunnel] = useState<Funnel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/outreach?funnel=1')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load')
      setRows(data.outreach as Row[])
      setFunnel(data.funnel as Funnel)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function sync() {
    setSyncing(true)
    setSyncNote(null)
    try {
      const res = await fetch('/api/outreach/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Sync failed')
      // Diagnostics, always — "0 replies" has to be explainable.
      const bits = [
        `${data.newReplies} new repl${data.newReplies === 1 ? 'y' : 'ies'}`,
        `${data.outreach?.outreachChecked ?? 0} threads checked`,
      ]
      if (data.errors?.length) bits.push(data.errors.join('; '))
      setSyncNote(bits.join(' · '))
      await load()
    } catch (e) {
      setSyncNote(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  function patchRow(id: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Outreach</h1>
          <p className="text-sm text-slate-600 mt-1">
            Every draft, its approval state, and what happened after it went out. Nothing sends
            without you.
          </p>
        </div>
        <button
          onClick={sync}
          disabled={syncing}
          className="px-3 py-1.5 text-sm rounded-md bg-white border border-slate-300 hover:bg-slate-50 disabled:text-slate-300"
        >
          {syncing ? 'Syncing…' : 'Sync replies'}
        </button>
      </div>

      {syncNote && <p className="mt-2 text-xs text-slate-600">{syncNote}</p>}
      {error && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* ─── Funnel ──────────────────────────────────────────────────── */}
      {funnel && funnel.stages[1].count > 0 && (
        <div className="mt-6 rounded border border-slate-200 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Funnel</div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            {funnel.stages.map((s) => (
              <div key={s.label}>
                <div className="text-lg font-semibold text-slate-900">{s.count}</div>
                <div className="text-xs text-slate-500">{s.label}</div>
                {s.ofPrevious !== null && (
                  <div className="text-[11px] text-slate-400">
                    {(s.ofPrevious * 100).toFixed(0)}% of previous
                  </div>
                )}
              </div>
            ))}
          </div>
          {funnel.medianDaysToReply !== null && (
            <p className="mt-2 text-xs text-slate-500">
              Median {funnel.medianDaysToReply} days to reply.
            </p>
          )}
          <div className="mt-3 grid gap-4 md:grid-cols-3">
            <BreakdownTable title="By ask" rows={funnel.byCta} />
            <BreakdownTable title="By length" rows={funnel.byLength} />
            <BreakdownTable title="By proof point" rows={funnel.byProofPoint.slice(0, 6)} />
          </div>
          <p className="mt-3 text-[11px] text-slate-400">
            Reply rates are hidden below 5 sends — a rate on two emails is noise, not signal.
          </p>
        </div>
      )}

      {/* ─── Queue ───────────────────────────────────────────────────── */}
      {loading ? (
        <p className="mt-6 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">
          Nothing here yet. Scout prospects, open one, and build positioning and a draft.
        </p>
      ) : (
        GROUPS.map((group) => {
          const items = rows.filter((r) => group.states.includes(r.state))
          if (items.length === 0) return null
          return (
            <div key={group.label} className="mt-6">
              <h2 className="text-sm font-semibold text-slate-800">
                {group.label}{' '}
                <span className="font-normal text-slate-400">({items.length})</span>
              </h2>
              <div className="mt-2 space-y-2">
                {items.map((row) => (
                  <div key={row.id} className="border border-slate-200 rounded-lg">
                    <button
                      onClick={() => setOpen(open === row.id ? null : row.id)}
                      className="w-full text-left px-4 py-3 hover:bg-slate-50"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900">{row.name}</span>
                        <span className="text-sm text-slate-500">
                          {row.title} · {row.company}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {row.outcome && (
                            <span className="text-[11px] text-slate-500">
                              {row.outcome.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          )}
                          <StateBadge state={row.state} />
                        </span>
                      </div>
                      {row.subject && (
                        <div className="mt-1 text-sm text-slate-600">{row.subject}</div>
                      )}
                      {row.grounding && !row.grounding.ok && (
                        <div className="mt-1 text-xs text-red-700">
                          {row.grounding.blocking.length} unsupported claim
                          {row.grounding.blocking.length === 1 ? '' : 's'} — blocked
                        </div>
                      )}
                    </button>

                    {open === row.id && (
                      <div className="px-4 pb-4">
                        {row.angle && (
                          <p className="mb-3 text-xs text-slate-600">
                            <span className="font-medium uppercase tracking-wide text-slate-400">
                              Angle:{' '}
                            </span>
                            {row.angle}
                          </p>
                        )}
                        <OutreachPanel
                          outreach={{
                            id: row.id,
                            state: row.state,
                            subject: row.subject ?? '',
                            body: row.body ?? '',
                            wordCount: row.wordCount,
                            grounding: row.grounding,
                            sentAt: row.sentAt,
                            sendError: row.sendError,
                            recipientEmail: row.email,
                          }}
                          onChange={(next) =>
                            patchRow(row.id, {
                              state: next.state,
                              subject: next.subject,
                              body: next.body,
                              grounding: next.grounding,
                              sentAt: next.sentAt ?? row.sentAt,
                              sendError: next.sendError ?? null,
                            })
                          }
                        />
                        <ReplyPanel
                          row={row}
                          onChange={(patch) => patchRow(row.id, patch as Partial<Row>)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
  if (rows.length === 0) return null
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{title}</div>
      <table className="mt-1 w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-slate-100">
              <td className="py-1 pr-2 text-slate-700">{r.key}</td>
              <td className="py-1 text-right text-slate-500">
                {r.sent}/{r.drafted}
              </td>
              <td className="py-1 pl-2 text-right text-slate-500">
                {r.replyRate === null ? '—' : `${(r.replyRate * 100).toFixed(0)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
