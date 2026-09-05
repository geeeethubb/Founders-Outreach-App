'use client'

// One prospect: the card, its evidence, and the positioning + draft flow.
// Briefs are built by the parent (it owns the state and the API call) so a
// card is only ever rendering what it was given.

import Link from 'next/link'
import type { ProspectView } from '@/lib/scouting/checkpoint'
import OutreachPanel, { type Grounding, type OutreachSnapshot } from './OutreachPanel'

export interface ProofPoint {
  id: string
  title: string
  org: string
  why: string
}

export interface Positioning {
  positioning_thesis: string
  proofPoints: ProofPoint[]
  recipient_priorities: string[]
  why_me: string
  why_now: string
  do_not_mention: { item: string; reason: string }[]
  recommended_ask: string
  confidence: number
  risks: string
}

export interface Draft {
  subject: string
  body: string
  wordCount: number
  alternate_angle: string
  lengthWarning: string | null
  grounding: Grounding | null
}

export interface ReferenceSummary {
  campaignName: string
  words: number
  targetWords: { min: number; max: number }
  summary: string
  structure: string[]
  distinctiveMoves: string[]
  recipientSpecific: string[]
}

export interface Brief {
  positioning: Positioning
  draft: Draft | null
  outreachId: string | null
  persistError: string | null
  referenceWarning: string | null
  reference: ReferenceSummary | null
  usage: { costUsd: number; calls: number }
}

function sourceBadge(source: ProspectView['source']): { label: string; className: string } {
  if (source === 'existing') return { label: 'existing contact', className: 'bg-sky-50 text-sky-700 border-sky-200' }
  if (source === 'existing_rediscovered') return { label: 'existing + rediscovered', className: 'bg-violet-50 text-violet-700 border-violet-200' }
  return { label: 'newly discovered', className: 'bg-slate-50 text-slate-600 border-slate-200' }
}

function badge(rec: ProspectView['recommendation']): string {
  if (rec === 'STRONG') return 'bg-emerald-100 text-emerald-800 border-emerald-200'
  if (rec === 'MAYBE') return 'bg-amber-100 text-amber-800 border-amber-200'
  return 'bg-slate-100 text-slate-600 border-slate-200'
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{title}</div>
      <div className="mt-1 text-slate-700">{children}</div>
    </div>
  )
}

