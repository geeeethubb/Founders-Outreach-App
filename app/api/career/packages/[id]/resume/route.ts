import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { finishPackage } from '@/lib/career/package/orchestrator'
import { reviewResumeChanges } from '@/lib/career/package/review'
import { packageView } from '@/lib/career/package/view'
import type { ReviewDecision } from '@/lib/career/tailor/pipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MIGRATION = { error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }

interface RawDecision {
  change_id?: string
  id?: string
  action?: string
  text?: string
}

function parseDecisions(raw: unknown): ReviewDecision[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewDecision[] = []
  for (const d of raw as RawDecision[]) {
    if (!d || typeof d !== 'object') continue
    const id = d.change_id ?? d.id
    if (typeof id !== 'string' || !['approve', 'reject', 'edit'].includes(d.action ?? '')) continue
    out.push({ id, action: d.action as ReviewDecision['action'], ...(typeof d.text === 'string' ? { text: d.text } : {}) })
  }
  return out
}

/** PATCH { decisions: [{ change_id, action: 'approve'|'reject'|'edit', text? }] } | { approveAllSafe: true } → { changes, refused, updated, errors }. */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { decisions?: unknown; approveAllSafe?: boolean }
    const decisions = parseDecisions(body.decisions)
    if (!body.approveAllSafe && decisions.length === 0) return NextResponse.json({ error: 'decisions[] or approveAllSafe is required' }, { status: 400 })

    const r = await reviewResumeChanges({ userId: user.id, packageId: params.id, decisions, approveAllSafe: body.approveAllSafe === true })
    if (r.migrationMissing) return NextResponse.json(MIGRATION, { status: 409 })
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.error === 'package not found' ? 404 : 400 })
    return NextResponse.json({ changes: r.changes, refused: r.refused, updated: r.updated, errors: r.errors })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/** POST { approve: true } → build the documents from the approved changes plus the cover letter; returns the package view. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { approve?: boolean }
    if (body.approve !== true) return NextResponse.json({ error: '{ approve: true } is required' }, { status: 400 })

    const r = await finishPackage({ userId: user.id, packageId: params.id })
    if (r.migrationMissing) return NextResponse.json(MIGRATION, { status: 409 })
    if (!r.packageId) return NextResponse.json({ error: r.error ?? 'Failed', errors: r.errors }, { status: r.error === 'package not found' ? 404 : 400 })

    const view = await packageView(user.id, params.id)
    const result = { status: r.status, stage: r.stage, warnings: r.warnings, errors: r.errors, error: r.error, costUsd: r.costUsd }
    return NextResponse.json({ ...(view.view ?? {}), result }, { status: r.status === 'failed' ? 422 : 200 })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
