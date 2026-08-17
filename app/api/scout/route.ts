import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { runScouting } from '@/lib/scouting/orchestrator'
import { RESUME_ITEMS } from '@/evals/phase3/user-profile'
import { isSearchMode, summarizeDecision, type SearchMode } from '@/lib/network/sufficiency'

// A scouting run is many sequential agent calls with web search inside them.
// Give it room: a truncated response surfaces client-side as a JSON parse error,
// which is the least debuggable possible symptom.
//
// 300 is the Vercel Hobby ceiling, and it is a HARD product constraint, not a
// config number. A measured full-depth run took 527s — so the budget below is
// sized to fit here, not the other way round. Timing out is not merely annoying:
// the Anthropic spend and the Apollo credits are consumed before the function is
// killed, and nothing is returned. An expensive nothing is the worst outcome
// available, so the defaults are deliberately conservative.
//
// A paid plan raises this ceiling; `npm run scout` has no ceiling at all and is
// the right tool for a deep run.
export const maxDuration = 300

interface ScoutBody {
  goal?: string
  geography?: string
  timeframe?: string
  constraints?: string[]
  segments?: number
  companiesPerSegment?: number
  maxDeepResearch?: number
  /** internal_first (default) | internal_only | external_only | both */
  searchMode?: string
  internalTarget?: number
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as ScoutBody
    const goal = (body.goal ?? '').trim()
    if (!goal) return NextResponse.json({ error: 'A mission goal is required' }, { status: 400 })

    // Existing-network-first is the default, and it is the default for a cost
    // reason as much as a quality one: the cheapest run is the one that finds
    // what it needs among people already paid for.
    const searchMode: SearchMode = isSearchMode(body.searchMode) ? body.searchMode : 'internal_first'

    // Retrieved summaries only — never the full résumé (ADR-005). This is the
    // temporary source until the Talent Knowledge Base exists.
    const backgroundItems = RESUME_ITEMS.filter((i) => i.credibility !== 'supporting').map((i) => ({
      id: i.id,
      summary: `${i.title} — ${i.org} (${i.period}): ${i.summary}`,
    }))

    const result = await runScouting({
      userId: user.id,
      label: `ui/${new Date().toISOString().slice(0, 16)}`,
      mission: {
        goal,
        timeframe: body.timeframe?.trim() || 'Winter 2026-27',
        geography: body.geography?.trim() || 'United States',
        constraints: body.constraints ?? [
          'undergraduate student, so the ask is an internship, a short project, advice, or a referral',
          'must be a person who could plausibly reply to a well-written cold email',
        ],
      },
      backgroundItems,
      budget: {
        maxCompanies: 10,
        maxPeoplePerCompany: 5,
        maxApolloCalls: 40,
        maxWebSearches: 4,
        maxAgentSteps: 6,
      },
      // Every cap below is set by the 300s ceiling, not by what produces the
      // best list. A measured run at (3 segments, 5/segment, 15 researched) took
      // 527s and returned 13 prospects; these are roughly 45% of that, which is
      // the fraction that fits with headroom for one slow model call.
      //
      // The clamps are upper bounds, not suggestions: a request for a deeper run
      // than can finish would spend the money and return nothing.
      segmentCount: Math.min(3, Math.max(1, body.segments ?? 2)),
      companiesPerSegment: Math.min(5, Math.max(2, body.companiesPerSegment ?? 4)),
      maxProspects: 25,
      // The cost lever AND the wall-clock lever. Deep research is ~$0.18 and
      // several seconds per person; everything upstream is cheap by comparison.
      maxDeepResearch: Math.min(10, Math.max(4, body.maxDeepResearch ?? 7)),
      researchPerCompany: 2,
      maxDiscoveryRounds: 2,
      maxRescoutRounds: 0,
      concurrency: 5,
      searchMode,
      internalTarget: Math.min(15, Math.max(4, body.internalTarget ?? 8)),
      maxInternalSearches: 6,
    })

    return NextResponse.json({
      runId: result.runId,
      searchMode,
      funnel: result.funnel,
      // The internal-first decision, made observable. "Why did this run cost
      // nothing?" and "why did it spend forty credits?" are the same question.
      internal: {
        headline: summarizeDecision(result.internal.decision),
        decision: result.internal.decision.decision,
        reasons: result.internal.decision.reasons,
        strongCount: result.internal.decision.strongCount,
        targetCount: result.internal.decision.targetCount,
        indexed: result.internal.indexed,
        classified: result.internal.classified,
        poolAssessment: result.internal.poolAssessment,
        missingProfile: result.internal.missingProfile,
        searches: result.internal.searchLog.map((s) => ({
          query: s.query,
          matches: s.totalMatches,
          shown: s.returned,
        })),
      },
      prospects: result.ranked.map((p) => ({
        key: p.candidate_key,
        name: p.person.name,
        title: p.person.title,
        company: p.company,
        location: p.person.location,
        email: p.person.email,
        emailStatus: p.person.email_status,
        linkedin: p.person.linkedin_url,
        score: p.total,
        recommendation: p.recommendation,
        source: p.source,
        contactId: p.contactId,
        relationshipStatus: p.relationshipStatus ?? null,
        approach: p.approach ?? null,
        internalReason: p.internalReason ?? null,
        whyCompany:
          result.enrichedCompanies.find((c) => c.name === p.companyRef)?.description ??
          p.companyContext ??
          null,
        whyThem: p.why_they_fit,
        whyYou: p.why_i_fit_them,
        backgroundIds: p.resume_item_ids,
        risks: p.risks,
        researchSummary: p.researchSummary,
        components: p.components.map((c) => ({
          dimension: c.dimension,
          normalized: c.normalized,
          points: Math.round(c.points),
          max: c.max,
          explanation: c.explanation,
        })),
      })),
      usage: {
        costUsd: Number(result.usage.costUsd.toFixed(2)),
        apolloCredits: result.usage.apollo.enrichmentCredits,
        apolloCallsAvoided: result.usage.apolloCallsAvoided,
        webSearches: result.usage.anthropic.webSearches,
        modelCalls: result.usage.anthropic.calls,
        latencyMs: result.usage.latencyMs,
        byAgent: result.usage.byAgent,
      },
      // Surfaced, never hidden — a run that partially failed must say so.
      errors: result.errors.slice(0, 10),
    })
  } catch (error) {
    console.error('Scout run failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Scouting failed' },
      { status: 500 }
    )
  }
}
