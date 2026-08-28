'use client'

import { useState } from 'react'
import { fmtUsd } from '@/components/career/api'
import { formatRelativeTime } from '@/lib/utils'

export interface AgentRunView {
  id: string
  agent_id: string
  prompt_version: string
  model: string
  status: string
  cost_usd: number | null
  latency_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  created_at: string
  error: string | null
}

export interface RunView {
  id: string
  kind: string
  label: string | null
  status: string
  started_at: string
  completed_at: string | null
  stats: unknown
  error: string | null
  budget: unknown
  career_mission_id: string | null
  agents: AgentRunView[]
  agent_count: number
  cost_usd: number
}

const STATUS_STYLE: Record<string, string> = {
  succeeded: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
}

function duration(a: string, b: string | null): string {
  if (!b) return '…'
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** One run: the header answers "what, when, how much"; expanding answers "why that much" agent by agent. */
export default function RunRow({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left px-3 py-2 flex items-center gap-3 flex-wrap text-xs">
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
        <span className="font-mono text-slate-700">{run.kind}</span>
        <span className="text-slate-800">{run.label ?? '—'}</span>
        <span className={`px-1.5 py-0.5 rounded border ${STATUS_STYLE[run.status] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>{run.status}</span>
        <span className="text-slate-500">
          {formatRelativeTime(run.started_at).toLowerCase()} · {duration(run.started_at, run.completed_at)}
        </span>
        <span className="ml-auto text-slate-600 tabular-nums">
          {run.agent_count} agent call{run.agent_count === 1 ? '' : 's'} · {fmtUsd(run.cost_usd)}
        </span>
      </button>
      {run.error && <p className="px-3 pb-2 text-xs text-rose-700">{run.error}</p>}
      {open && (
        <div className="border-t border-slate-100 px-3 py-2 space-y-3">
          {run.agents.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="pr-2 font-semibold">agent</th>
                    <th className="pr-2 font-semibold">prompt</th>
                    <th className="pr-2 font-semibold">model</th>
                    <th className="pr-2 font-semibold">status</th>
                    <th className="pr-2 font-semibold text-right">cost</th>
                    <th className="pr-2 font-semibold text-right">latency</th>
                    <th className="pr-2 font-semibold text-right">tokens in/out</th>
                    <th className="font-semibold">error</th>
                  </tr>
                </thead>
                <tbody>
                  {run.agents.map((a) => (
                    <tr key={a.id} className="border-t border-slate-100 align-top">
                      <td className="pr-2 py-1 font-mono text-slate-800">{a.agent_id}</td>
                      <td className="pr-2 py-1 text-slate-500">{a.prompt_version}</td>
                      <td className="pr-2 py-1 text-slate-600">{a.model}</td>
                      <td className={`pr-2 py-1 ${a.status === 'failed' ? 'text-rose-700' : 'text-slate-600'}`}>{a.status}</td>
                      <td className="pr-2 py-1 text-right tabular-nums">{fmtUsd(a.cost_usd)}</td>
                      <td className="pr-2 py-1 text-right tabular-nums">{a.latency_ms !== null ? `${(a.latency_ms / 1000).toFixed(1)}s` : '—'}</td>
                      <td className="pr-2 py-1 text-right tabular-nums">
                        {a.tokens_in ?? '—'} / {a.tokens_out ?? '—'}
                      </td>
                      <td className="py-1 text-rose-700">{a.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-slate-400">No agent calls were traced for this run.</p>
          )}
          <div>
            <p className="text-[11px] font-semibold text-slate-500 mb-1">stats</p>
            <pre className="text-[11px] text-slate-700 bg-slate-50 rounded-md border border-slate-200 p-2 overflow-x-auto max-h-80">{JSON.stringify(run.stats ?? null, null, 2)}</pre>
          </div>
          {run.budget ? (
            <div>
              <p className="text-[11px] font-semibold text-slate-500 mb-1">budget</p>
              <pre className="text-[11px] text-slate-600 bg-slate-50 rounded-md border border-slate-200 p-2 overflow-x-auto">{JSON.stringify(run.budget, null, 2)}</pre>
            </div>
          ) : null}
          <p className="text-[10px] text-slate-400 font-mono">run {run.id}</p>
        </div>
      )}
    </div>
  )
}
