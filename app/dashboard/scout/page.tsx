'use client'

import { useState } from 'react'

interface Component {
  dimension: string
  normalized: number
  points: number
  max: number
  explanation: string
}

interface Prospect {
  key: string
  name: string
  title: string | null
  company: string
  location: string | null
  email: string | null
  emailStatus: string
  linkedin: string | null
  score: number
  recommendation: 'STRONG' | 'MAYBE' | 'WEAK'
  whyCompany: string | null
  whyThem: string
  whyYou: string
  backgroundIds: string[]
  risks: string
  researchSummary: string
  components: Component[]
}

interface ScoutResult {
  runId: string | null
  funnel: Record<string, number>
  prospects: Prospect[]
  usage: {
    costUsd: number
    apolloCredits: number
    webSearches: number
    modelCalls: number
    latencyMs: number
    byAgent: Record<string, { calls: number; costUsd: number; webSearches: number }>
  }
  errors: string[]
}

const DEFAULT_GOAL =
  'Find people who could realistically lead to a strong winter 2026-27 internship or short-term ' +
  'project at the intersection of industrial AI, manufacturing, and chemical or process ' +
  'engineering — people who would also matter for summer 2027 recruiting.'

// The run is long and streams nothing, so the UI narrates the pipeline it knows
// is happening. Honest about being an estimate rather than live progress.
const STAGES = [
  'Interpreting the mission and cutting it into market segments',
  'Searching the market for real companies, round by round',
  'Validating each company and deciding who to look for inside it',
  'Resolving people at the companies that survived',
  'Triaging who is worth researching in depth',
  'Researching the shortlist',
  'Ranking and assembling your list',
]

function badge(rec: Prospect['recommendation']): string {
  if (rec === 'STRONG') return 'bg-emerald-100 text-emerald-800 border-emerald-200'
  if (rec === 'MAYBE') return 'bg-amber-100 text-amber-800 border-amber-200'
  return 'bg-slate-100 text-slate-600 border-slate-200'
}

