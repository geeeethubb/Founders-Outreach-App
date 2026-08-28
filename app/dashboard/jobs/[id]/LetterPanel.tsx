'use client'

// The cover letter review. Approve / Edit / Regenerate are route calls; an
// edit is re-gated against the same evidence pools as the draft and a 422
// keeps it pending with the findings shown. The letter on screen is always
// the one the server holds.

import { useState } from 'react'
import { api } from '@/components/career/api'
import type { LetterGroundingView, LetterView } from '@/components/career/packageTypes'
import InlineNotice from '@/components/career/InlineNotice'

interface LetterResponse {
  letter: LetterView | null
  grounding: LetterGroundingView | null
  refused: string | null
  documents: { docxPath: string; pdfPath: string | null } | null
  errors: string[]
}

const REVIEW_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  edited: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
}

export default function LetterPanel({
  packageId,
  letter,
  readOnly,
  onChanged,
  onDocuments,
}: {
  packageId: string
  letter: LetterView
  readOnly: boolean
  onChanged: (letter: LetterView) => void
  /** Documents were rebuilt on the server — the parent reloads the view for the new links. */
  onDocuments: () => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(letter.edited_text ?? letter.full_text ?? '')
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok' | 'warn'; text: string } | null>(null)
  const [grounding, setGrounding] = useState<LetterGroundingView | null>(letter.grounding)
  const [showClaims, setShowClaims] = useState(false)

  async function send(kind: string, init: { method: 'PATCH' | 'POST'; json: unknown }) {
    setBusy(kind)
    setNotice(null)
    const r = await api<LetterResponse>(`/api/career/packages/${packageId}/letter`, init)
    setBusy(null)
    const body = r.body as LetterResponse | null
    if (body?.grounding) setGrounding(body.grounding)
    if (body?.letter) onChanged({ ...body.letter, grounding: body.grounding ?? body.letter.grounding })
    if (!r.ok) {
      setNotice({ kind: 'error', text: body?.refused ?? r.error ?? 'Request failed' })
      return
    }
    if (body?.errors?.length) setNotice({ kind: 'warn', text: body.errors.join(' · ') })
    else setNotice({ kind: 'ok', text: kind === 'regenerate' ? 'New draft written — review it below.' : kind === 'edit' ? 'Edit grounded and saved.' : 'Letter approved.' })
    setEditing(false)
    if (body?.documents) await onDocuments()
  }

  const shown = letter.review_status === 'edited' && letter.edited_text ? letter.edited_text : null
  // `claims` is a nullable jsonb column; a letter row written before the gate ran carries null.
  const claims = letter.claims ?? []
  const paragraphs = letter.paragraphs ?? []
  const g = grounding
  const hasBlocking = Boolean(g && g.blocking.length)

  return (
    <section>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <h2 className="text-sm font-semibold text-slate-900">Cover letter</h2>
        <span className={`text-[11px] px-1.5 py-0.5 rounded border ${REVIEW_STYLE[letter.review_status] ?? REVIEW_STYLE.pending}`}>{letter.review_status}</span>
        <span className="text-[11px] text-slate-400">
          v{letter.version} · {letter.word_count ?? '?'} words · {claims.length} claim{claims.length === 1 ? '' : 's'}
        </span>
      </div>

      {notice && (
        <InlineNotice kind={notice.kind} className="mb-2">
          {notice.text}
        </InlineNotice>
      )}

      {g && (g.blocking.length > 0 || g.warnings.length > 0) && (
        <div className={`mb-2 rounded-md border p-2.5 ${hasBlocking ? 'border-rose-200 bg-rose-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
          <p className="text-xs font-semibold text-slate-700">Grounding {hasBlocking ? '— blocking findings' : '— warnings'}</p>
          <ul className="mt-1 space-y-0.5">
            {g.blocking.map((f, i) => (
              <li key={`b${i}`} className="text-xs text-rose-700">
                ✗ {f.kind}: &ldquo;{f.span}&rdquo; — {f.reason}
              </li>
            ))}
            {g.warnings.map((f, i) => (
              <li key={`w${i}`} className="text-xs text-amber-700">
                ⚠ {f.kind}: &ldquo;{f.span}&rdquo; — {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing ? (
        <div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={16} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-serif leading-relaxed" />
          <p className="text-[11px] text-slate-500 mt-1">
            Your text is re-checked against the company research and your Evidence Bank. A claim neither can support blocks the save.
          </p>
          <div className="mt-1.5 flex gap-2">
            <button type="button" disabled={busy !== null || !text.trim()} onClick={() => send('edit', { method: 'PATCH', json: { action: 'edit', text } })} className="text-xs px-2.5 py-1 rounded-md bg-indigo-600 text-white disabled:opacity-50">
              {busy === 'edit' ? 'Grounding…' : 'Save and ground'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="text-xs text-slate-500">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-800 leading-relaxed font-serif">
          {shown ? (
            <p className="whitespace-pre-wrap">{shown}</p>
          ) : (
            <>
              {letter.greeting && <p className="mb-3">{letter.greeting}</p>}
              {paragraphs.map((p, i) => (
                <p key={i} className="mb-3">
                  {p}
                </p>
              ))}
              {letter.closing && <p className="whitespace-pre-wrap">{letter.closing}</p>}
            </>
          )}
        </div>
      )}

      <button type="button" onClick={() => setShowClaims((s) => !s)} className="mt-2 text-[11px] text-indigo-600 hover:underline">
        {showClaims ? 'Hide claims' : `Claims (${claims.length})`}
      </button>
      {showClaims && (
        <ul className="mt-1 space-y-0.5">
          {claims.map((c, i) => (
            <li key={i} className="text-xs text-slate-600">
              <span className={`mr-1 px-1 rounded border ${c.kind === 'company' ? 'bg-sky-50 border-sky-200 text-sky-700' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>{c.kind}</span>
              {c.claim_text}
              <span className="text-slate-400"> → {c.research_fact_id ? 'research fact' : c.evidence_fact_id ? 'evidence fact' : 'unsourced'}</span>
            </li>
          ))}
          {claims.length === 0 && <li className="text-xs text-slate-400">No claims recorded.</li>}
        </ul>
      )}

      {!readOnly && !editing && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {letter.review_status !== 'approved' && (
            <button type="button" disabled={busy !== null || hasBlocking} title={hasBlocking ? 'Blocking findings must be fixed first' : undefined} onClick={() => send('approve', { method: 'PATCH', json: { action: 'approve' } })} className="text-xs px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {busy === 'approve' ? 'Approving…' : 'Approve letter'}
            </button>
          )}
          <button type="button" disabled={busy !== null} onClick={() => setEditing(true)} className="text-xs px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Edit
          </button>
          {letter.review_status !== 'rejected' && (
            <button type="button" disabled={busy !== null} onClick={() => send('reject', { method: 'PATCH', json: { action: 'reject' } })} className="text-xs px-2.5 py-1 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
              Reject
            </button>
          )}
          <button type="button" disabled={busy !== null} onClick={() => send('regenerate', { method: 'POST', json: { regenerate: true } })} className="text-xs px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {busy === 'regenerate' ? 'Writing… (a minute)' : 'Regenerate'}
          </button>
        </div>
      )}
    </section>
  )
}
