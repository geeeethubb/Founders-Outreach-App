'use client'

// The application package flow, in the order the server enforces:
//   (none) → generate → resume_review → approve résumé, build documents
//   → ready_for_review → approve letter → finalize → ready_to_apply → applied (locked)
// Every step is a route call and the panel re-renders from what came back.
// 422/409 answers carry qa, findings and messages — shown verbatim, never hidden.

import { useEffect, useRef, useState } from 'react'
import type { Application, DocumentQaReport, JobOpportunity } from '@/lib/career/types'
import { api, fmtUsd } from '@/components/career/api'
import type { LetterView, PackageSummary, PackageView } from '@/components/career/packageTypes'
import InlineNotice from '@/components/career/InlineNotice'
import DocLinks from '@/components/career/DocLinks'
import ResumeDiff from './ResumeDiff'
import LetterPanel from './LetterPanel'
import PackageDocuments from './PackageDocuments'
import PackageVersions from './PackageVersions'

const STAGE_LABEL: Record<string, string> = {
  started: 'Starting',
  intelligence: 'Researching the company, judging fit, matching your evidence',
  tailoring: 'Tailoring the résumé and verifying every change',
  resume_review: 'Waiting for your review',
  resume_documents: 'Building the résumé DOCX and PDF',
  cover_letter: 'Writing and grounding the cover letter',
  documents: 'Building the cover letter documents and running QA',
  finalized: 'Finalized',
}

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

  async function generate() {
    setBusy('generate')
    setNotice(null)
    setFailedQa(null)
    setStage('started')
    const r = await api<{ package_id: string; status: string; error: string | null; errors: string[]; warnings: string[]; costUsd: number }>('/api/career/packages', { json: { job_id: jobId } })
    setBusy(null)
    setStage(null)
    if (!r.ok && !r.body?.package_id) {
      setNotice({ kind: 'error', text: r.error ?? 'Package generation failed' })
      return
    }
    const errs = (r.body?.errors as string[] | undefined) ?? []
    const warns = (r.body?.warnings as string[] | undefined) ?? []
    if (r.body?.error) setNotice({ kind: 'error', text: String(r.body.error) })
    else if (errs.length) setNotice({ kind: 'warn', text: `Finished with errors: ${errs.join(' · ')}` })
    else if (warns.length) setNotice({ kind: 'info', text: warns.join(' · ') })
    await onReload()
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
      setNotice({ kind: 'error', text: r.error ?? 'Document build failed' })
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
  const locked = status === 'locked' || Boolean(view?.application?.locked)
  const readOnly = locked || status === 'superseded' || status === 'ready_to_apply'

  return (
    <div className="space-y-5">
      {notice && <InlineNotice kind={notice.kind}>{notice.text}</InlineNotice>}

      {/* (a) nothing yet */}
      {!latest && !generating && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-slate-700 font-medium">No package for this job yet.</p>
          <p className="text-sm text-slate-500 mt-1 mb-3 max-w-xl mx-auto">
            Generating one researches the company, judges fit, matches your evidence, then proposes résumé changes — each verified
            against your Evidence Bank — for you to review. Nothing is sent anywhere. A few minutes; cached inputs are free.
          </p>
          <button type="button" onClick={generate} disabled={job.verification_status === 'CLOSED'} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            Generate package
          </button>
          {job.verification_status === 'CLOSED' && <p className="text-xs text-rose-600 mt-2">The posting is closed.</p>}
        </div>
      )}

      {generating && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
          <p className="text-sm font-medium text-indigo-900">Generating package…</p>
          <ol className="mt-2 space-y-0.5 text-xs">
            {Object.entries(STAGE_LABEL)
              .filter(([k]) => ['started', 'intelligence', 'tailoring', 'resume_review'].includes(k))
              .map(([k, label]) => {
                const order = ['started', 'intelligence', 'tailoring', 'resume_review']
                const cur = order.indexOf(stage ?? 'started')
                const idx = order.indexOf(k)
                return (
                  <li key={k} className={idx < cur ? 'text-emerald-700' : idx === cur ? 'text-indigo-800 font-medium' : 'text-slate-400'}>
                    {idx < cur ? '✓' : idx === cur ? '●' : '○'} {label}
                  </li>
                )
              })}
          </ol>
        </div>
      )}

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
              This package is <strong>locked</strong>: it is the record of what you submitted. It can no longer be edited or regenerated.
            </InlineNotice>
          )}

          {/* (e) failed */}
          {status === 'failed' && (
            <InlineNotice kind="error">
              <p className="font-medium">Package failed{view.stage ? ` during: ${STAGE_LABEL[view.stage] ?? view.stage}` : ''}.</p>
              <p className="mt-0.5">{view.error ?? 'No error text was recorded.'}</p>
              <div className="mt-2 flex gap-2">
                {view.resume && (
                  <button type="button" disabled={busy !== null} onClick={approveResume} className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700 disabled:opacity-50">
                    {busy === 'resume' ? 'Building…' : 'Retry documents'}
                  </button>
                )}
                <button type="button" disabled={busy !== null} onClick={generate} className="px-2.5 py-1 rounded-md border border-rose-300 text-xs text-rose-800 hover:bg-rose-100 disabled:opacity-50">
                  Regenerate package (new version)
                </button>
              </div>
            </InlineNotice>
          )}

          {/* (d) ready to apply */}
          {status === 'ready_to_apply' && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
              <p className="text-base font-semibold text-emerald-900">Ready to apply</p>
              <p className="text-sm text-emerald-800 mt-0.5">Submit through the company&apos;s own application — this system never applies for you.</p>
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
                    Only approved or edited changes reach the document; everything pending or rejected keeps the master text. Building takes a minute
                    or two: résumé DOCX + PDF, then the cover letter, then QA.
                  </p>
                  <button type="button" disabled={busy !== null} onClick={approveResume} className="mt-2 px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                    {busy === 'resume' ? 'Building documents… (this takes a while)' : 'Approve résumé and build documents'}
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

          {status === 'ready_for_review' && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
              <p className="text-sm text-slate-700">
                Finalizing marks the package READY TO APPLY. The cover letter should be approved first;
                {view.cover_letter?.review_status !== 'approved' && ' it is not yet —'}
              </p>
              {view.cover_letter && view.cover_letter.review_status !== 'approved' && (
                <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-700">
                  <input type="checkbox" checked={ackLetter} onChange={(e) => setAckLetter(e.target.checked)} />
                  I acknowledge the letter is {view.cover_letter.review_status} and want to finalize anyway
                </label>
              )}
              <button type="button" disabled={busy !== null} onClick={finalize} className="mt-2 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                {busy === 'finalize' ? 'Finalizing…' : 'Mark READY TO APPLY'}
              </button>
            </div>
          )}

          {(status === 'ready_for_review' || status === 'ready_to_apply' || status === 'superseded') && !locked && (
            <p className="text-xs text-slate-400">
              Need a fresh start?{' '}
              <button type="button" disabled={busy !== null} onClick={generate} className="underline hover:text-slate-700 disabled:opacity-50">
                Regenerate as a new version
              </button>{' '}
              — the current one becomes superseded.
            </p>
          )}
        </>
      )}

      {latest && !view && !generating && <InlineNotice kind="error">The package view could not be loaded. Refresh to try again.</InlineNotice>}

      {packages.length > 1 && <PackageVersions packages={packages.slice(1)} />}
    </div>
  )
}
