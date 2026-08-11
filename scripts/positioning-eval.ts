// Targeted positioning + outreach eval.
//
//   npm run eval:positioning              positioning only, 10 prospects
//   npm run eval:positioning -- --emails  also draft and judge emails
//   npm run eval:positioning -- --n 3     smaller sample while iterating
//
// Runs on the shortlist the last real scouting mission produced, so it evaluates
// positioning against prospects the system actually found rather than fixtures.

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'

const RUN_FILE = path.join(process.cwd(), '.eval-runs', 'prototype-run.json')

interface RankedProspect {
  candidate_key: string
  total: number
  why_they_fit: string
  risks: string
  components: { dimension: string; normalized: number; explanation: string }[]
  person: { name: string; first_name: string | null; title: string | null; location: string | null }
  company: string
  researchSummary: string
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}

const MISSION = {
  goal:
    'Find people who could realistically lead to a strong winter 2026-27 internship or short-term ' +
    'project at the intersection of industrial AI, manufacturing, and chemical or process engineering.',
  timeframe: 'Winter 2026-27, with the same relationships relevant to summer 2027',
}

async function main() {
  if (!fs.existsSync(RUN_FILE)) {
    console.error('No prototype run found. Run `npm run scout` first.')
    process.exit(1)
  }

  const withEmails = process.argv.includes('--emails')
  const n = arg('n', 10)

  const { runPositioning, renderPositioning } = await import('../lib/agents/positioning')
  const { runOutreach } = await import('../lib/agents/outreach')
  const { judgePositioning, judgeEmails, POSITIONING_DIMENSIONS, EMAIL_DIMENSIONS } = await import(
    '../evals/positioning/judge'
  )
  const { anthropicUsage, resetAnthropicUsage, setAnthropicBudget } = await import(
    '../lib/providers/anthropic/client'
  )

  setAnthropicBudget(120)
  resetAnthropicUsage()

  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) as { ranked: RankedProspect[] }
  // Strongest first — positioning is for prospects worth pursuing.
  const sample = [...run.ranked].sort((a, b) => b.total - a.total).slice(0, n)

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

  const ctx = {
    user_id: 'eval',
    run_id: null,
    budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 4 },
  }

  console.log(`\nPOSITIONING EVAL — ${sample.length} prospects${withEmails ? ' + emails' : ''}\n`)

  const positioned: {
    p: RankedProspect
    pos: NonNullable<Awaited<ReturnType<typeof runPositioning>>['output']>
  }[] = []
  let positioningCost = 0

  for (const p of sample) {
    const res = await runPositioning(
      {
        mission: MISSION,
        person: { name: p.person.name, title: p.person.title, company: p.company, location: p.person.location },
        // The scouting run captured the person dossier; company context lives in it too.
        companyContext: p.why_they_fit,
        personContext: p.researchSummary,
        rankingEvidence: {
          whyThemSummary: p.why_they_fit,
          risks: p.risks,
          dimensions: p.components.map((c) => ({
            dimension: c.dimension,
            normalized: c.normalized,
            explanation: c.explanation,
          })),
        },
        background,
      },
      ctx
    )
    positioningCost += res.trace.cost_usd
    if (!res.output) {
      console.log(`  FAILED ${p.person.name}: ${res.error}`)
      continue
    }
    positioned.push({ p, pos: res.output })
    console.log(
      `  ${p.person.name.padEnd(22)} ${res.output.top_proof_points.length} proof pts · ` +
        `conf ${res.output.confidence.toFixed(2)} · ${res.output.ungrounded_ids.length} ungrounded`
    )
  }

  // ─── Judge positioning ─────────────────────────────────────────────────────
  const judged = await judgePositioning(
    MISSION.goal,
    positioned.map(({ p, pos }) => ({
      id: p.candidate_key,
      recipient: p.person.name,
      title: p.person.title,
      company: p.company,
      companyContext: p.why_they_fit,
      personContext: p.researchSummary,
      thesis: pos.positioning_thesis,
      proofPoints: pos.top_proof_points.map((pp) => ({
        id: pp.background_id,
        title: byId.get(pp.background_id)?.title ?? pp.background_id,
        why: pp.why_it_matters,
      })),
      whyMe: pos.why_me,
      whyNow: pos.why_now,
      ask: pos.recommended_ask,
      doNotMention: pos.do_not_mention.map((d) => d.item),
      availableBackground: background.map((b) => ({ id: b.id, title: b.title, summary: b.summary })),
    }))
  )

  report('POSITIONING', judged.results, POSITIONING_DIMENSIONS as unknown as string[], 4.2)

  const ungrounded = positioned.reduce((s, x) => s + x.pos.ungrounded_ids.length, 0)
  console.log(`  Grounding: ${ungrounded === 0 ? '100% (0 invented ids)' : `FAIL — ${ungrounded} invented ids`}`)
  console.log(
    `  Proof-point discipline: ${positioned.filter((x) => x.pos.top_proof_points.length <= 3).length}/${positioned.length} used <= 3`
  )

  // ─── Emails ────────────────────────────────────────────────────────────────
  let emailCost = 0
  let emailJudgeCost = 0
  if (withEmails && positioned.length > 0) {
    console.log('\nDRAFTING EMAILS\n')
    const drafted: { p: RankedProspect; subject: string; body: string; words: number; allowed: string[] }[] = []

    for (const { p, pos } of positioned) {
      // Company-level facts count as evidence too. Restricting the writer to
      // person-level facts alone starved the thin-record prospects, and the
      // judge marked them down for exactly that.
      const companyFacts = p.why_they_fit
        .split(/(?<=.)s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 30)
        .slice(0, 3)
        .map((s) => `THEIR COMPANY: ${s}`)

      const allowed = [
        ...companyFacts,
        ...pos.top_proof_points.map((pp) => `SENDER: ${byId.get(pp.background_id)?.summary ?? pp.background_id}`),
        `RECIPIENT: ${p.person.title ?? 'unknown title'} at ${p.company}`,
        ...p.researchSummary
          .split('\n')
          .filter((l) => l.trim().startsWith('•'))
          .map((l) => `RECIPIENT: ${l.replace(/^\s*•\s*/, '')}`)
          .slice(0, 5),
      ]

      const res = await runOutreach(
        {
          mission: MISSION,
          sender: { name: 'Zuyu Liu', signoffContext: 'undergraduate, chemical engineering' },
          person: {
            name: p.person.name,
            firstName: p.person.first_name ?? p.person.name.split(' ')[0],
            title: p.person.title,
            company: p.company,
          },
          positioning: renderPositioning(pos, byId),
          groundedFacts: allowed,
          wordTarget: { min: 60, max: 120 },
        },
        ctx
      )
      emailCost += res.trace.cost_usd
      if (!res.output) {
        console.log(`  FAILED ${p.person.name}: ${res.error}`)
        continue
      }
      drafted.push({
        p,
        subject: res.output.subject,
        body: res.output.body,
        words: res.output.wordCount,
        allowed,
      })
      console.log(`  ${p.person.name.padEnd(22)} ${res.output.wordCount}w · "${res.output.subject}"`)
    }

    const emailJudged = await judgeEmails(
      drafted.map((d) => ({
        id: d.p.candidate_key,
        recipient: d.p.person.name,
        title: d.p.person.title,
        company: d.p.company,
        personContext: d.p.researchSummary,
        subject: d.subject,
        body: d.body,
        wordCount: d.words,
        allowedClaims: d.allowed,
      }))
    )
    emailJudgeCost = emailJudged.costUsd

    report('EMAIL', emailJudged.results, EMAIL_DIMENSIONS as unknown as string[], 4.3)

    const best = [...emailJudged.results].sort((a, b) => b.average - a.average)[0]
    if (best) {
      const d = drafted.find((x) => x.p.candidate_key === best.id)
      if (d) {
        console.log(`\n  BEST EMAIL (${best.average.toFixed(2)}/5) — ${d.p.person.name}, ${d.p.company}`)
        console.log(`  Subject: ${d.subject}\n`)
        console.log(d.body.split('\n').map((l) => `    ${l}`).join('\n'))
      }
    }

    fs.writeFileSync(
      path.join(process.cwd(), '.eval-runs', 'positioning-eval.json'),
      JSON.stringify({ positioned, drafted, judged: judged.results, emailJudged: emailJudged.results }, null, 2)
    )
  }

  const u = anthropicUsage()
  const ready = positioned.length || 1
  console.log('\nCOST')
  console.log(`  positioning        $${positioningCost.toFixed(3)}`)
  if (withEmails) console.log(`  outreach drafting  $${emailCost.toFixed(3)}`)
  console.log(`  judges             $${(judged.costUsd + emailJudgeCost).toFixed(3)}`)
  console.log(`  TOTAL              $${u.costUsd.toFixed(3)}`)
  console.log(
    `  per outreach-ready prospect (excl. eval): $${((positioningCost + emailCost) / ready).toFixed(3)}`
  )
}

