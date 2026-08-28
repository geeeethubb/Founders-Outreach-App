import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import {
  getApplication,
  listApplicationEvents,
  transitionApplication,
  updateApplicationDetails,
} from '@/lib/career/applications/store'
import { APPLICATION_STATES, type ApplicationState, type InterviewEntry } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const application = await getApplication(user.id, params.id)
    if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const events = await listApplicationEvents(params.id)
    return NextResponse.json({ application, events })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

interface PatchBody {
  /** A state to move to. Illegal moves are refused with 409 and the reason. */
  state?: string
  note?: string | null
  notes?: string | null
  interviews?: InterviewEntry[]
  contacts_used?: string[]
  outcome_note?: string | null
}

/**
 * Two kinds of edit on one route: a transition (state) and details
 * (notes, interviews, contacts). A transition to APPLIED locks the application
 * — that side effect lives in the store, not here.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as PatchBody

    if (body.state !== undefined) {
      if (!APPLICATION_STATES.includes(body.state as ApplicationState)) {
        return NextResponse.json({ error: `unknown state ${body.state}` }, { status: 400 })
      }
      const result = await transitionApplication(user.id, params.id, body.state as ApplicationState, {
        actor: 'user',
        note: body.note ?? null,
      })
      if (!result.ok) {
        return NextResponse.json({ error: result.error, application: result.application }, { status: result.illegal ? 409 : 500 })
      }
    }

    const details = await updateApplicationDetails(user.id, params.id, {
      notes: body.notes,
      interviews: body.interviews,
      contacts_used: body.contacts_used,
      outcome_note: body.outcome_note,
    })
    if (!details.ok) return NextResponse.json({ error: details.error }, { status: 500 })

    const application = await getApplication(user.id, params.id)
    const events = await listApplicationEvents(params.id)
    return NextResponse.json({ application, events })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
