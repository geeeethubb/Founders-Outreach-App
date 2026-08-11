// Prepare the pilot queue.
//
//   npm run pilot:prepare            5 strongest prospects
//   npm run pilot:prepare -- --n 3
//
// Takes the strongest prospects from the last scouting run, builds positioning
// and a draft for each, runs the claim-safety gate, and puts them in the review
// queue as READY_FOR_REVIEW.
//
// IT DOES NOT SEND. It cannot: nothing here can reach `approved`, and approval
// is a human action in the UI.
//
// If migration 012 has not been applied yet the AI work still happens and is
// written to .eval-runs/pilot.json. Re-running after the migration replays it
// from cache for about $0.

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'

const RUN_FILE = path.join(process.cwd(), '.eval-runs', 'prototype-run.json')
const OUT_FILE = path.join(process.cwd(), '.eval-runs', 'pilot.json')

interface RankedProspect {
  candidate_key: string
  total: number
  recommendation: string
  why_they_fit: string
  risks: string
  components: { dimension: string; normalized: number; explanation: string }[]
  person: {
    name: string
    first_name: string | null
    title: string | null
    location: string | null
    email: string | null
    email_status?: string
    linkedin_url: string | null
  }
  company: string
  researchSummary: string
}

const MISSION = {
  goal:
    'Find people who could realistically lead to a strong winter 2026-27 internship or short-term ' +
    'project at the intersection of industrial AI, manufacturing, and chemical or process engineering.',
  timeframe: 'Winter 2026-27',
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

async function main() {
  if (!fs.existsSync(RUN_FILE)) {
    console.error('No scouting run found. Run `npm run scout` first.')
    process.exit(1)
  }

  const n = arg('n', 5)

  const { runPositioning, renderPositioning } = await import('../lib/agents/positioning')
  const { positioningPrompt } = await import('../lib/agents/positioning/prompt')
  const { runOutreach } = await import('../lib/agents/outreach')
  const { outreachPrompt } = await import('../lib/agents/outreach/prompt')
  const { buildEvidence, buildVerificationPool, safeNamesFor } = await import('../lib/outreach/evidence')
  const { checkGrounding, summarizeGrounding } = await import('../lib/outreach/grounding')
  const { anthropicUsage, resetAnthropicUsage, setAnthropicBudget } = await import(
    '../lib/providers/anthropic/client'
  )

  setAnthropicBudget(80)
  resetAnthropicUsage()

  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) as { ranked: RankedProspect[] }
  // Strongest first, and only those with an address — a prospect that cannot be
  // written to is not a pilot candidate however good the fit is.
  const sample = [...run.ranked]
    .filter((p) => !!p.person.email)
    .sort((a, b) => b.total - a.total)
    .slice(0, n)

  if (sample.length < n) {
    console.log(
      `\nOnly ${sample.length} of the top prospects have an email address on record; preparing those.\n`
    )
  }

  const background = RESUME_ITEMS.map((i) => ({
    id: i.id, kind: i.kind, title: i.title, org: i.org,
    period: i.period, summary: i.summary, domains: i.domains, credibility: i.credibility,
  }))
  const byId = new Map(background.map((b) => [b.id, b]))

  const ctx = {
    user_id: 'pilot',
    run_id: null,
    budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 5 },
  }

  console.log(`\nPILOT — preparing ${sample.length} prospects. Nothing is sent.\n`)

  const prepared: Record<string, unknown>[] = []

  for (const p of sample) {
    const pos = await runPositioning(
      {
        mission: MISSION,
        person: { name: p.person.name, title: p.person.title, company: p.company, location: p.person.location },
        companyContext: p.why_they_fit,
        personContext: p.researchSummary,
        rankingEvidence: {
          whyThemSummary: p.why_they_fit,
          risks: p.risks,
          dimensions: p.components.map((c) => ({
            dimension: c.dimension, normalized: c.normalized, explanation: c.explanation,
          })),
        },
        background,
      },
      ctx
    )
    if (!pos.output) {
      console.log(`  SKIP  ${p.person.name} — positioning failed: ${pos.error}`)
      continue
    }

    const chosen = pos.output.top_proof_points
      .map((pp) => byId.get(pp.background_id))
      .filter((b): b is NonNullable<typeof b> => !!b)

    const allowed = buildEvidence({
      companyContext: p.why_they_fit,
      personContext: p.researchSummary,
      recipientTitle: p.person.title,
      recipientCompany: p.company,
      chosenBackground: chosen,
    })

    const out = await runOutreach(
      {
        mission: MISSION,
        sender: { name: 'Zuyu Liu', signoffContext: 'undergraduate, chemical engineering' },
        person: {
          name: p.person.name,
          firstName: p.person.first_name ?? p.person.name.split(' ')[0],
          title: p.person.title,
          company: p.company,
        },
        positioning: renderPositioning(pos.output, byId),
        groundedFacts: allowed,
        wordTarget: { min: 60, max: 120 },
      },
      ctx
    )
    if (!out.output) {
      console.log(`  SKIP  ${p.person.name} — drafting failed: ${out.error}`)
      continue
    }

    const verificationPool = buildVerificationPool(allowed, background, chosen.map((c) => c.id))
    const grounding = checkGrounding({
      subject: out.output.subject,
      body: out.output.body,
      evidence: verificationPool,
      safeNames: safeNamesFor({
        recipientName: p.person.name,
        recipientCompany: p.company,
        senderName: 'Zuyu Liu',
        timeframe: MISSION.timeframe,
      }),
    })

    console.log(
      `  ${grounding.ok ? 'READY ' : 'BLOCK '} ${p.person.name.padEnd(22)} ${p.company.padEnd(26)} ` +
        `${out.output.wordCount}w · score ${p.total.toFixed(0)} · ${summarizeGrounding(grounding)}`
    )

    prepared.push({
      candidateKey: p.candidate_key,
      person: p.person,
      company: p.company,
      score: p.total,
      recommendation: p.recommendation,
      positioning: pos.output,
      positioningVersion: positioningPrompt.version,
      draft: out.output,
      draftVersion: outreachPrompt.version,
      allowedClaims: verificationPool,
      grounding,
      whyCompany: p.why_they_fit,
      researchSummary: p.researchSummary,
    })
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ mission: MISSION, prepared }, null, 2))
  const usage = anthropicUsage()
  console.log(`\n  wrote ${OUT_FILE}`)
  console.log(`  cost $${usage.costUsd.toFixed(3)} across ${usage.calls} live calls`)

  // ─── persist, if the schema is there ───
  const { createServiceClient } = await import('../lib/supabase/server')
  const supabase = createServiceClient()
  const { error: schemaErr } = await supabase.from('outreach').select('id').limit(1)
  if (schemaErr) {
    console.log(
      `\n  NOT PERSISTED — migration 012_outreach.sql has not been applied.\n` +
        `  Apply it in the Supabase SQL editor, then re-run this command: the agent work\n` +
        `  above replays from cache, so it costs about $0.\n`
    )
    process.exit(0)
  }

  const { data: profile } = await supabase.from('profiles').select('id').limit(1).maybeSingle()
  if (!profile) {
    console.log('\n  NOT PERSISTED — no profile row. Sign in to the app once, then re-run.\n')
    process.exit(0)
  }
  const userId = profile.id as string

  const store = await import('../lib/outreach/store')
  let saved = 0
  for (const item of prepared as Array<Record<string, any>>) {
    try {
      const contactId = await store.resolveContactId(userId, {
        name: item.person.name,
        email: item.person.email ?? null,
        title: item.person.title,
        company: item.company,
        linkedin: item.person.linkedin_url ?? null,
        location: item.person.location ?? null,
      })
      await store.saveDraft(userId, {
        contactId,
        missionGoal: MISSION.goal,
        positioning: item.positioning,
        positioningVersion: item.positioningVersion,
        proofPointIds: item.positioning.top_proof_points.map((pp: { background_id: string }) => pp.background_id),
        angle: item.positioning.positioning_thesis,
        subject: item.draft.subject,
        body: item.draft.body,
        wordCount: item.draft.wordCount,
        cta: item.positioning.recommended_ask,
        draftVersion: item.draftVersion,
        allowedClaims: item.allowedClaims,
        grounding: item.grounding,
        recipientRole: item.person.title,
        companyType: item.company,
        score: item.score,
      })
      saved++
    } catch (e) {
      console.log(`  SAVE FAILED ${item.person.name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(`\n  ${saved} prospects are in the review queue at /dashboard/outreach.`)
  console.log('  They are READY FOR REVIEW. None is approved and none has been sent.\n')
}

main().catch((e) => {
  console.error('pilot prep failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
