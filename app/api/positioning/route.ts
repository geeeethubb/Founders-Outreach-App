import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runPositioning, renderPositioning } from '@/lib/agents/positioning'
import { runOutreach } from '@/lib/agents/outreach'
import { RESUME_ITEMS } from '@/evals/phase3/user-profile'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'

export const maxDuration = 180

interface Body {
  mission: { goal: string; timeframe?: string }
  person: { name: string; firstName?: string; title: string | null; company: string; location?: string | null }
  companyContext: string
  personContext: string
  rankingEvidence: {
    whyThemSummary: string
    risks: string
    dimensions: { dimension: string; normalized: number; explanation: string }[]
  }
  /** Skip drafting when the user only wants to see the angle. */
  withEmail?: boolean
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as Body
    if (!body.person?.name) return NextResponse.json({ error: 'A prospect is required' }, { status: 400 })

    resetAnthropicUsage()

    const background = RESUME_ITEMS.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      org: i.org,
      period: i.period,
      summary: i.summary,
      domains: i.domains,
      credibility: i.credibility,
    }))
    const byId = new Map(background.map((b) => [b.id, b]))

    const mission = { goal: body.mission.goal, timeframe: body.mission.timeframe ?? 'Winter 2026-27' }
    const ctx = {
      user_id: user.id,
      run_id: null,
      budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 5 },
    }

    const pos = await runPositioning(
      {
        mission,
        person: {
          name: body.person.name,
          title: body.person.title,
          company: body.person.company,
          location: body.person.location ?? null,
        },
        companyContext: body.companyContext,
        personContext: body.personContext,
        rankingEvidence: body.rankingEvidence,
        background,
      },
      ctx
    )

    if (!pos.output) {
      return NextResponse.json({ error: `Positioning failed: ${pos.error}` }, { status: 502 })
    }

    let draft = null
    if (body.withEmail !== false) {
      // Two evidence classes, kept apart: the brief is the argument, these are
      // what may be asserted as fact. Mixing them produced invented details.
      const companyFacts = body.companyContext
        .split(/(?<=\.)\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 30)
        .slice(0, 3)
        .map((s) => `THEIR COMPANY: ${s}`)

      const personFacts = body.personContext
        .split('\n')
        .filter((l) => l.trim().startsWith('•'))
        .map((l) => `RECIPIENT: ${l.replace(/^\s*•\s*/, '')}`)
        .slice(0, 8)

      const allowed = [
        ...companyFacts,
        ...personFacts,
        `RECIPIENT: ${body.person.title ?? 'unknown title'} at ${body.person.company}`,
        ...pos.output.top_proof_points.map(
          (pp) => `SENDER: ${byId.get(pp.background_id)?.summary ?? pp.background_id}`
        ),
      ]

      const out = await runOutreach(
        {
          mission,
          sender: { name: 'Zuyu Liu', signoffContext: 'undergraduate, chemical engineering' },
          person: {
            name: body.person.name,
            firstName: body.person.firstName || body.person.name.split(' ')[0],
            title: body.person.title,
            company: body.person.company,
          },
          positioning: renderPositioning(pos.output, byId),
          groundedFacts: allowed,
          wordTarget: { min: 60, max: 120 },
        },
        ctx
      )
      if (out.output) {
        draft = { ...out.output, allowedClaims: allowed }
      }
    }

    const usage = anthropicUsage()

    return NextResponse.json({
      positioning: {
        ...pos.output,
        // Resolve ids to titles so the card can show what was chosen without
        // the client needing its own copy of the background list.
        proofPoints: pos.output.top_proof_points.map((pp) => ({
          id: pp.background_id,
          title: byId.get(pp.background_id)?.title ?? pp.background_id,
          org: byId.get(pp.background_id)?.org ?? '',
          why: pp.why_it_matters,
        })),
      },
      draft,
      usage: { costUsd: Number(usage.costUsd.toFixed(4)), calls: usage.calls },
    })
  } catch (error) {
    console.error('Positioning failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Positioning failed' },
      { status: 500 }
    )
  }
}
