import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runPositioning, renderPositioning } from '@/lib/agents/positioning'
import { positioningPrompt } from '@/lib/agents/positioning/prompt'
import { runOutreach } from '@/lib/agents/outreach'
import { outreachPrompt } from '@/lib/agents/outreach/prompt'
import { RESUME_ITEMS } from '@/evals/phase3/user-profile'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'
import { buildEvidence, buildVerificationPool, safeNamesFor } from '@/lib/outreach/evidence'
import { checkGrounding } from '@/lib/outreach/grounding'
import { resolveContactId, saveDraft, MigrationMissingError } from '@/lib/outreach/store'

export const maxDuration = 180

interface Body {
  mission: { goal: string; timeframe?: string }
  person: {
    name: string
    firstName?: string
    title: string | null
    company: string
    location?: string | null
    email?: string | null
    linkedin?: string | null
  }
  companyContext: string
  personContext: string
  rankingEvidence: {
    whyThemSummary: string
    risks: string
    dimensions: { dimension: string; normalized: number; explanation: string }[]
  }
  /** Skip drafting when the user only wants to see the angle. */
  withEmail?: boolean
  /** Persist the result so approval survives a refresh. Default on. */
  persist?: boolean
  runId?: string | null
  score?: number | null
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

    const chosen = pos.output.top_proof_points
      .map((pp) => byId.get(pp.background_id))
      .filter((b): b is NonNullable<typeof b> => !!b)

    // One builder for the writer's pool and the gate's, so the two can never
    // disagree about what counts as evidence (lib/outreach/evidence.ts).
    const allowed = buildEvidence({
      companyContext: body.companyContext,
      personContext: body.personContext,
      recipientTitle: body.person.title,
      recipientCompany: body.person.company,
      chosenBackground: chosen,
    })

    let draft = null
    let outreachId: string | null = null
    let grounding = null
    let persistError: string | null = null

    if (body.withEmail !== false) {
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
        // The gate verifies against the user's whole record, not only the three
        // items the argument uses — see buildVerificationPool for why.
        const verificationPool = buildVerificationPool(allowed, background, chosen.map((c) => c.id))
        grounding = checkGrounding({
          subject: out.output.subject,
          body: out.output.body,
          evidence: verificationPool,
          safeNames: safeNamesFor({
            recipientName: body.person.name,
            recipientCompany: body.person.company,
            senderName: 'Zuyu Liu',
            timeframe: mission.timeframe,
          }),
        })

        draft = { ...out.output, allowedClaims: allowed, grounding }

        if (body.persist !== false) {
          try {
            const contactId = await resolveContactId(user.id, {
              name: body.person.name,
              email: body.person.email ?? null,
              title: body.person.title,
              company: body.person.company,
              linkedin: body.person.linkedin ?? null,
              location: body.person.location ?? null,
            })
            const row = await saveDraft(user.id, {
              contactId,
              runId: body.runId ?? null,
              missionGoal: mission.goal,
              positioning: pos.output as unknown as Record<string, unknown>,
              positioningVersion: positioningPrompt.version,
              proofPointIds: pos.output.top_proof_points.map((pp) => pp.background_id),
              angle: pos.output.positioning_thesis,
              subject: out.output.subject,
              body: out.output.body,
              wordCount: out.output.wordCount,
              cta: pos.output.recommended_ask,
              draftVersion: outreachPrompt.version,
              // Stored so the gate at send time checks the same corpus this
              // draft was written against, not whatever the résumé says later.
              allowedClaims: verificationPool,
              grounding,
              recipientRole: body.person.title,
              companyType: body.person.company,
              score: body.score ?? null,
            })
            outreachId = row.id
          } catch (e) {
            // A persistence failure must not destroy a draft the user just paid
            // for. Surface it and hand the draft back unsaved.
            persistError =
              e instanceof MigrationMissingError
                ? e.message
                : `Could not save this draft: ${e instanceof Error ? e.message : 'unknown error'}`
          }
        }
      }
    }

    const usage = anthropicUsage()

    return NextResponse.json({
      outreachId,
      persistError,
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
