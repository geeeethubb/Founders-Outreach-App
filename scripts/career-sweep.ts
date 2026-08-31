// Sweeps every company on the watchlist for open internships — the cheap,
// wide half of discovery.
//
//   npx tsx scripts/career-sweep.ts
//   npx tsx scripts/career-sweep.ts --limit 200 --concurrency 6 --deadline 900
//   npx tsx scripts/career-sweep.ts --extract 25          # then read the best 25 properly
//   npx tsx scripts/career-sweep.ts --stored-only         # boards we already know; no detection
//   npx tsx scripts/career-sweep.ts --dry-run             # list and score, store nothing
//
// The sweep itself makes NO model calls: it lists public ATS boards over HTTP,
// normalizes deterministically, dedupes and stores. `--extract N` is the only
// thing here that costs money, and it buys exactly N extractions, spent on the
// N highest-relevance postings that do not have one yet.
//
// It writes a `scouting_runs` row and heartbeats progress into it, so a sweep
// shows up live on /dashboard/jobs and /dashboard/runs exactly like a scout
// run — same vocabulary, same run you can open afterwards to see what it found.
//
// Exit 2 when migration 014 has not been applied, checked with one cheap select
// before anything else. Exit codes are set through process.exitCode, never
// process.exit(): on Node 24 an exit while a Supabase socket is still closing
// trips a libuv assertion.

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
  const { migrationApplied } = await import('../lib/career/evidence/seed')
  const { ensureDefaultMission, getMission } = await import('../lib/career/missions/store')
  const { liveSweepStore, summarizeSweep, sweepWatchlist, SWEEP_DEADLINE_MS, SWEEP_MAX_COMPANIES } = await import('../lib/career/jobs/sweep')
  const { extractPending } = await import('../lib/career/scout/extract')
  const { scoutToolContext } = await import('../lib/career/scout/orchestrator')
  const { DEFAULT_SCOUT_BUDGET, startCareerRun } = await import('../lib/career/runs')
  const runStore = await import('../lib/career/scout/run-store')

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

  const missionId = opt('mission')
  const mission = missionId ? await getMission(userId, missionId) : (await ensureDefaultMission(userId)).mission
  if (!mission) {
    console.error(`mission ${missionId ?? '(default)'} not found`)
    process.exitCode = 1
    return
  }

  const deadlineMs = num('deadline', SWEEP_DEADLINE_MS / 1000) * 1000
  const limit = num('limit', SWEEP_MAX_COMPANIES)
  const concurrency = num('concurrency', 6)
  const extract = Math.max(0, num('extract', 0))
  const dryRun = flag('dry-run')

  console.log(`\nWATCHLIST SWEEP — user ${userId} · mission ${mission.name}`)
  console.log(`companies ≤ ${limit} · concurrency ${concurrency} · deadline ${Math.round(deadlineMs / 1000)}s · extractions ${extract}${dryRun ? ' · DRY RUN (nothing is stored)' : ''}`)
  if (flag('stored-only')) console.log('stored boards only — ATS detection is skipped this pass')
  console.log('')

  // The run row, so a sweep is a run you can open. It is created 'running', and
  // finishScoutRun closes it with the durable vocabulary the UI already knows.
  const run = dryRun ? null : await startCareerRun({ userId, kind: 'job_scout', label: 'sweep · watchlist', mission: { name: mission.name, kind: 'sweep' }, careerMissionId: mission.id })
  const runId = run?.runId ?? null
  if (runId) console.log(`run ${runId} — live at /dashboard/jobs\n`)
  let chain: Promise<unknown> = Promise.resolve()
  const beat = runId ? setInterval(() => { chain = chain.then(() => runStore.touchScoutRun(runId)).catch(() => {}) }, 30_000) : null

  const started = Date.now()
  const store = liveSweepStore()
  const result = await sweepWatchlist(
    userId,
    {
      mission,
      limit,
      concurrency,
      deadline: started + deadlineMs,
      storedBoardsOnly: flag('stored-only'),
      bypassCache: flag('fresh'),
      listLimit: opt('list-limit') ? num('list-limit', 300) : undefined,
      runId,
      ctx: scoutToolContext(userId, runId, DEFAULT_SCOUT_BUDGET),
      onProgress: (stage, detail) => {
        console.log(`  [${stage}] ${detail}`)
        if (runId) chain = chain.then(() => runStore.recordProgress(runId, { stage, detail })).catch(() => {})
      },
    },
    dryRun ? { store: dryRunStore(store) } : { store }
  ).catch(async (e: unknown) => {
    if (beat) clearInterval(beat)
    if (runId) await runStore.finishScoutRun(runId, 'failed', { error: e instanceof Error ? e.message : String(e) })
    throw e
  })

  // Extraction is the only paid step, and it happens AFTER the inventory
  // exists, on the best of it — which is the whole point of the split.
  let extractionCost = 0
  if (extract > 0 && !dryRun) {
    console.log(`\n  [extract] filling in the ${extract} highest-relevance postings stored without an extraction`)
    const ep = await extractPending(userId, {
      limit: extract,
      order: 'relevance',
      direction: mission.preferences.direction,
      mission: { geo_tiers: mission.preferences.geo_tiers },
      ctx: scoutToolContext(userId, runId, DEFAULT_SCOUT_BUDGET),
      run,
      deadline: started + deadlineMs,
      onProgress: (d) => console.log(`  [extract] ${d}`),
    })
    extractionCost = ep.costUsd
    console.log(`\nEXTRACTION — ${ep.extracted} of ${ep.candidates} pending rows (${ep.failed} failed, ${ep.tooShort} too thin) · $${ep.costUsd.toFixed(4)}`)
    for (const e of ep.errors.slice(0, 10)) console.log(`  - ${e}`)
  }

  if (beat) clearInterval(beat)
  await chain.catch(() => {})
  if (runId) {
    await runStore.finishScoutRun(runId, result.deadlineHit ? 'partial' : 'succeeded', {
      stats: {
        kind: 'sweep',
        companies_checked: result.checked,
        companies_with_openings: result.withOpenings,
        postings_seen: result.postingsListed,
        jobs_inserted: result.inserted,
        jobs_updated: result.updated,
        jobs: result.jobs.length,
        errors: result.errors.slice(0, 10),
      },
      error: result.errors[0] ?? null,
    })
  }

  if (result.migrationMissing) {
    console.error('\nmigration 014_career_os.sql has not been applied')
    process.exitCode = 2
    return
  }

  console.log('\nSWEEP')
  for (const line of summarizeSweep(result)) console.log(`  ${line}`)

  console.log(`\nTOP POSTINGS (${Math.min(40, result.jobs.length)} of ${result.jobs.length})`)
  table(
    ['relevance', 'company', 'title', 'location', 'tier', 'season', 'status', 'read?'],
    result.jobs.slice(0, 40).map((j) => [j.relevance, j.company_name.slice(0, 26), j.title.slice(0, 46), (j.location_raw ?? '').slice(0, 24), j.location_tier, j.season_relevance, j.verification_status, j.extracted ? 'extracted' : 'listing only'])
  )

  const noBoard = result.outcomes.filter((o) => o.postings === 0 && !/: \d+ matching/.test(o.note))
  if (noBoard.length) {
    console.log(`\nNO PUBLIC BOARD READ (${noBoard.length}) — the first 20`)
    table(['company', 'why'], noBoard.slice(0, 20).map((o) => [o.name.slice(0, 30), o.note.slice(0, 100)]))
  }

  if (result.errors.length) {
    console.log(`\nERRORS (${result.errors.length})`)
    for (const e of result.errors.slice(0, 30)) console.log(`  - ${e}`)
  }
  console.log(`\ncost $${extractionCost.toFixed(4)} (the sweep itself is free) · ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

/**
 * A store that reads the watchlist and lists boards but writes nothing —
 * `--dry-run`. Useful for measuring "how much inventory is out there?" without
 * touching the database, which is exactly the question the sweep was built to
 * answer.
 */
function dryRunStore(live: import('../lib/career/jobs/sweep').SweepStore): import('../lib/career/jobs/sweep').SweepStore {
  return {
    ...live,
    async markCareersChecked() {
      return { error: null, migrationMissing: false } as never
    },
    async ensureCompany() {
      return { id: null, error: null, migrationMissing: false }
    },
    async upsertWatch() {
      return { id: null, error: null, migrationMissing: false }
    },
    // `inserted` counts what a real sweep WOULD have stored; `updated` stays 0
    // deliberately, because a non-zero updated count is what makes persistBatch
    // refresh verification — and that is a write.
    async upsertJobs(_userId, jobs) {
      return { inserted: jobs.length, updated: 0, skippedClosed: 0, ids: jobs.map((_, i) => `dry-${i}`), companyIds: {}, errors: [], migrationMissing: false }
    },
    async updateJobVerification() {
      return { error: null }
    },
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
