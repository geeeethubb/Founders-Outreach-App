// Re-judges a COMPLETED scouting run with the current judge version.
//
//   npx tsx scripts/rejudge-run.ts <labelSubstring> [topN]
//
// Why this exists: the judge is the measuring instrument, and changing it makes
// old numbers incomparable. Rather than leave a stale baseline in the report, or
// freeze a judge we have shown to be miscalibrated, we reconstruct the run's
// top-N from persisted agent_runs and re-score it with the new judge. Before and
// after are then measured with the same instrument.
//
// Everything needed is already persisted: ranking outputs carry the score and
// candidate key, person_research outputs carry the dossier, and contacts and
// companies carry the identity and description.

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'
import { profileById } from '../evals/agentic/profiles'

async function main() {
  const needle = process.argv[2]
  const topN = Number(process.argv[3] ?? 20)
  if (!needle) {
    console.error('usage: rejudge-run.ts <labelSubstring> [topN]')
    process.exit(1)
  }

  const { createServiceClient } = await import('../lib/supabase/server')
  const { judgeProspects, JUDGE_PROMPT_VERSION } = await import('../evals/agentic/judge')
  const { computePrecision, pct } = await import('../evals/agentic/metrics')
  const { renderPersonResearch } = await import('../lib/agents/person-research')

  const s = createServiceClient()

  const { data: runs } = await s
    .from('scouting_runs')
    .select('id, label, status')
    .like('label', `%${needle}%`)
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(1)

  if (!runs?.length) {
    console.error(`no succeeded run matching "${needle}"`)
    process.exit(1)
  }
  const run = runs[0]
  const profileId = String(run.label).split('/')[1] ?? ''
  const profile = profileById(profileId)
  if (!profile) {
    console.error(`cannot resolve profile from label "${run.label}"`)
    process.exit(1)
  }

  const { data: agentRuns } = await s
    .from('agent_runs')
    .select('agent_id, output, input_refs')
    .eq('run_id', run.id)
    .limit(600)

  const rows = agentRuns ?? []

  // Ranking outputs carry candidate_key + total: the published order.
  const ranked = rows
    .filter((r) => r.agent_id === 'ranking' && r.output)
    .map((r) => r.output as { candidate_key: string; total: number })
    .filter((o) => o?.candidate_key)

  // Person research, keyed by the person's name (what input_refs records).
  const researchByName = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    if (r.agent_id !== 'person_research' || !r.output) continue
    const name = String((r.input_refs as { person?: string })?.person ?? '')
    if (name) researchByName.set(name, r.output as Record<string, unknown>)
  }

  const { data: contacts } = await s
    .from('contacts')
    .select('name, role, company, location, linkedin_url, email')
    .limit(1000)
  const { data: companies } = await s.from('companies').select('name, description').limit(1000)

  const descByCompany = new Map((companies ?? []).map((c) => [String(c.name), String(c.description ?? '')]))

  // candidate_key is linkedin_url ?? email ?? name — the same rule the
  // orchestrator used when it built the key.
  const contactByKey = new Map<string, { name: string; role: string; company: string; location: string }>()
  for (const c of contacts ?? []) {
    const key = String(c.linkedin_url ?? c.email ?? c.name)
    contactByKey.set(key, {
      name: String(c.name ?? ''),
      role: String(c.role ?? ''),
      company: String(c.company ?? ''),
      location: String(c.location ?? ''),
    })
  }

  // Reproduce the published ordering: score desc, then best-per-company first.
  const scored = [...ranked].sort((a, b) => b.total - a.total)
  const seenCompany = new Set<string>()
  const firstPer: typeof scored = []
  const runners: typeof scored = []
  for (const r of scored) {
    const co = (contactByKey.get(r.candidate_key)?.company ?? 'unknown').toLowerCase()
    if (seenCompany.has(co)) runners.push(r)
    else {
      seenCompany.add(co)
      firstPer.push(r)
    }
  }
  const top = [...firstPer, ...runners].slice(0, topN)

  const items = RESUME_ITEMS.filter((i) => i.credibility !== 'supporting').map((i) => ({
    id: i.id,
    summary: `${i.title} — ${i.org} (${i.period}): ${i.summary}`,
  }))
  const backgroundSummary = items.map((b) => `  [${b.id}] ${b.summary}`).join('\n')

  const judgeInputs = top.map((r) => {
    const c = contactByKey.get(r.candidate_key)
    const dossier = c ? researchByName.get(c.name) : undefined
    return {
      candidate_id: r.candidate_key,
      name: c?.name ?? r.candidate_key,
      title: c?.role || null,
      company: c?.company ?? 'unknown',
      company_description: descByCompany.get(c?.company ?? '') || 'unknown',
      person_summary: dossier
        ? renderPersonResearch(dossier as never)
        : 'no research was available for this person',
      location: c?.location || null,
    }
  })

  const missing = judgeInputs.filter((j) => j.person_summary.startsWith('no research')).length
  console.log(
    `\nre-judging "${run.label}" — ${judgeInputs.length} prospects, judge v${JUDGE_PROMPT_VERSION}` +
      (missing ? ` (${missing} without a reconstructable dossier)` : '')
  )

  const judged = await judgeProspects(profile.goal, backgroundSummary, judgeInputs)
  if (judged.error) {
    console.error('judge failed:', judged.error)
    process.exit(1)
  }

  const byId = new Map(judged.results.map((j) => [j.candidate_id, j]))
  const verdicts = judgeInputs.map((j) => byId.get(j.candidate_id)?.verdict ?? 'BAD')
  const p = computePrecision(verdicts)

  console.log(
    `\nPrecision@${topN}: ${pct(p.precision)}  ` +
      `(${p.good}G [${p.goodHighEvidence}hi/${p.goodRoleBased}role] / ${p.maybe}M / ${p.bad}B of ${p.n})   ` +
      `BAD rate ${pct(p.badRate)}`
  )

  console.log('\nVERDICTS')
  for (const j of judgeInputs) {
    const v = byId.get(j.candidate_id)
    console.log(`  ${(v?.verdict ?? 'BAD').padEnd(19)} ${j.name} — ${j.title ?? '?'} @ ${j.company}`)
  }

  const out = {
    label: run.label,
    runId: run.id,
    judgeVersion: JUDGE_PROMPT_VERSION,
    topN,
    precision: p,
    verdicts: judged.results,
  }
  fs.mkdirSync(path.join(process.cwd(), '.eval-runs'), { recursive: true })
  const file = path.join(process.cwd(), '.eval-runs', `rejudge-${profileId}-v${JUDGE_PROMPT_VERSION}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`\nwritten to ${path.relative(process.cwd(), file)}`)
}

main().catch((e) => {
  console.error('rejudge failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