export default function ScoutPage() {
  const [goal, setGoal] = useState(DEFAULT_GOAL)
  const [geography, setGeography] = useState('United States')
  const [segments, setSegments] = useState(3)
  const [depth, setDepth] = useState(15)

  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState(0)
  const [result, setResult] = useState<ScoutResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  async function run() {
    setRunning(true)
    setError(null)
    setResult(null)
    setStage(0)

    // Rough pacing so the page does not look frozen for ten minutes.
    const ticker = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 60_000)

    try {
      const res = await fetch('/api/scout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, geography, segments, maxDeepResearch: depth }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Scouting failed')
      setResult(data as ScoutResult)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scouting failed')
    } finally {
      clearInterval(ticker)
      setRunning(false)
    }
  }

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold text-slate-900">Scout Opportunities</h1>
      <p className="text-sm text-slate-600 mt-1">
        Describe what you are looking for. The system finds the companies, picks who to contact
        inside them, researches the shortlist, and ranks the result.
      </p>

      {/* ─── Mission ─────────────────────────────────────────────────────── */}
      <div className="mt-6 bg-white border border-slate-200 rounded-lg p-5">
        <label className="block text-sm font-medium text-slate-700">Mission</label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          disabled={running}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
        />

        <div className="grid grid-cols-3 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">Geography</label>
            <input
              value={geography}
              onChange={(e) => setGeography(e.target.value)}
              disabled={running}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Market segments</label>
            <input
              type="number"
              min={1}
              max={4}
              value={segments}
              onChange={(e) => setSegments(Number(e.target.value))}
              disabled={running}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">
              People to research deeply
            </label>
            <input
              type="number"
              min={5}
              max={25}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
              disabled={running}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
            <p className="text-xs text-slate-500 mt-1">The main cost driver.</p>
          </div>
        </div>

        <button
          onClick={run}
          disabled={running || !goal.trim()}
          className="mt-5 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:bg-slate-300"
        >
          {running ? 'Scouting…' : 'Scout Opportunities'}
        </button>
        {running && (
          <p className="text-xs text-slate-500 mt-2">
            This takes several minutes. Leave the tab open.
          </p>
        )}
      </div>

      {/* ─── Progress ────────────────────────────────────────────────────── */}
      {running && (
        <div className="mt-6 bg-white border border-slate-200 rounded-lg p-5">
          <ol className="space-y-2">
            {STAGES.map((s, i) => (
              <li
                key={s}
                className={`text-sm flex items-start gap-2 ${
                  i < stage ? 'text-slate-400' : i === stage ? 'text-slate-900 font-medium' : 'text-slate-400'
                }`}
              >
                <span className="mt-0.5">{i < stage ? '✓' : i === stage ? '▸' : '·'}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
      )}

      {error && (
        <div className="mt-6 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* ─── Results ─────────────────────────────────────────────────────── */}
      {result && (
        <>
          <div className="mt-6 flex flex-wrap gap-4 text-sm bg-white border border-slate-200 rounded-lg p-4">
            <span><strong>{result.prospects.length}</strong> prospects</span>
            <span className="text-slate-400">·</span>
            <span>${result.usage.costUsd.toFixed(2)} Anthropic</span>
            <span className="text-slate-400">·</span>
            <span>{result.usage.apolloCredits} Apollo credits</span>
            <span className="text-slate-400">·</span>
            <span>{Math.round(result.usage.latencyMs / 1000)}s</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">
              {result.funnel.companiesValidated} companies → {result.funnel.peopleEnriched} people →{' '}
              {result.funnel.peopleResearched} researched
            </span>
          </div>

          {result.errors.length > 0 && (
            <details className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <summary className="text-sm text-amber-900 cursor-pointer">
                {result.errors.length} issue(s) during the run
              </summary>
              <ul className="mt-2 text-xs text-amber-800 space-y-1">
                {result.errors.map((e, i) => <li key={i}>· {e}</li>)}
              </ul>
            </details>
          )}

          <div className="mt-4 space-y-3">
            {result.prospects.map((p, i) => (
              <div key={p.key} className="bg-white border border-slate-200 rounded-lg">
                <button
                  onClick={() => setOpen(open === p.key ? null : p.key)}
                  className="w-full text-left p-4 flex items-start gap-4 hover:bg-slate-50"
                >
                  <span className="text-slate-400 text-sm w-6 shrink-0 pt-0.5">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-900">{p.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded border ${badge(p.recommendation)}`}>
                        {p.recommendation}
                      </span>
                      <span className="text-xs text-slate-500">score {p.score}</span>
                    </div>
                    <div className="text-sm text-slate-600 mt-0.5">
                      {p.title ?? 'unknown title'} · <strong>{p.company}</strong>
                      {p.location ? ` · ${p.location}` : ''}
                    </div>
                    <p className="text-sm text-slate-500 mt-1 line-clamp-2">{p.whyYou}</p>
                  </div>
                  <span className="text-slate-400 text-sm shrink-0">{open === p.key ? '▲' : '▼'}</span>
                </button>

                {open === p.key && (
                  <div className="border-t border-slate-200 p-4 space-y-4 text-sm">
                    <Section title="Why this company fits">
                      {p.whyCompany ?? 'No company description was captured.'}
                    </Section>
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
                            <span className="w-44 text-xs text-slate-500 shrink-0">
                              {c.dimension.replace(/_/g, ' ')}
                            </span>
                            <div className="flex-1 bg-slate-100 rounded h-1.5 overflow-hidden">
                              <div
                                className="bg-indigo-500 h-full"
                                style={{ width: `${Math.round(c.normalized * 100)}%` }}
                              />
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
                      <pre className="whitespace-pre-wrap text-xs text-slate-600 bg-slate-50 rounded p-3 max-h-64 overflow-auto">
                        {p.researchSummary}
                      </pre>
                    </Section>

                    <div className="flex gap-4 pt-1 text-xs">
                      {p.linkedin && (
                        <a href={p.linkedin} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                          LinkedIn
                        </a>
                      )}
                      <span className="text-slate-500">
                        {p.email ? p.email : `no email (${p.emailStatus})`}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{title}</div>
      <div className="mt-1 text-slate-700">{children}</div>
    </div>
  )
}
