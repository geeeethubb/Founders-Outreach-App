import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { isMissingSchema } from '@/lib/career/jobs/store'
import type { CareerRunKind } from '@/lib/career/runs'
import {
  ACTIVE_STATUSES,
  DEFAULT_STALE_MS,
  getRunJobCounts,
  isRunStale,
  listActiveScoutRuns,
  readProgress,
  toRunView,
  type ScoutRunRow,
  type ScoutRunView,
} from '@/lib/career/scout/run-store'

export const dynamic = 'force-dynamic'

const KINDS: CareerRunKind[] = ['job_scout', 'job_verify', 'package', 'evidence_import']

const BASE_COLUMNS = 'id, kind, label, status, started_at, completed_at, stats, error, budget, career_mission_id'
// Migration 016. Selected separately so a pre-016 database degrades to the base
// list instead of erroring on an unknown column.
const DURABLE_COLUMNS = 'stage, progress, heartbeat_at, worker_started_at'
const AGENT_COLUMNS = 'agents:agent_runs(id, agent_id, prompt_version, model, status, cost_usd, latency_ms, tokens_in, tokens_out, created_at, error)'

/**
 * A run that died without finishing used to be labelled 'abandoned' by this
 * route alone — a display-only guess from `started_at`, invented on every
 * read and written nowhere. After migration 016 a dead run is REAPED into a
 * real 'partial' or 'failed' status (lib/career/scout/run-store.ts), so what
 * is left here is only the window between the death and the next reap:
 * 'running' with a heartbeat that has gone quiet, which we show as 'stalled'.
 */
const STALLED_NO_HEARTBEAT_MS = 25 * 60 * 1000

/**
 * 'stalled' uses `isRunStale` — the SAME test the reaper uses — so this page
 * cannot call a run stalled while the reaper still considers it alive. A scout
 * is legitimately silent for minutes (one live planner call took 226s), so
 * silence alone is never enough: the run must also be past the deadline it was
 * claimed with. A run with no heartbeat at all (a pre-016 row, or a kind that
 * never heartbeats) falls back to its age.
 */
function displayStatus(row: ScoutRunRow, now: number): string {
  if (row.status !== 'running') return String(row.status ?? 'unknown')
  if (Number.isFinite(Date.parse(String(row.heartbeat_at ?? '')))) {
    return isRunStale(row, DEFAULT_STALE_MS, now) ? 'stalled' : 'running'
  }
  const started = Date.parse(String(row.started_at ?? ''))
  return Number.isFinite(started) && now - started > STALLED_NO_HEARTBEAT_MS ? 'stalled' : 'running'
}

/**
 * GET ?kind=job_scout|job_verify|package|evidence_import&limit=20&active=1
 * → { runs: [{ id, kind, label, status, stage, detail, counts, events, started_at,
 *      heartbeat_at, completed_at, stats, error, budget, agents: [...], agent_count, cost_usd }],
 *     active: ScoutRunView | null, durable }
 *
 * `active=1` also returns the newest queued/running job-scout run with its job
 * counts, so the Jobs page can resume watching a run after a page refresh —
 * that is the only place a running scout is remembered.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const p = new URL(request.url).searchParams
    const kind = p.get('kind')
    const limit = Math.min(100, Math.max(1, Number(p.get('limit')) || 20))
    const wantActive = p.get('active') === '1' || p.get('active') === 'true'

    const db = createServiceClient()
    const query = (columns: string) => {
      let q = db
        .from('scouting_runs')
        .select(columns)
        .eq('user_id', user.id)
        .order('started_at', { ascending: false })
        .limit(limit)
      if (kind && KINDS.includes(kind as CareerRunKind)) q = q.eq('kind', kind)
      else if (!kind) q = q.in('kind', KINDS)
      return q
    }

    let durable = true
    let { data, error } = await query(`${BASE_COLUMNS}, ${DURABLE_COLUMNS}, ${AGENT_COLUMNS}`)
    if (error && isMissingSchema(error.message)) {
      durable = false
      ;({ data, error } = await query(`${BASE_COLUMNS}, ${AGENT_COLUMNS}`))
    }
    if (error) {
      if (isMissingSchema(error.message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    type Agent = { id: string; agent_id: string; prompt_version: string; model: string; status: string; cost_usd: number | null; latency_ms: number | null; tokens_in: number | null; tokens_out: number | null; created_at: string; error: string | null }
    const now = Date.now()
    const runs = ((data ?? []) as unknown as (Record<string, unknown> & { agents?: Agent[]; status?: string; started_at?: string; heartbeat_at?: string | null })[]).map((r) => {
      const agents = [...(r.agents ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))
      const progress = readProgress(r as unknown as ScoutRunRow)
      return {
        ...r,
        status: displayStatus(r as unknown as ScoutRunRow, now),
        // The persisted status, unmodified — 'partial' is a real outcome now,
        // and 'stalled' above is the only thing this route still invents.
        persisted_status: r.status ?? null,
        stage: progress.stage,
        detail: progress.detail,
        counts: progress.counts,
        events: progress.events,
        agents,
        agent_count: agents.length,
        cost_usd: Number(agents.reduce((s, a) => s + Number(a.cost_usd ?? 0), 0).toFixed(4)),
      }
    })

    let active: ScoutRunView | null = null
    if (wantActive) {
      const res = await listActiveScoutRuns(user.id)
      if (res.migrationMissing) durable = false
      const row = res.runs.find((r) => (r.kind ?? 'job_scout') === 'job_scout' && (ACTIVE_STATUSES as string[]).includes(r.status)) ?? null
      if (row) active = toRunView(row, await getRunJobCounts(user.id, row.id), now)
    }

    return NextResponse.json({ runs, active, durable })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
