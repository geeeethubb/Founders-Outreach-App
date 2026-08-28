import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { isMissingSchema } from '@/lib/career/jobs/store'
import type { CareerRunKind } from '@/lib/career/runs'

export const dynamic = 'force-dynamic'

const KINDS: CareerRunKind[] = ['job_scout', 'job_verify', 'package', 'evidence_import']

/**
 * GET ?kind=job_scout|job_verify|package|evidence_import&limit=20
 * → { runs: [{ id, kind, label, status, started_at, completed_at, stats, error, budget,
 *      agents: [{ id, agent_id, prompt_version, model, status, cost_usd, latency_ms, tokens_in, tokens_out, created_at, error }],
 *      agent_count, cost_usd }] }
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const p = new URL(request.url).searchParams
    const kind = p.get('kind')
    const limit = Math.min(100, Math.max(1, Number(p.get('limit')) || 20))

    const db = createServiceClient()
    let q = db
      .from('scouting_runs')
      .select('id, kind, label, status, started_at, completed_at, stats, error, budget, career_mission_id, agents:agent_runs(id, agent_id, prompt_version, model, status, cost_usd, latency_ms, tokens_in, tokens_out, created_at, error)')
      .eq('user_id', user.id)
      .order('started_at', { ascending: false })
      .limit(limit)
    if (kind && KINDS.includes(kind as CareerRunKind)) q = q.eq('kind', kind)
    else if (!kind) q = q.in('kind', KINDS)
    const { data, error } = await q
    if (error) {
      if (isMissingSchema(error.message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    type Agent = { id: string; agent_id: string; prompt_version: string; model: string; status: string; cost_usd: number | null; latency_ms: number | null; tokens_in: number | null; tokens_out: number | null; created_at: string; error: string | null }
    const runs = ((data ?? []) as unknown as (Record<string, unknown> & { agents?: Agent[] })[]).map((r) => {
      const agents = [...(r.agents ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))
      return { ...r, agents, agent_count: agents.length, cost_usd: Number(agents.reduce((s, a) => s + Number(a.cost_usd ?? 0), 0).toFixed(4)) }
    })
    return NextResponse.json({ runs })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
