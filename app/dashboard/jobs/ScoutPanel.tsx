'use client'

import { useEffect, useState } from 'react'
import { summarizeStats, type ScoutStats } from '@/lib/career/scout/stats'
import { api, fmtUsd } from '@/components/career/api'
import InlineNotice from '@/components/career/InlineNotice'
import { scoutingLine } from './direction'

// The route clamps to these; the sliders never offer more than it will honour.
const CAPS = { strategies: 2, rounds: 2, companies: 20, extract: 30 }

// The run streams nothing, so the panel narrates the stages it knows are
// happening — the same honesty as scout/page.tsx: an estimate, not live progress.
const STAGES = [
  'Reading the mission and the Evidence Bank',
  'Planning search strategies and seed companies',
  'Checking watched companies on their ATS boards',
  'Searching the web, round by round',
  'Resolving postings to their canonical pages',
  'Extracting structured fields from each posting',
  'Applying hard constraints and collapsing duplicates',
  'Verifying that each posting is still open',
  'Persisting and reporting',
]

interface ScoutResult {
  runId: string | null
  mission: { id: string; name: string } | null
  plan: { role_families: string[]; strategies: { name: string; kind: string; priority: number }[]; seed_companies_count: number } | null
  stats: ScoutStats
  jobs: { id?: string; title: string; company_name: string; verification_status: string }[]
  rejected: { reason: string; title: string; company: string; detail: string }[]
  errors: string[]
  costUsd: number
  latencyMs: number
}

function Slider({ label, value, max, min = 1, onChange, hint }: { label: string; value: number; max: number; min?: number; onChange: (n: number) => void; hint: string }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="font-medium text-slate-900">{value}</span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
      <span className="text-[11px] text-slate-400">{hint}</span>
    </label>
  )
}

function Histogram({ title, record }: { title: string; record: Record<string, number> }) {
  const entries = Object.entries(record).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-slate-400">none</p>
      ) : (
        <ul className="text-xs text-slate-700 space-y-0.5 mt-0.5">
          {entries.map(([k, n]) => (
            <li key={k} className="flex justify-between gap-3">
              <span className="truncate">{k}</span>
              <span className="font-medium tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function ScoutPanel({
  missionId,
  direction,
  onFinished,
  onClose,
}: {
  missionId: string | null
  /** mission.preferences.direction as the page holds it — never fetched again here. */
  direction: string | null | undefined
  onFinished: () => void
  onClose: () => void
}) {
  const [strategies, setStrategies] = useState(1)
  const [rounds, setRounds] = useState(1)
  const [companies, setCompanies] = useState(10)
  const [extract, setExtract] = useState(15)
  const [verify, setVerify] = useState(true)
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState(0)
  const [result, setResult] = useState<ScoutResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 25_000)
    return () => clearInterval(t)
  }, [running])

  async function run() {
    setRunning(true)
    setStage(0)
    setResult(null)
    setError(null)
    const r = await api<ScoutResult>('/api/career/scout', { json: { missionId, strategies, rounds, companies, extract, verify } })
    setRunning(false)
    // A 409 carries the partial result too; show whatever came back, never hide it.
    const body = (r.data ?? (r.body?.result as ScoutResult | undefined)) ?? null
    if (body) setResult(body)
    if (!r.ok) setError(r.error)
    if (r.ok) onFinished()
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-slate-900">Scout now</h2>
          <p className={`text-xs mt-0.5 ${direction?.trim() ? 'text-slate-700 font-medium' : 'text-slate-500 italic'}`}>{scoutingLine(direction)}</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Plans search strategies from what you&apos;re scouting for and the mission, checks watched companies, searches the web, extracts and
            verifies postings. One run fits the 300s web ceiling at these caps; the CLI (<code>npm run career:scout</code>) has no ceiling.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-900">
          Close
        </button>
      </div>

      {!running && !result && (
        <>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <Slider label="Strategies" value={strategies} max={CAPS.strategies} onChange={setStrategies} hint="planner strategies to execute" />
            <Slider label="Rounds" value={rounds} max={CAPS.rounds} onChange={setRounds} hint="web-search rounds per strategy" />
            <Slider label="Companies" value={companies} max={CAPS.companies} onChange={setCompanies} hint="watched companies to check" />
            <Slider label="Extract" value={extract} max={CAPS.extract} onChange={setExtract} hint="postings to extract (each is a model call)" />
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
            Verify each posting is open (fetches the page; ambiguous pages cost a model call)
          </label>
          <button type="button" onClick={run} className="mt-3 px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
            Run scout
          </button>
        </>
      )}

      {running && (
        <div className="mt-4">
          <ol className="space-y-1.5">
            {STAGES.map((s, i) => (
              <li key={s} className={`text-sm flex items-start gap-2 ${i === stage ? 'text-slate-900 font-medium' : 'text-slate-400'}`}>
                <span className="mt-0.5">{i < stage ? '✓' : i === stage ? '▸' : '·'}</span>
                {s}
              </li>
            ))}
          </ol>
          <p className="text-xs text-slate-500 mt-3">Up to five minutes. Leave the tab open — a closed tab still spends the money.</p>
        </div>
      )}

      {error && (
        <div className="mt-4">
          <InlineNotice kind="error">{error}</InlineNotice>
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              <strong>{result.jobs.length}</strong> jobs found
            </span>
            <span className="text-slate-400">·</span>
            <span>
              <strong>{result.rejected.length}</strong> rejected
            </span>
            <span className="text-slate-400">·</span>
            <span>{fmtUsd(result.costUsd)}</span>
            <span className="text-slate-400">·</span>
            <span>{(result.latencyMs / 1000).toFixed(0)}s</span>
            {result.stats?.deadline_hit && <span className="text-amber-700 font-medium">· deadline hit — partial run</span>}
          </div>
          {result.plan && (
            <p className="text-xs text-slate-600">
              Plan: {result.plan.strategies.map((s) => s.name).join(' · ') || 'none'} · role families {result.plan.role_families.join(', ') || '—'} ·{' '}
              {result.plan.seed_companies_count} seed companies
            </p>
          )}
          {result.stats && (
            <ul className="text-xs text-slate-700 font-mono space-y-0.5 rounded-md bg-white border border-slate-200 p-3">
              {summarizeStats(result.stats).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-md bg-white border border-slate-200 p-3">
            <Histogram title="Rejected by reason" record={result.stats?.jobs_rejected ?? {}} />
            <Histogram title="Verification" record={result.stats?.verification ?? {}} />
            <Histogram title="Sources" record={result.stats?.sources_consulted ?? {}} />
          </div>
          {result.errors.length > 0 && (
            <InlineNotice kind="warn">
              <p className="font-medium">{result.errors.length} error{result.errors.length === 1 ? '' : 's'} during the run</p>
              <ul className="list-disc pl-5 mt-1 space-y-0.5 text-xs">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </InlineNotice>
          )}
          {result.rejected.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-600">Rejected postings ({result.rejected.length})</summary>
              <ul className="mt-1 space-y-0.5 text-slate-600">
                {result.rejected.map((r, i) => (
                  <li key={i}>
                    <span className="font-medium text-slate-800">{r.reason}</span> — {r.title} @ {r.company}
                    {r.detail ? <span className="text-slate-400"> · {r.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
