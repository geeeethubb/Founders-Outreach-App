'use client'

import { useState } from 'react'
import Diff, { Bold } from '@/components/career/Diff'
import { EDIT_LEVEL_MEANING, type ChangeView } from '@/components/career/packageTypes'
import { pct } from '@/components/career/api'

const VERIFY_STYLE: Record<string, string> = {
  SUPPORTED: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  UNSUPPORTED: 'bg-rose-100 text-rose-800 border-rose-200',
  UNCERTAIN: 'bg-amber-100 text-amber-800 border-amber-200',
  NOT_CHECKED: 'bg-slate-100 text-slate-600 border-slate-200',
  SKIPPED: 'bg-slate-50 text-slate-500 border-slate-200',
}

const REVIEW_STYLE: Record<string, string> = {
  pending: 'text-slate-500',
  approved: 'text-emerald-700 font-medium',
  edited: 'text-indigo-700 font-medium',
  rejected: 'text-slate-500 line-through',
  auto_rejected: 'text-rose-700 font-medium',
}

export type Decision = { change_id: string; action: 'approve' | 'reject' | 'edit'; text?: string }

/**
 * One proposed change. Approve / Reject / Edit are server round-trips; the
 * row re-renders from what came back, including the re-verification of an
 * edit. An auto-rejected change (the verifier could not ground it) is not
 * approvable — only editable — and says so.
 */
export default function ChangeRow({
  change,
  locked,
  busy,
  onDecide,
}: {
  change: ChangeView
  locked: boolean
  busy: boolean
  onDecide: (d: Decision) => Promise<string | null>
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(change.final_text ?? change.proposed_text ?? '')
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const auto = change.review_status === 'auto_rejected'
  const decided = change.review_status !== 'pending'
  const approvable = !locked && !auto && change.verification_result === 'SUPPORTED'

  async function decide(d: Decision) {
    setErr(null)
    const e = await onDecide(d)
    if (e) setErr(e)
    else setEditing(false)
  }

  const shown = change.review_status === 'edited' && change.final_text ? change.final_text : change.proposed_text

  return (
    <div className={`rounded-lg border p-3 ${auto ? 'border-rose-200 bg-rose-50/30' : change.review_status === 'approved' || change.review_status === 'edited' ? 'border-emerald-200' : 'border-slate-200'} bg-white`}>
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="px-1.5 py-0.5 rounded border bg-slate-50 text-slate-600 border-slate-200">{change.change_type}</span>
        <span title={EDIT_LEVEL_MEANING[change.edit_level] ?? ''} className="px-1.5 py-0.5 rounded border bg-slate-50 text-slate-600 border-slate-200 cursor-help">
          L{change.edit_level}
        </span>
        <span className={`px-1.5 py-0.5 rounded border ${VERIFY_STYLE[change.verification_result] ?? VERIFY_STYLE.NOT_CHECKED}`}>{change.verification_result.replace('_', ' ')}</span>
        <span className="text-slate-500">confidence {pct(change.confidence)}</span>
        <span className={`ml-auto ${REVIEW_STYLE[change.review_status] ?? ''}`}>{change.review_status.replace('_', ' ')}</span>
      </div>

      {auto && (
        <p className="mt-1.5 text-xs text-rose-700">
          <span className="font-medium">Kept original</span> — {change.verification_notes ?? 'the verifier could not ground this change in your approved evidence'}
        </p>
      )}

      <div className="mt-2">
        {editing ? (
          <div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            <p className="text-[11px] text-slate-500 mt-1">Your edit is re-verified against the Evidence Bank before it can be used. **bold** marks emphasis.</p>
            <div className="mt-1.5 flex gap-2">
              <button type="button" disabled={busy || !text.trim()} onClick={() => decide({ change_id: change.id, action: 'edit', text })} className="text-xs px-2.5 py-1 rounded-md bg-indigo-600 text-white disabled:opacity-50">
                {busy ? 'Verifying…' : 'Save and verify'}
              </button>
              <button type="button" onClick={() => setEditing(false)} className="text-xs text-slate-500">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <Diff original={change.original_text} proposed={shown} proposedLabel={change.review_status === 'edited' ? 'Your edit' : 'Proposed'} />
        )}
      </div>

      <dl className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <dt className="font-semibold text-slate-500">Why</dt>
          <dd className="text-slate-700">{change.reason}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-500">Job requirement targeted</dt>
          <dd className="text-slate-700">{change.job_requirement || '—'}</dd>
        </div>
        <div className="md:col-span-2">
          <dt className="font-semibold text-slate-500">Evidence</dt>
          <dd className="text-slate-700">
            {change.evidence.length === 0 ? (
              <span className="text-slate-400">none cited</span>
            ) : (
              <ul className="list-disc pl-4">
                {change.evidence.map((e) => (
                  <li key={e.id}>
                    <Bold text={e.statement} />
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {!auto && change.verification_notes && <p className="mt-1.5 text-xs text-slate-600">{change.verification_notes}</p>}

      {(change.verification_clauses?.length || change.precheck_findings) && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1.5 text-[11px] text-indigo-600 hover:underline">
          {open ? 'Hide verification detail' : 'Verification detail'}
        </button>
      )}
      {open && (
        <div className="mt-1.5 space-y-2">
          {change.verification_clauses?.length ? (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="pr-2 font-semibold">Clause</th>
                  <th className="pr-2 font-semibold">Verdict</th>
                  <th className="font-semibold">Supporting facts / note</th>
                </tr>
              </thead>
              <tbody>
                {change.verification_clauses.map((c, i) => (
                  <tr key={i} className="align-top border-t border-slate-100">
                    <td className="pr-2 py-1 text-slate-700">{c.clause}</td>
                    <td className={`pr-2 py-1 ${c.verdict === 'SUPPORTED' ? 'text-emerald-700' : c.verdict === 'UNSUPPORTED' ? 'text-rose-700' : 'text-amber-700'}`}>{c.verdict}</td>
                    <td className="py-1 text-slate-600">
                      {c.fact_ids.length ? `${c.fact_ids.length} fact${c.fact_ids.length === 1 ? '' : 's'}` : ''}
                      {c.note ? ` ${c.note}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {change.precheck_findings && (change.precheck_findings.blocking.length > 0 || change.precheck_findings.warnings.length > 0) && (
            <ul className="space-y-0.5">
              {change.precheck_findings.blocking.map((f, i) => (
                <li key={`b${i}`} className="text-[11px] text-rose-700">
                  ✗ {f.kind}: &ldquo;{f.span}&rdquo; — {f.reason}
                </li>
              ))}
              {change.precheck_findings.warnings.map((f, i) => (
                <li key={`w${i}`} className="text-[11px] text-amber-700">
                  ⚠ {f.kind}: &ldquo;{f.span}&rdquo; — {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!locked && !editing && (
        <div className="mt-2 flex items-center gap-2">
          {approvable && change.review_status !== 'approved' && (
            <button type="button" disabled={busy} onClick={() => decide({ change_id: change.id, action: 'approve' })} className="text-xs px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              Approve
            </button>
          )}
          {!auto && change.review_status !== 'rejected' && (
            <button type="button" disabled={busy} onClick={() => decide({ change_id: change.id, action: 'reject' })} className="text-xs px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              Reject
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className="text-xs px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Edit
          </button>
          {!approvable && !auto && !decided && <span className="text-[11px] text-slate-500">not approvable as proposed ({change.verification_result.toLowerCase()}) — edit it or reject</span>}
        </div>
      )}
      {err && <p className="mt-1.5 text-xs text-rose-600">{err}</p>}
    </div>
  )
}