export default function ProspectCard({
  p,
  index,
  open,
  onToggle,
  brief,
  briefing,
  briefError,
  snapshot,
  onBuildBrief,
  onSnapshot,
}: {
  p: ProspectView
  index: number
  open: boolean
  onToggle: () => void
  brief: Brief | undefined
  briefing: boolean
  briefError: string | undefined
  snapshot: OutreachSnapshot | undefined
  onBuildBrief: () => void
  onSnapshot: (next: OutreachSnapshot) => void
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg">
      <button onClick={onToggle} className="w-full text-left p-4 flex items-start gap-4 hover:bg-slate-50">
        <span className="text-slate-400 text-sm w-6 shrink-0 pt-0.5">{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-slate-900">{p.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded border ${badge(p.recommendation)}`}>{p.recommendation}</span>
            <span className={`text-xs px-2 py-0.5 rounded border ${sourceBadge(p.source).className}`}>{sourceBadge(p.source).label}</span>
            {p.relationshipStatus && p.relationshipStatus !== 'never_contacted' && (
              <span className="text-xs px-2 py-0.5 rounded border bg-amber-50 text-amber-800 border-amber-200">{p.relationshipStatus.replace(/_/g, ' ')}</span>
            )}
            <span className="text-xs text-slate-500">score {p.score}</span>
          </div>
          <div className="text-sm text-slate-600 mt-0.5">
            {p.title ?? 'unknown title'} · <strong>{p.company}</strong>
            {p.location ? ` · ${p.location}` : ''}
          </div>
          <p className="text-sm text-slate-500 mt-1 line-clamp-2">{p.whyYou}</p>
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-200 p-4 space-y-4 text-sm">
          {p.approach && (
            <div className="bg-amber-50 border border-amber-200 rounded p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-amber-700">You have history with this person</div>
              <p className="mt-1 text-amber-900">{p.approach}</p>
            </div>
          )}

          {p.internalReason && <Section title="Why your network surfaced them">{p.internalReason}</Section>}

          <Section title="Why this company fits">{p.whyCompany ?? 'No company description was captured.'}</Section>
          <Section title="Why this person">{p.whyThem}</Section>
          <Section title="Why you, to them">{p.whyYou}</Section>

          {p.backgroundIds.length > 0 && (
            <Section title="Your background this rests on">
              <div className="flex flex-wrap gap-1.5">
                {p.backgroundIds.map((id) => (
                  <span key={id} className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">
                    {id}
                  </span>
                ))}
              </div>
            </Section>
          )}

          <Section title="Score breakdown">
            <div className="space-y-1">
              {p.components.map((c) => (
                <div key={c.dimension} className="flex items-center gap-3">
                  <span className="w-44 text-xs text-slate-500 shrink-0">{c.dimension.replace(/_/g, ' ')}</span>
                  <div className="flex-1 bg-slate-100 rounded h-1.5 overflow-hidden">
                    <div className="bg-indigo-500 h-full" style={{ width: `${Math.round(c.normalized * 100)}%` }} />
                  </div>
                  <span className="text-xs text-slate-500 w-12 text-right shrink-0">
                    {c.points}/{c.max}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {p.risks && <Section title="Risks">{p.risks}</Section>}

          <Section title="Research evidence">
            <pre className="whitespace-pre-wrap text-xs text-slate-600 bg-slate-50 rounded p-3 max-h-64 overflow-auto">{p.researchSummary}</pre>
          </Section>

          {/* ─── Positioning + outreach ──────────────────── */}
          <div className="border-t border-slate-200 pt-4">
            {!brief && (
              <div>
                <button
                  onClick={onBuildBrief}
                  disabled={briefing}
                  className="px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-md hover:bg-slate-700 disabled:bg-slate-300"
                >
                  {briefing ? 'Working…' : 'Build positioning + draft'}
                </button>
                <span className="ml-2 text-xs text-slate-500">about 30 seconds</span>
                {briefError && <p className="text-xs text-red-700 mt-2">{briefError}</p>}
              </div>
            )}

            {brief && <BriefView brief={brief} p={p} briefing={briefing} snapshot={snapshot} onBuildBrief={onBuildBrief} onSnapshot={onSnapshot} />}
          </div>

          <div className="flex gap-4 pt-1 text-xs">
            {p.linkedin && (
              <a href={p.linkedin} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                LinkedIn
              </a>
            )}
            <span className="text-slate-500">{p.email ? p.email : `no email (${p.emailStatus})`}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function BriefView({
  brief,
  p,
  briefing,
  snapshot,
  onBuildBrief,
  onSnapshot,
}: {
  brief: Brief
  p: ProspectView
  briefing: boolean
  snapshot: OutreachSnapshot | undefined
  onBuildBrief: () => void
  onSnapshot: (next: OutreachSnapshot) => void
}) {
  return (
    <div className="space-y-4">
      {brief.reference && (
        <div className="bg-white border border-slate-200 rounded p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Written in the voice of “{brief.reference.campaignName}”</div>
          <p className="mt-1 text-slate-700">{brief.reference.summary}</p>
          <p className="mt-1 text-xs text-slate-500">
            reference is {brief.reference.words} words → this draft targets {brief.reference.targetWords.min}–{brief.reference.targetWords.max}
          </p>
        </div>
      )}
      {brief.referenceWarning && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">{brief.referenceWarning}</p>}

      <div className="bg-indigo-50 border border-indigo-100 rounded p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-indigo-500">Positioning thesis</div>
        <p className="mt-1 text-slate-900">{brief.positioning.positioning_thesis}</p>
        <div className="mt-1 text-xs text-slate-500">confidence {(brief.positioning.confidence * 100).toFixed(0)}%</div>
      </div>

      <Section title="Strongest proof points">
        <ul className="space-y-1.5">
          {brief.positioning.proofPoints.map((pp) => (
            <li key={pp.id}>
              <span className="font-medium">{pp.title}</span>
              <span className="text-slate-500"> — {pp.org}</span>
              <div className="text-slate-600 text-xs mt-0.5">{pp.why}</div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Why you, to them">{brief.positioning.why_me}</Section>
      <Section title="Why now">{brief.positioning.why_now}</Section>
      <Section title="Recommended ask">{brief.positioning.recommended_ask}</Section>

      {brief.positioning.do_not_mention.length > 0 && (
        <Section title="Do not mention">
          <ul className="space-y-0.5">
            {brief.positioning.do_not_mention.map((d, i) => (
              <li key={i} className="text-slate-600 text-xs">
                <span className="text-slate-900">{d.item}</span> — {d.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {brief.persistError && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
          This draft was not saved: {brief.persistError}. It will be lost on refresh.
        </p>
      )}

      {snapshot ? (
        <OutreachPanel
          outreach={snapshot}
          onChange={onSnapshot}
          footnote={
            <>
              <span className="font-medium">Alternate angle:</span> {brief.draft?.alternate_angle}
              <button
                onClick={() => {
                  const draft = brief.draft
                  const touched = snapshot.state === 'approved' || snapshot.body !== draft?.body || snapshot.subject !== draft?.subject
                  if (touched && !confirm('Regenerating replaces this draft and discards your edits/approval. Continue?')) return
                  onBuildBrief()
                }}
                disabled={briefing}
                className="ml-3 underline hover:text-slate-700 disabled:text-slate-300"
              >
                {briefing ? 'Working…' : 'Regenerate (~30 s, paid)'}
              </button>
              {brief.outreachId && (
                <Link href="/dashboard/outreach" className="ml-3 text-indigo-600 hover:underline">
                  Saved to Outreach →
                </Link>
              )}
            </>
          }
        />
      ) : (
        brief.draft && <p className="text-xs text-slate-500">Draft generated but not saved — approval and sending need it stored.</p>
      )}
      {!p.email && snapshot && <p className="text-xs text-slate-500">No email on record ({p.emailStatus}); the draft can be approved but not sent from here.</p>}
    </div>
  )
}
