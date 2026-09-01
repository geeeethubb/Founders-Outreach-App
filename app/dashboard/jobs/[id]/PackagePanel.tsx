'use client'

// The application package flow, in the order the server enforces:
//   (none) → generate → resume_review → approve résumé, build documents
//   → ready_for_review → approve letter → finalize → ready_to_apply → applied (locked)
// Every step is a route call and the panel re-renders from what came back.
// 422/409 answers carry qa, findings and messages — shown verbatim, never hidden.

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { Application, DocumentQaReport, JobOpportunity } from '@/lib/career/types'
import { api, fmtUsd } from '@/components/career/api'
import type { LetterView, PackageSummary, PackageView } from '@/components/career/packageTypes'
import InlineNotice from '@/components/career/InlineNotice'
import DocLinks from '@/components/career/DocLinks'
import ResumeDiff from './ResumeDiff'
import { AttentionPanel, PackageChecklist, attentionFor } from './PackageChecklist'
import LetterPanel from './LetterPanel'
import PackageDocuments from './PackageDocuments'
import PackageVersions from './PackageVersions'
import PackageProgress, { STAGE_LABEL } from './PackageProgress'
import PackageFailure from './PackageFailure'
import { explainPackageError } from '@/lib/career/package/status'

interface Props {
  jobId: string
  job: JobOpportunity
  packages: PackageSummary[]
  view: PackageView | null
  application: Application | null
  onReload: () => Promise<void>
  onView: (v: PackageView) => void
  onApplicationChanged: (a: Application) => void
}