function report(label: string, results: { average: number; scores: { dimension: string; score: number }[]; worst: { dimension: string; score: number }; verdict: string; id: string }[], dims: string[], target: number) {
  if (results.length === 0) {
    console.log(`\n${label}: no results`)
    return
  }
  const avg = results.reduce((s, r) => s + r.average, 0) / results.length
  const below = results.filter((r) => r.average < 3.5)

  console.log(`\n${label} SCORES (${results.length} judged)`)
  for (const d of dims) {
    const scores = results.map((r) => r.scores.find((s) => s.dimension === d)?.score ?? 0)
    const m = scores.reduce((a, b) => a + b, 0) / scores.length
    const flag = m < target ? ' ←' : ''
    console.log(`    ${d.padEnd(18)} ${m.toFixed(2)}${flag}`)
  }
  console.log(`  AVERAGE ${avg.toFixed(2)} / 5   (target >= ${target})  ${avg >= target ? 'PASS' : 'FAIL'}`)
  console.log(
    `  Below 3.5: ${below.length}/${results.length} (${((below.length / results.length) * 100).toFixed(0)}%, target <= 10%)`
  )
  const worstCases = [...results].sort((a, b) => a.average - b.average).slice(0, 3)
  console.log('  WEAKEST')
  for (const w of worstCases) {
    console.log(`    ${w.average.toFixed(2)} — worst ${w.worst.dimension} ${w.worst.score}: ${w.verdict.slice(0, 120)}`)
  }
}

main().catch((e) => {
  console.error('eval failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
