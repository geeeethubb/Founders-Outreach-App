// Runs one job-scout discovery run from the command line.
//
//   npx tsx scripts/career-scout.ts
//   npx tsx scripts/career-scout.ts --strategies 3 --rounds 2 --companies 25 --extract 40
//   npx tsx scripts/career-scout.ts --no-verify --mission <id> --user <id> --deadline 600
//   npx tsx scripts/career-scout.ts --direction "life sciences / genomics research"
//   npx tsx scripts/career-scout.ts --run <run id>          # execute a run the UI queued
//
// Same engine, same run vocabulary as the browser: this creates a
// `scouting_runs` row through enqueueScoutRun + claimScoutRun, heartbeats
// progress into it, and finishes it with finishScoutRun — so a CLI run shows
// up live on /dashboard/jobs and /dashboard/runs exactly like a web one.
//
// --run <id> ATTACHES to a run that is already queued instead of creating one.
// That is the escape hatch for when a worker cannot be dispatched (no HTTP
// route reachable, a hosted dispatch that never landed): queue it in the UI,
// then execute it here. The claim token is single-use, so this and a late
// worker cannot both run it. The queued row's stored parameters win; the size
// flags are ignored for a resumed run.
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

import type { ScoutStore } from '../lib/career/scout/orchestrator'
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
  const { liveScoutStore, runJobScout } = await import('../lib/career/scout/orchestrator')
  const { summarizeStats } = await import('../lib/career/scout/stats')
  const { attachCareerRun, DEFAULT_SCOUT_BUDGET } = await import('../lib/career/runs')
  const runStore = await import('../lib/career/scout/run-store')
  const dispatch = await import('../lib/career/scout/run-dispatch')

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

  // The CLI has no function ceiling, so its own caps are wide — sanitizing
  // through the web caps would silently shrink --companies 60 to 25.
  const CLI_CAPS = { strategies: 12, rounds: 8, companies: 200, extract: 400 }
  const flagParams = dispatch.sanitizeScoutParams(
    {
      missionId: opt('mission'),
      strategies: num('strategies', 3),
      rounds: num('rounds', 2),
      companies: num('companies', 25),
      extract: num('extract', 40),
      verify: !flag('no-verify'),
      label: 'job scout · cli',
    },
    CLI_CAPS
  )

  // (1) The run row. Either resume one the UI queued, or queue one here — the
  // same two calls a dispatched worker makes, so a CLI run is watchable live.
  const resumeId = opt('run')
  let runId: string | null = null
  let params = flagParams
  if (resumeId) {
    const found = await runStore.getScoutRun(userId, resumeId)
    if (!found.run) {
      console.error(`run ${resumeId} not found${found.error ? ` (${found.error})` : ''}`)
      process.exitCode = 1
      return
    }
    if (!found.run.claim_token) {
      console.error(`run ${resumeId} is '${found.run.status}' and its claim token is spent — another worker already has it. Nothing to resume.`)
      process.exitCode = 1
      return
    }
    // The claim records the deadline THIS process will work to, so the reaper
    // holds the run to the promise actually made — a --deadline 3600 CLI run
    // is not judged against the web worker's budget.
    const claim = await runStore.claimScoutRun(resumeId, found.run.claim_token, undefined, { deadlineMs })
    if (!claim.claimed) {
      console.error(`could not claim run ${resumeId}: ${claim.error ?? 'already claimed'}`)
      process.exitCode = 1
      return
    }
    runId = resumeId
    params = dispatch.readScoutParams(claim.params, CLI_CAPS)
    console.log(`resuming queued run ${runId} with its stored parameters (size flags ignored)`)
  } else {
    const queued = await runStore.enqueueScoutRun(userId, { missionId: params.missionId, params: { ...params }, label: params.label })
    if (queued.durable && queued.runId && queued.claimToken) {
      const claim = await runStore.claimScoutRun(queued.runId, queued.claimToken, undefined, { deadlineMs })
      if (claim.claimed) runId = queued.runId
      else console.log(`note: could not claim the run row (${claim.error ?? 'unknown'}) — running without live progress`)
    } else {
      console.log(`note: scout runs are not durable yet${queued.migrationMissing ? ' (apply supabase/migrations/016_scout_durability_and_company_intent.sql)' : ` (${queued.error ?? 'unknown'})`} — running without live progress`)
    }
  }
  if (runId) console.log(`run ${runId} — live at /dashboard/jobs`)
  console.log('')

  const started = Date.now()
  // (2) One run row, not two: attach the scout's CareerRun to the row above.
  const store: ScoutStore | undefined = runId ? { ...liveScoutStore(), startRun: (p) => attachCareerRun({ ...p, runId: runId as string }) } : undefined
  let progress: Promise<unknown> = Promise.resolve()
  // A pulse for the stages that say nothing for minutes (one planner call took
  // 226s). Without it `heartbeat_at` measures how talkative a stage is, and the
  // reaper reads that column.
  const beat = runId
    ? setInterval(() => {
        progress = progress.then(() => runStore.touchScoutRun(runId as string)).catch(() => {})
      }, 30_000)
    : null
  // A throw here must still close the row, or the Jobs page polls a run that
  // will never move again until the reaper notices.
  const result = await runJobScout(
    {
      userId,
      missionId: params.missionId,
      ...(directionOverride !== null ? { directionOverride } : {}),
      budget: { deadlineMs },
      maxStrategies: params.strategies,
      maxRoundsPerStrategy: params.rounds,
      maxCompaniesFirst: params.companies,
      maxExtract: params.extract,
      verify: params.verify,
      rank: params.rank,
      label: params.label,
      onProgress: (stage: string, detail: string, counts?: Record<string, number>) => {
        console.log(`  [${stage}] ${detail}`)
        if (runId) progress = progress.then(() => runStore.recordProgress(runId as string, { stage, detail, counts })).catch(() => {})
      },
    },
    store ? { store } : {}
  ).catch(async (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e)
    if (beat) clearInterval(beat)
    if (runId) await runStore.finishScoutRun(runId, 'failed', { error: message })
    throw e
  })
  if (beat) clearInterval(beat)
  await progress.catch(() => {})

  if (runId) {
    const status = runStore.terminalStatusFor({ migrationMissing: result.migrationMissing, deadlineHit: result.stats.deadline_hit, errors: result.errors })
    await runStore.finishScoutRun(runId, status, {
      stats: { ...result.stats, jobs: result.jobs.length, rejected: result.rejected.length, errors: result.errors.slice(0, 10) },
      error: result.errors[0] ?? null,
    })
  }

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
