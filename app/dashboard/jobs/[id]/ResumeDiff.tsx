'use client'

import { useState } from 'react'
import type { ChangeView, ResumeView } from '@/components/career/packageTypes'
import { api } from '@/components/career/api'
import InlineNotice from '@/components/career/InlineNotice'
import ChangeRow, { type Decision } from './ChangeRow'

interface ReviewResponse {
  changes: ChangeView[]
  refused: { decision: Decision; reason: string }[]
  updated: number
  errors: string[]
}

/**
 * The résumé patch review. Every decision is a PATCH; the rows shown are the
 * ones the server returned, so a refresh never loses a decision. "Approve all
 * safe" is deterministic on the server (pending ∧ SUPPORTED ∧ level ≤ 3).
 */
export default function ResumeDiff({
  packageId,
  resume,
  locked,
  onChanges,
}: {
  packageId: string
  resume: ResumeView
  locked: boolean
  onChanges: (changes: ChangeView[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)

  async function send(body: { decisions: Decision[] } | { approveAllSafe: true }): Promise<string | null> {
    setBusy(true)
    setNotice(null)
    const r = await api<ReviewResponse>(`/api/career/packages/${packageId}/resume`, { method: 'PATCH', json: body })
    setBusy(false)
    if (!r.ok || !r.data) return r.error
    // PATCH answers with bare VerifiedChange rows: evidence_fact_ids, no
    // resolved `evidence` statements, no `experience_label`. Only the view
    // route resolves ids to text. So the server's row is laid over the row we
    // already hold — decision, verification and text come from the server,
    // the resolved fields survive — otherwise the first decision would render
    // `change.evidence.length` on undefined and take the whole page down.
    const prior = new Map(resume.changes.map((c) => [c.id, c]))
    onChanges(
      r.data.changes.map((c) => {
        const p = prior.get(c.id)
        return {
          ...(p ?? {}),
          ...c,
          experience_label: c.experience_label ?? p?.experience_label ?? '',
          evidence: Array.isArray(c.evidence) ? c.evidence : p?.evidence ?? [],
          confidence: typeof c.confidence === 'number' ? c.confidence : p?.confidence ?? 0,
        }
      })
    )
    const refused = r.data.refused ?? []
    if (refused.length) {
      const text = refused.map((x) => x.reason).join(' · ')
      setNotice({ kind: 'warn', text })
      return text
    }
    if (r.data.errors?.length) setNotice({ kind: 'error', text: r.data.errors.join(' · ') })
    return null
  }

  const changes = [...resume.changes].sort((a, b) => a.position - b.position)
  const groups = new Map<string, ChangeView[]>()
  for (const c of changes) {
    const k = c.experience_label || c.experience_id
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  const counts = {
    pending: changes.filter((c) => c.review_status === 'pending').length,
    approved: changes.filter((c) => c.review_status === 'approved' || c.review_status === 'edited').length,
    auto: changes.filter((c) => c.review_status === 'auto_rejected').length,
    safe: changes.filter((c) => c.review_status === 'pending' && c.verification_result === 'SUPPORTED' && c.edit_level <= 3).length,
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        {resume.patch.summary && <p className="text-sm text-slate-800">{resume.patch.summary}</p>}
        {resume.patch.no_change_reason && (
          <p className="text-sm text-emerald-800 mt-1">
            <span className="font-medium">The master already fits this role.</span> {resume.patch.no_change_reason}
          </p>
        )}
        <p className="text-xs text-slate-500 mt-1.5">
          {changes.length} proposed · {counts.approved} approved · {counts.pending} pending · {counts.auto} kept original
          {typeof resume.patch.edit_distance === 'number' ? ` · edit distance ${resume.patch.edit_distance}` : ''} · patch {resume.patch.status}
        </p>
        {!locked && counts.safe > 0 && (
          <button type="button" disabled={busy} onClick={() => send({ approveAllSafe: true })} className="mt-2 text-xs px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
            Approve all {counts.safe} safe change{counts.safe === 1 ? '' : 's'} (supported, level ≤ 3)
          </button>
        )}
      </div>

      {notice && <InlineNotice kind={notice.kind}>{notice.text}</InlineNotice>}

      {changes.length === 0 ? (
        <p className="text-sm text-slate-500">No changes proposed — the documents will be built from the master as-is.</p>
      ) : (
        Array.from(groups.entries()).map(([label, rows]) => (
          <section key={label}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{label}</h3>
            <div className="space-y-2">
              {rows.map((c) => (
                <ChangeRow key={c.id} change={c} locked={locked} busy={busy} onDecide={(d) => send({ decisions: [d] })} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
