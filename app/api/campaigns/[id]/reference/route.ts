// The campaign reference email: read it, replace it, remove it.
//
// PUT stores the email and immediately analyses it, so the founder sees what the
// system learned from their example before they generate anything with it.
// That feedback loop is the point — a style analysis nobody reads is just a
// hidden prompt.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getCampaignReference,
  saveCampaignReference,
  clearCampaignReference,
  ensureReferenceStyle,
  ReferenceMigrationMissingError,
} from '@/lib/campaigns/reference'

export const maxDuration = 60

function errorResponse(e: unknown) {
  if (e instanceof ReferenceMigrationMissingError) {
    return NextResponse.json({ error: e.message, migrationMissing: true }, { status: 503 })
  }
  return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const reference = await getCampaignReference(user.id, params.id)
    if (!reference) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    return NextResponse.json({ reference })
  } catch (e) {
    return errorResponse(e)
  }
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as {
      subject?: string | null
      body?: string
      notes?: string | null
      targetAudience?: string | null
      analyse?: boolean
    }
    if (!body.body?.trim()) {
      return NextResponse.json({ error: 'Paste the email you want this campaign to sound like.' }, { status: 400 })
    }

    await saveCampaignReference(user.id, params.id, {
      subject: body.subject ?? null,
      body: body.body,
      notes: body.notes ?? null,
      targetAudience: body.targetAudience ?? null,
    })

    // Analyse straight away unless told not to. The founder should be able to
    // read what the system took from their email before trusting it with one.
    if (body.analyse === false) {
      const reference = await getCampaignReference(user.id, params.id)
      return NextResponse.json({ reference, analysed: false, costUsd: 0 })
    }

    const result = await ensureReferenceStyle(user.id, params.id, {
      user_id: user.id,
      run_id: null,
      budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 3 },
    })

    return NextResponse.json({
      reference: result.reference,
      analysed: result.analysed,
      costUsd: Number(result.costUsd.toFixed(4)),
      // Surfaced, never hidden: a stored reference with a failed analysis still
      // works (the writer falls back to the house style), but the user must know.
      warning: result.error,
    })
  } catch (e) {
    return errorResponse(e)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    await clearCampaignReference(user.id, params.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return errorResponse(e)
  }
}
