import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getOutreach,
  saveEdit,
  transition,
  recordOutcome,
  MigrationMissingError,
} from '@/lib/outreach/store'
import { checkGrounding, summarizeGrounding } from '@/lib/outreach/grounding'
import { isOutcome, isOutreachState } from '@/lib/outreach/states'
import { isDynamicUsage } from '@/lib/http/dynamic'

// This route reads cookies. See lib/http/dynamic.ts for why that has to be
// declared rather than discovered.
export const dynamic = 'force-dynamic'

interface PatchBody {
  action: 'approve' | 'skip' | 'unapprove' | 'edit' | 'outcome' | 'state'
  body?: string
  subject?: string
  outcome?: string
  note?: string
  state?: string
}

/**
 * The approval surface.
 *
 * Approve and Send are separate actions on purpose (and separate routes): a
 * combined button makes the irreversible step one click away from the
 * reversible one, and this is the gate that CLAUDE.md principle 10 exists to
 * protect.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as PatchBody
    const current = await getOutreach(user.id, params.id)
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    switch (body.action) {
      case 'edit': {
        const edited = (body.body ?? '').trim()
        if (!edited) return NextResponse.json({ error: 'An empty body cannot be saved' }, { status: 400 })
        // Re-gate every edit. Approving clean text and then pasting in an
        // unsupported figure is the exact hole this closes.
        const grounding = checkGrounding({
          subject: body.subject ?? current.subject ?? '',
          body: edited,
          evidence: current.allowed_claims ?? [],
        })
        const row = await saveEdit(user.id, params.id, edited, body.subject ?? null, grounding)
        return NextResponse.json({ outreach: row, grounding })
      }

      case 'approve': {
        const finalBody = current.body_edited ?? current.body ?? ''
        const grounding = checkGrounding({
          subject: current.subject ?? '',
          body: finalBody,
          evidence: current.allowed_claims ?? [],
        })
        if (!grounding.ok) {
          return NextResponse.json(
            {
              error: `Cannot approve — ${summarizeGrounding(grounding)}`,
              grounding,
            },
            { status: 422 }
          )
        }
        const row = await transition(user.id, params.id, 'approved', 'user', { grounding })
        return NextResponse.json({ outreach: row, grounding })
      }

      case 'skip':
        return NextResponse.json({
          outreach: await transition(user.id, params.id, 'skipped', 'user'),
        })

      case 'unapprove':
        return NextResponse.json({
          outreach: await transition(user.id, params.id, 'draft', 'user'),
        })

      case 'outcome': {
        if (!isOutcome(body.outcome)) {
          return NextResponse.json({ error: `Unknown outcome: ${body.outcome}` }, { status: 400 })
        }
        return NextResponse.json({
          outreach: await recordOutcome(user.id, params.id, body.outcome, body.note),
        })
      }

      case 'state': {
        if (!isOutreachState(body.state)) {
          return NextResponse.json({ error: `Unknown state: ${body.state}` }, { status: 400 })
        }
        // Never a back door to sending: `sending` is claimed by the send path's
        // compare-and-swap and by nothing else.
        if (body.state === 'sending' || body.state === 'sent') {
          return NextResponse.json(
            { error: 'Sending happens through the send endpoint, not by setting state.' },
            { status: 400 }
          )
        }
        return NextResponse.json({
          outreach: await transition(user.id, params.id, body.state, 'user'),
        })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
    }
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    if (error instanceof MigrationMissingError) {
      return NextResponse.json({ error: error.message, migrationMissing: true }, { status: 503 })
    }
    console.error('Outreach update failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Update failed' },
      { status: 400 }
    )
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const row = await getOutreach(user.id, params.id)
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ outreach: row })
}
