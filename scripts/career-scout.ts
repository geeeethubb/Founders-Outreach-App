// Runs one job-scout discovery run from the command line.
//
//   npx tsx scripts/career-scout.ts
//   npx tsx scripts/career-scout.ts --strategies 3 --rounds 2 --companies 25 --extract 40
//   npx tsx scripts/career-scout.ts --no-verify --mission <id> --user <id> --deadline 600
//   npx tsx scripts/career-scout.ts --direction "life sciences / genomics research"
//
// --direction replaces the mission's stored direction for THIS run only; it
// is never written back. It leads the plan, retrieval and fallback strategies;
// post-scout ranking is skipped for such a run (fit rows persist against the
// saved mission), so save the direction on the Jobs page to rank against it.
//
// Unlike the web route this has no 300s ceiling (--deadline is seconds,
// default the DEFAULT_SCOUT_BUDGET). Exit 2 when migration 014 has not been
// applied — checked with one cheap select BEFORE any agent is paid for.
//
// Exit codes are set via process.exitCode, never process.exit(): on Node 24 an
// exit while a Supabase socket is still closing trips a libuv assertion.

import { defaultProfiles } from './lib/cli-user'
import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function opt(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}
function num(name: string, fallback: number): number {
  const v = Number(opt(name))
  return Number.isFinite(v) && opt(name) !== null ? v : fallback
}

function table(headers: string[], rows: (string | number | null | undefined)[][]): void {
  const cells = rows.map((r) => r.map((c) => (c == null ? '' : String(c))))
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]?.length ?? 0)))
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(line(headers))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of cells) console.log(line(r))
}

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const { migrationApplied } = await import('../lib/career/evidence/seed')
  const { runJobScout } = await import('../lib/career/scout/orchestrator')
  const { summarizeStats } = await import('../lib/career/scout/stats')
  const { DEFAULT_SCOUT_BUDGET } = await import('../lib/career/runs')

  const gate = await migrationApplied()
  if (!gate.applied) {
    console.error('migration 014_career_os.sql has not been applied — apply it in the Supabase SQL editor, then re-run.')
    console.error(`  (${gate.error})`)
    process.exitCode = 2
    return
  }

  let userId = opt('user')
  if (!userId) {
    const { data: profiles } = await defaultProfiles()
    if (!profiles?.length) {
      console.error('no profiles row exists')
      process.exitCode = 1
      return
    }
    userId = profiles[0].id as string
  }

  // 1200s by default, not the web route's 270s: that ceiling exists because of
  // Vercel, and the first live CLI run spent 226s in the planner alone and then
  // hit the deadline before extracting or ranking anything.
  const deadlineMs = num('deadline', Math.max(1200, DEFAULT_SCOUT_BUDGET.deadlineMs / 1000)) * 1000
  const directionOverride = opt('direction')
  console.log(`\nJOB SCOUT — user ${userId}`)
  if (directionOverride !== null) {
    console.log(`direction (this run only, from --direction): ${directionOverride}`)
    console.log('note: post-scout ranking is skipped for a --direction run (fit rows persist against the saved mission); save the direction on /dashboard/jobs to rank against it')
  }
  else console.log('direction: from the stored mission (see the [plan] line below)')
  console.log('')
  const started = Date.now()
  const result = await runJobScout({
    userId,
    missionId: opt('mission'),
    ...(directionOverride !== null ? { directionOverride } : {}),
    budget: { deadlineMs },
    maxStrategies: num('strategies', 3),
    maxRoundsPerStrategy: num('rounds', 2),
    maxCompaniesFirst: num('companies', 25),
    maxExtract: num('extract', 40),
    verify: !flag('no-verify'),
    label: 'job scout · cli',
    onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
  })

  if (result.migrationMissing) {
    console.error('\nmigration 014_career_os.sql has not been applied')
    process.exitCode = 2
    return
  }

  console.log(`\nrun ${result.runId ?? '(not recorded)'} · mission ${result.mission?.name ?? '?'}`)
  if (result.plan) {
    console.log(`plan: ${result.plan.role_families.join(', ')}`)
    for (const s of result.plan.strategies) console.log(`  strategy [${s.kind}] ${s.name} (priority ${s.priority})`)
    console.log(`  ${result.plan.seed_companies_count} seed companies · adjacent: ${result.plan.adjacent_categories.join(', ') || '—'}`)
  }

  console.log('\nSTATS')
  for (const line of summarizeStats(result.stats)) console.log(`  ${line}`)

  console.log(`\nJOBS (${result.jobs.length})`)
  table(
    ['company', 'title', 'location', 'tier', 'season', 'type', 'status', 'url'],
    result.jobs.slice(0, 40).map((j) => [j.company_name, j.title.slice(0, 48), (j.location_raw ?? '').slice(0, 24), j.location_tier, j.season_relevance, j.employment_type, j.verification_status, (j.canonical_url ?? '').slice(0, 60)])
  )

  const reasons = new Map<string, number>()
  for (const r of result.rejected) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1)
  console.log(`\nREJECTED (${result.rejected.length})`)
  for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${reason}`)

  console.log('\nVERIFICATION')
  for (const [k, v] of Object.entries(result.stats.verification)) if (v) console.log(`  ${k}: ${v}`)

  if (result.errors.length) {
    console.log(`\nERRORS (${result.errors.length})`)
    for (const e of result.errors) console.log(`  - ${e}`)
  }
  console.log(`\ncost $${result.costUsd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