export default function PackagePanel({ jobId, job, packages, view, application, onReload, onView, onApplicationChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok' | 'warn' | 'info'; text: string } | null>(null)
  const [failedQa, setFailedQa] = useState<{ resume: DocumentQaReport | null; cover_letter: DocumentQaReport | null } | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [ackLetter, setAckLetter] = useState(false)
  const [confirmApplied, setConfirmApplied] = useState(false)
  // The Applications page links here with ?redo=1: open the confirm box, do not redo on arrival.
  const search = useSearchParams()
  const [confirmRedo, setConfirmRedo] = useState(search.get('redo') === '1')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const latest = packages[0] ?? null
  const status = view?.status ?? latest?.status ?? null
  const generating = busy === 'generate' || status === 'generating'

  // Progress while a package is being generated: the stage column moves as the
  // orchestrator advances, so the list route (during POST) or the view route
  // (after a refresh) is polled every 3s until it settles.
  useEffect(() => {
    if (!generating) {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
      return
    }
    pollRef.current = setInterval(async () => {
      if (latest && status === 'generating') {
        const r = await api<PackageView>(`/api/career/packages/${latest.id}`)
        if (r.ok && r.data) {
          setStage(r.data.stage)
          if (r.data.status !== 'generating') {
            onView(r.data)
            await onReload()
          }
        }
        return
      }
      const r = await api<{ packages: PackageSummary[] }>(`/api/career/jobs/${jobId}`)
      const p = r.data?.packages?.[0]
      if (p) setStage(p.stage)
    }, 3000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, latest?.id, status])

  /**
   * A first package, or a redo. A redo goes through POST …/packages/[id]/redo: a NEW
   * version beside the current one — the current one becomes superseded unless it is
   * locked, in which case it stays exactly as submitted. Same pipeline either way.
   */
  async function generate() {
    setBusy('generate')
    setNotice(null)
    setFailedQa(null)
    setConfirmRedo(false)
    setStage('started')
    const r = latest
      ? await api<{ package_id: string; status: string; error: string | null; errors: string[]; warnings: string[]; costUsd: number }>(`/api/career/packages/${latest.id}/redo`, { method: 'POST', json: {} })
      : await api<{ package_id: string; status: string; error: string | null; errors: string[]; warnings: string[]; costUsd: number }>('/api/career/packages', { json: { job_id: jobId } })
    setBusy(null)
    setStage(null)
    // Reload before judging the answer: the server created the package row before it
    // started working, so a timeout (504) or a failure still has a row to show — never
    // the empty state with Generate live, where a second click pays again.
    await onReload()
    if (!r.ok && !r.body?.package_id) {
      setNotice({
        kind: 'error',
        text: r.status === 504 || r.status === 0
          ? 'The request ended before an answer came back; the package row below shows where it got to.'
          : r.error ?? 'Package generation failed',
      })
      return
    }
    const errs = (r.body?.errors as string[] | undefined) ?? []
    const warns = (r.body?.warnings as string[] | undefined) ?? []
    if (r.body?.error) setNotice({ kind: 'error', text: String(r.body.error) })
    else if (errs.length) setNotice({ kind: 'warn', text: `Finished with errors: ${errs.join(' · ')}` })
    else if (warns.length) setNotice({ kind: 'info', text: warns.join(' · ') })
  }

  /** Long request: builds the résumé documents, writes the letter, runs QA. 422 carries qa + error. */
  async function approveResume() {
    if (!latest) return
    setBusy('resume')
    setNotice(null)
    setFailedQa(null)
    const r = await api<PackageView & { result: { status: string; warnings: string[]; errors: string[]; error: string | null; costUsd: number } }>(`/api/career/packages/${latest.id}/resume`, { json: { approve: true } })
    setBusy(null)
    const body = r.body as (PackageView & { result?: { warnings?: string[]; errors?: string[]; error?: string | null } }) | null
    if (body && typeof body.status === 'string') {
      onView(body)
      if (body.qa) setFailedQa(r.status === 422 ? body.qa : null)
    }
    if (!r.ok) {
      // The same translation the failure block below uses, so the notice never
      // shows a raw ENOENT as if the user's résumé changes had caused it.
      const raw = (body as { error?: string | null } | null)?.error ?? r.error ?? null
      const explained = explainPackageError(raw)
      setNotice({ kind: 'error', text: [explained.headline, explained.reassurance].filter(Boolean).join(' ') })
    } else {
      const res = body?.result
      if (res?.errors?.length) setNotice({ kind: 'warn', text: res.errors.join(' · ') })
      else if (res?.warnings?.length) setNotice({ kind: 'info', text: res.warnings.join(' · ') })
      else setNotice({ kind: 'ok', text: 'Documents built. Review the QA and the cover letter below.' })
    }
    await onReload()
  }

  async function finalize() {
    if (!latest) return
    setBusy('finalize')
    setNotice(null)
    const r = await api<{ status: string; application_state: string | null }>(`/api/career/packages/${latest.id}/finalize`, { json: ackLetter ? { acknowledge_letter: true } : {} })
    setBusy(null)
    if (!r.ok) {
      setNotice({ kind: 'error', text: r.error ?? 'Could not finalize' })
      return
    }
    if (!r.data?.application_state) setNotice({ kind: 'warn', text: 'Package is ready to apply, but the application record did not advance — check the Application tab.' })
    await onReload()
  }

  async function markApplied() {
    if (!application) return
    setBusy('applied')
    setNotice(null)
    const r = await api<{ application: Application }>(`/api/career/applications/${application.id}`, { method: 'PATCH', json: { state: 'APPLIED' } })
    setBusy(null)
    setConfirmApplied(false)
    if (!r.ok || !r.data) {
      setNotice({ kind: 'error', text: r.error ?? 'Could not mark applied' })
      return
    }
    onApplicationChanged(r.data.application)
    await onReload()
  }

  function onLetter(letter: LetterView) {
    if (view) onView({ ...view, cover_letter: letter })
  }

  const applyHref = job.apply_url ?? job.canonical_url
  // `locked` is THIS package's status. A redo beside an applied application is a draft:
  // editable, but it can never be marked ready to apply (APPLIED → READY_TO_APPLY is not a
  // legal transition), so the finalize block is replaced by a note.
  const locked = status === 'locked'
  const applicationLocked = Boolean(view?.application?.locked)
  const readOnly = locked || status === 'superseded' || status === 'ready_to_apply'

  return (
    <div className="space-y-5">
      {notice && <InlineNotice kind={notice.kind}>{notice.text}</InlineNotice>}

      {/* (a) nothing yet */}
      {!latest && !generating && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-slate-700 font-medium">No package for this job yet.</p>
          <p className="text-sm text-slate-500 mt-1 mb-3 max-w-xl mx-auto">
            One click runs everything: research, fit, evidence matching, résumé tailoring, fact verification, the DOCX, the cover
            letter and document QA. Changes that pass verification are applied automatically; anything that fails keeps your original
            wording. You get <strong>Ready to apply</strong> or a specific thing to look at. Nothing is ever submitted for you.
            A few minutes; cached inputs are free.
          </p>
          <button type="button" onClick={generate} disabled={job.verification_status === 'CLOSED'} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            Generate package
          </button>
          {job.verification_status === 'CLOSED' && <p className="text-xs text-rose-600 mt-2">The posting is closed.</p>}
        </div>
      )}

      {generating && <PackageProgress stage={stage} />}
      {busy === 'resume' && <PackageProgress stage={null} phase="documents" />}

      {latest && view && !generating && (
        <>
          <div className="flex items-center gap-3 flex-wrap text-xs text-slate-500">
            <span className="font-medium text-slate-700">Package v{view.package.version}</span>
            <span className="px-1.5 py-0.5 rounded border bg-slate-50 border-slate-200">{status?.replace(/_/g, ' ')}</span>
            {view.stage && status !== 'ready_to_apply' && <span>{STAGE_LABEL[view.stage] ?? view.stage}</span>}
            <span className="ml-auto" title="Total spent on agents for this package">
              {fmtUsd(view.cost_usd)}
            </span>
          </div>

          {locked && (
            <InlineNotice kind="info">
              This package is <strong>locked</strong>: it is the record of what you submitted. It can no longer be edited in place —
              a redo creates a new version beside it.
            </InlineNotice>
          )}
          {applicationLocked && !locked && (
            <InlineNotice kind="info">
              You already applied with the submitted version — this v{view.package.version} is a draft beside it and cannot be marked ready to apply.
            </InlineNotice>
          )}

          {/* Redo — reachable for every status but generating. Always a new version; never an edit in place. */}
          {status !== 'generating' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              {!confirmRedo ? (
                <p className="text-xs text-slate-500">
                  Need to start over?{' '}
                  <button type="button" disabled={busy !== null} onClick={() => setConfirmRedo(true)} className="underline text-slate-700 hover:text-slate-900 disabled:opacity-50">
                    Redo package (new version)
                  </button>
                  {' '}— researches, tailors and writes again as v{(latest?.version ?? 0) + 1}.
                  {locked ? ' Documents already submitted stay locked; the new version sits beside them.' : ' The current version becomes superseded.'}
                </p>
              ) : (
                <div className="text-sm text-slate-700">
                  <p className="font-medium">Redo this package as v{(latest?.version ?? 0) + 1}?</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Intelligence is reused when fresh; the résumé is re-tailored and stops at your review; the cover letter is rewritten after you approve the résumé.
                    {locked ? ' The submitted documents are never touched.' : ' The current version becomes superseded.'} Nothing is submitted anywhere.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={busy !== null} onClick={generate} className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700 disabled:opacity-50">
                      Yes, redo as a new version
                    </button>
                    <button type="button" onClick={() => setConfirmRedo(false)} className="text-xs text-slate-500">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* (e) failed */}
          {status === 'failed' && (
            <PackageFailure
              stage={view.stage}
              error={view.error}
              canRetry={Boolean(view.resume)}
              // A letter exists only when one was already written and paid for;
              // that is exactly what a retry reuses, so it is what the retry
              // sentence is allowed to promise.
              letterWritten={Boolean(view.cover_letter)}
              busy={busy !== null}
              onRetry={approveResume}
              onRedo={generate}
            />
          )}

          {/* (d) ready to apply */}
          {status === 'ready_to_apply' && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
              <p className="text-base font-semibold text-emerald-900">Ready to apply</p>
              <p className="text-sm text-emerald-800 mt-0.5">Submit through the company&apos;s own application — this system never applies for you.</p>
              <PackageChecklist view={view as never} />
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                {applyHref ? (
                  <a href={applyHref} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
                    Open application ↗
                  </a>
                ) : (
                  <span className="text-sm text-emerald-800">No application link is stored for this job — find it on the company site.</span>
                )}
                <DocLinks documents={view.documents} />
              </div>
              {application && application.state !== 'APPLIED' && !locked && (
                <div className="mt-3">
                  {!confirmApplied ? (
                    <button type="button" onClick={() => setConfirmApplied(true)} className="text-sm text-emerald-900 underline">
                      I applied
                    </button>
                  ) : (
                    <div className="rounded-md border border-emerald-300 bg-white p-3 text-sm text-slate-700">
                      <p>
                        Marking APPLIED records that you submitted through the link above and <strong>locks</strong> these documents as the record of
                        what was sent. Continue?
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button type="button" disabled={busy !== null} onClick={markApplied} className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700 disabled:opacity-50">
                          {busy === 'applied' ? 'Saving…' : 'Yes, I applied'}
                        </button>
                        <button type="button" onClick={() => setConfirmApplied(false)} className="text-xs text-slate-500">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* (b) résumé review */}
          {view.resume && (status === 'resume_review' || status === 'ready_for_review' || status === 'failed') && (
            <section>
              <h2 className="text-sm font-semibold text-slate-900 mb-2">Résumé changes</h2>
              {status === 'ready_for_review' && view.resume.patch.status !== 'applied' && (
                <InlineNotice kind="warn" className="mb-2">
                  Decisions changed since the documents were built — rebuild them below before finalizing.
                </InlineNotice>
              )}
              <ResumeDiff packageId={latest.id} resume={view.resume} locked={readOnly} onChanges={(changes) =>
                  // The server marks the patch 'reviewed' on any accepted decision; mirror that so the
                  // "documents are stale" warning above appears without a reload.
                  onView({ ...view, resume: { ...view.resume!, changes, patch: { ...view.resume!.patch, status: 'reviewed' } } })
                } />
              {status === 'resume_review' && (
                <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
                  <p className="text-sm text-slate-700">
                    This package stopped before its documents were built — usually because the request timed out part-way. Finishing it
                    picks up where it left off: the résumé DOCX, the cover letter, then QA. Changes that passed verification are applied;
                    anything pending or rejected keeps your original wording.
                  </p>
                  <button type="button" disabled={busy !== null} onClick={approveResume} className="mt-2 px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                    {busy === 'resume' ? 'Building documents… (this takes a while)' : 'Finish this package'}
                  </button>
                </div>
              )}
            </section>
          )}

          {/* (c) documents + letter */}
          {(status === 'ready_for_review' || status === 'failed' || failedQa) && (view.documents.resume_docx || failedQa || view.qa.resume || view.qa.cover_letter) && (
            <PackageDocuments documents={view.documents} qa={failedQa ?? view.qa} />
          )}

          {view.cover_letter && status !== 'resume_review' && (
            <LetterPanel packageId={latest.id} letter={view.cover_letter} readOnly={readOnly} onChanged={onLetter} onDocuments={onReload} />
          )}

          {/*
            A package that finished but is NOT ready. Generation already tried
            everything; landing here means a specific thing needs a person, so
            this says what — and keeps the override, because "apply with the
            résumé only" is a real decision the founder is entitled to make.
          */}
          {status === 'ready_for_review' && !applicationLocked && (
            <>
              <AttentionPanel items={attentionFor(view as never)} />
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <PackageChecklist view={view as never} />
                <p className="text-xs text-slate-500 mt-2">
                  The documents above are built and stored. If what needs attention does not block your application — an
                  ungrounded cover-letter sentence when you plan to send the résumé alone, say — you can mark this ready.
                </p>
                {view.cover_letter && view.cover_letter.review_status !== 'approved' && (
                  <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-700">
                    <input type="checkbox" checked={ackLetter} onChange={(e) => setAckLetter(e.target.checked)} />
                    I have read the cover letter and want to mark this ready anyway
                  </label>
                )}
                <button type="button" disabled={busy !== null} onClick={finalize} className="mt-2 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                  {busy === 'finalize' ? 'Marking ready…' : 'Mark READY TO APPLY'}
                </button>
              </div>
            </>
          )}

        </>
      )}

      {latest && !view && !generating && <InlineNotice kind="error">The package view could not be loaded. Refresh to try again.</InlineNotice>}

      {packages.length > 1 && <PackageVersions packages={packages.slice(1)} />}
    </div>
  )
}
