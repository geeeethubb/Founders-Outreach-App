'use client'

// What a People Scout run produced: the summary bar, the internal-first
// decision, the funnel, the issues, the prospects, and the people it
// researched but never ranked. The result is the server's persisted payload
// (a PeopleScoutResult) — the same one whether the run is still going,
// finished, or stopped short.
//
// Briefs are generated on demand, one prospect at a time — positioning and a
// draft cost money, and most prospects never get opened. They are not kept in
// this browser; a saved draft lives on Outreach.

import { useState } from 'react'
import type { PeopleScoutResult, ProspectView } from '@/lib/scouting/checkpoint'
import { api } from '@/components/career/api'
import type { OutreachSnapshot } from './OutreachPanel'
import ProspectCard, { type Brief } from './ProspectCard'

export default function ScoutResults({ result, goal, campaignId }: { result: PeopleScoutResult; goal: string; campaignId: string }) {
  const [open, setOpen] = useState<string | null>(null)
  const [briefs, setBriefs] = useState<Record<string, Brief>>({})
  const [briefing, setBriefing] = useState<string | null>(null)
  const [briefError, setBriefError] = useState<Record<string, string>>({})
  // Server-backed, unlike the briefs above: this is the state a refresh keeps.
  const [snapshots, setSnapshots] = useState<Record<string, OutreachSnapshot>>({})

  async function buildBrief(p: ProspectView) {
    if (briefing) return
    setBriefing(p.key)
    setBriefError((e) => ({ ...e, [p.key]: '' }))
    const r = await api<Brief>('/api/positioning', {
      json: {
        mission: { goal },
        person: { name: p.name, title: p.title, company: p.company, location: p.location, email: p.email, linkedin: p.linkedin },
        runId: result.runId ?? null,
        score: p.score,
        campaignId: campaignId || null,
        relationshipNote: p.approach,
        prospectSource: p.source,
        companyContext: p.whyCompany ?? p.whyThem,
        personContext: p.researchSummary,
        rankingEvidence: {
          whyThemSummary: p.whyThem,
          risks: p.risks,
          dimensions: p.components.map((c) => ({ dimension: c.dimension, normalized: c.normalized, explanation: c.explanation })),
        },
        withEmail: true,
      },
    })
    setBriefing(null)
    if (!r.ok || !r.data || !r.data.positioning) {
      const why = r.error ?? 'Positioning failed'
      setBriefError((er) => ({ ...er, [p.key]: `${why}${r.code ? ` [${r.code}]` : ''}${r.remedy ? ` — ${r.remedy}` : ''}` }))
      return
    }
    const data = r.data
    setBriefs((b) => ({ ...b, [p.key]: data }))
    if (data.draft && data.outreachId) {
      setSnapshots((s) => ({
        ...s,
        [p.key]: {
          id: data.outreachId as string,
          // The server decides the state: a draft with blocking findings lands in `draft`, a clean one in `ready_for_review`.
          state: data.draft?.grounding?.ok ? 'ready_for_review' : 'draft',
          subject: data.draft?.subject ?? '',
          body: data.draft?.body ?? '',
          wordCount: data.draft?.wordCount ?? null,
          grounding: data.draft?.grounding ?? null,
          recipientEmail: p.email,
        },
      }))
    }
  }

  const internal = result.internal
  const fromNetwork = result.prospects.filter((p) => p.source !== 'new').length

  return (
    <>
      <div className="mt-3 flex flex-wrap gap-4 text-sm bg-white border border-slate-200 rounded-lg p-4">
        <span>
          <strong>{result.prospects.length}</strong> prospects
        </span>
        <span className="text-slate-400">·</span>
        <span>
          <strong>{fromNetwork}</strong> from your network
        </span>
        <span className="text-slate-400">·</span>
        <span>${result.usage.costUsd.toFixed(2)} Anthropic</span>
        <span className="text-slate-400">·</span>
        <span>
          {result.usage.apolloCredits} Apollo credits
          {result.usage.apolloCallsAvoided > 0 && <span className="text-emerald-700"> ({result.usage.apolloCallsAvoided} avoided)</span>}
        </span>
        <span className="text-slate-400">·</span>
        <span>{Math.round(result.usage.latencyMs / 1000)}s of model and provider time</span>
        {result.backgroundSource &&
          (result.backgroundSource.warning || result.backgroundSource.source !== 'bank' ? (
            <span className="basis-full text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 text-xs">
              Background: fixture — {result.backgroundSource.warning ?? 'the Evidence Bank was not used for this run'}
            </span>
          ) : (
            <span className="basis-full text-xs text-slate-500">Background: {result.backgroundSource.items} items from your Evidence Bank</span>
          ))}
      </div>

      {/* ─── The internal-first decision, always shown when the run made one ── */}
      {internal ? (
        <div className={`mt-3 rounded-lg border p-4 ${internal.decision === 'INTERNAL_SUFFICIENT' ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
          <div className="text-sm font-medium text-slate-900">{internal.headline}</div>
          <ul className="mt-1.5 text-xs text-slate-600 space-y-0.5">
            {internal.reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
          {internal.indexed === 0 ? (
            <p className="mt-2 text-xs text-amber-800">
              Your existing contacts are not indexed yet. Run <code className="text-slate-700">npm run index:network</code> once and every future run searches them first.
            </p>
          ) : (
            <details className="mt-2">
              <summary className="text-xs text-slate-500 cursor-pointer">
                {internal.searches.length} search{internal.searches.length === 1 ? '' : 'es'} over {internal.indexed} indexed contacts
              </summary>
              <ul className="mt-1.5 text-xs text-slate-600 space-y-0.5">
                {internal.searches.map((s, i) => (
                  <li key={i}>
                    · “{s.query}” → {s.matches} matches, {s.shown} read
                  </li>
                ))}
              </ul>
              {internal.poolAssessment && <p className="mt-2 text-xs text-slate-600">{internal.poolAssessment}</p>}
              {internal.missingProfile.length > 0 && (
                <div className="mt-2">
                  <div className="text-xs font-medium text-slate-500">What your network is missing for this mission</div>
                  <ul className="text-xs text-slate-600 space-y-0.5 mt-0.5">
                    {internal.missingProfile.map((g, i) => (
                      <li key={i}>· {g}</li>
                    ))}
                  </ul>
                </div>
              )}
            </details>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">The run has not reached the existing-network decision yet{result.searchMode === 'external_only' ? ' (search mode skips it)' : ''}.</p>
      )}

      <div className="mt-3 text-xs text-slate-500">
        {result.funnel.companiesValidated} companies → {result.funnel.peopleEnriched} people → {result.funnel.peopleResearched} researched
        {result.funnel.peopleReused > 0 && ` · ${result.funnel.peopleReused} resolved from your database`}
      </div>

      {result.errors.length > 0 && (
        <details className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <summary className="text-sm text-amber-900 cursor-pointer">{result.errors.length} issue(s) during the run</summary>
          <ul className="mt-2 text-xs text-amber-800 space-y-1">
            {result.errors.map((e, i) => (
              <li key={i}>· {e}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 space-y-3">
        {result.prospects.map((p, i) => (
          <ProspectCard
            key={p.key}
            p={p}
            index={i}
            open={open === p.key}
            onToggle={() => setOpen(open === p.key ? null : p.key)}
            brief={briefs[p.key]}
            briefing={briefing === p.key}
            briefError={briefError[p.key] || undefined}
            snapshot={snapshots[p.key]}
            onBuildBrief={() => void buildBrief(p)}
            onSnapshot={(next) => setSnapshots((s) => ({ ...s, [p.key]: next }))}
          />
        ))}
      </div>

      {result.unranked.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm font-medium text-amber-900">Researched but not ranked before the run stopped</div>
          <p className="text-xs text-amber-800 mt-0.5">
            The dossiers exist; the ranking pass never reached them. A continuation of the run picks them up.
          </p>
          <ul className="mt-2 space-y-2">
            {result.unranked.map((u) => (
              <li key={u.key} className="text-sm">
                <span className="font-medium text-slate-900">{u.name}</span>
                <span className="text-slate-600">
                  {' '}
                  · {u.title ?? 'unknown title'} · {u.company}
                </span>
                <span className="ml-2 text-xs text-amber-800">{u.reason === 'research_failed' ? 'research failed' : 'not ranked'}</span>
                {u.verdict && <span className="ml-2 text-xs text-slate-500">verdict: {u.verdict}</span>}
                {u.researchSummary && (
                  <details className="mt-1">
                    <summary className="text-xs text-slate-500 cursor-pointer">research evidence</summary>
                    <pre className="whitespace-pre-wrap text-xs text-slate-600 bg-white rounded p-3 max-h-48 overflow-auto mt-1">{u.researchSummary}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
