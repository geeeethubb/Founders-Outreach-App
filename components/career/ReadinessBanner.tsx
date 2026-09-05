'use client'

// "Can scouting run here?" — asked once, before anyone pays.
//
// GET /api/scout/readiness is the server's own verdict (lib/runs/readiness.ts):
// configuration, schema, the worker's address and a real probe of the worker.
// The banner renders that verdict and nothing it did not say. A blocked kind
// reads "Scouting is unavailable: <reason> — Fix: <remedy>"; warnings are
// shown softly; an answer that could not be fetched is reported as exactly
// that, not as either verdict.

import InlineNotice from './InlineNotice'
import { api } from './api'
import { parseReadiness, readinessBlockLine, type ReadinessVerdict } from '@/app/dashboard/jobs/run-reasons'

export type ScoutKind = 'jobs' | 'people'

export type ReadinessState =
  | { phase: 'loading' }
  /** The readiness call itself failed — the verdict is unknown, not "ready". */
  | { phase: 'failed'; error: string; status: number }
  | { phase: 'known'; verdict: ReadinessVerdict }

/** Ask the server whether a run of this kind can start here. Never throws. */
export async function loadScoutReadiness(kind: ScoutKind, fresh = false): Promise<ReadinessState> {
  const r = await api<unknown>(`/api/scout/readiness${fresh ? '?fresh=1' : ''}`)
  if (!r.ok) return { phase: 'failed', error: r.error ?? `HTTP ${r.status}`, status: r.status }
  const verdict = parseReadiness(r.data ?? r.body, kind)
  if (!verdict.known) return { phase: 'failed', error: 'the readiness answer had no verdict for this scout kind', status: r.status }
  return { phase: 'known', verdict }
}

/** True only when the server said this kind cannot run. Loading and a failed check do not block — the server refuses a run it cannot execute anyway. */
export function readinessBlocks(state: ReadinessState | null | undefined): boolean {
  return state?.phase === 'known' && state.verdict.ready === false
}

/** The blocking sentence for a button's neighbour, or null. */
export function readinessBlockText(state: ReadinessState | null | undefined): string | null {
  return state?.phase === 'known' ? readinessBlockLine(state.verdict) : null
}

export default function ReadinessBanner({ state, onRecheck }: { state: ReadinessState | null | undefined; onRecheck?: () => void }) {
  if (!state || state.phase === 'loading') return <p className="text-xs text-slate-400">Checking whether scouting can run here…</p>
  if (state.phase === 'failed') {
    return (
      <InlineNotice kind="warn">
        {state.status === 401 ? 'You are signed out — sign in again to check whether scouting can run here.' : `Could not check whether scouting can run here (${state.error}).`}{' '}
        {state.status !== 401 && 'The server refuses a run it cannot execute, so a run that will not start says why.'}{' '}
        {onRecheck && (
          <button type="button" onClick={onRecheck} className="underline">
            Check again
          </button>
        )}
      </InlineNotice>
    )
  }
  const v = state.verdict
  if (v.ready === false) {
    return (
      <InlineNotice kind="error">
        <div className="font-medium">Scouting is unavailable: {v.reason ?? 'the server refused to start a run'}</div>
        {v.remedy && <div className="mt-1">Fix: {v.remedy}</div>}
        {v.code && <div className="mt-1 text-xs opacity-80">code {v.code}</div>}
        {onRecheck && (
          <button type="button" onClick={onRecheck} className="mt-1 text-xs underline">
            Check again
          </button>
        )}
      </InlineNotice>
    )
  }
  if (v.warnings.length === 0) return null
  return (
    <InlineNotice kind="warn" className="text-xs">
      <ul className="list-disc pl-4 space-y-0.5">
        {v.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </InlineNotice>
  )
}
