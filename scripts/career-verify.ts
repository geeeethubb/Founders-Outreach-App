// Re-verifies stored jobs from the command line.
//
//   npx tsx scripts/career-verify.ts --scope saved|tracked|stale|all   (default stale)
//   npx tsx scripts/career-verify.ts --scope all --limit 100 --stale-days 14 --user <id>
//
// Prints every row whose status changed and the applications the system
// closed because their posting closed. Exit 2 when migration 014 is missing.

import { defaultProfiles } from './lib/cli-user'
import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })
import type { VerifyScope } from '../lib/career/jobs/verify-batch'

function opt(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const { migrationApplied } = await import('../lib/career/evidence/seed')
  const { verifyJobs } = await import('../lib/career/jobs/verify-batch')
  const { startCareerRun, DEFAULT_PACKAGE_BUDGET } = await import('../lib/career/runs')
  const { scoutToolContext } = await import('../lib/career/scout/orchestrator')

  const gate = await migrationApplied()
  if (!gate.applied) {
    console.error('migration 014_career_os.sql has not been applied — apply it in the Supabase SQL editor, then re-run.')
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
  const scopes: VerifyScope[] = ['saved', 'tracked', 'stale', 'all']
  const scope = (opt('scope') ?? 'stale') as VerifyScope
  if (!scopes.includes(scope)) {
    console.error(`--scope must be one of ${scopes.join('|')}`)
    process.exitCode = 1
    return
  }

  const run = await startCareerRun({ userId, kind: 'job_verify', label: `verify · ${scope}`, mission: { scope } })
  const started = Date.now()
  console.log(`\nVERIFY — scope ${scope} · user ${userId}\n`)
  const r = await verifyJobs(userId, {
    scope,
    limit: Number(opt('limit')) || 50,
    staleDays: Number(opt('stale-days')) || 14,
    ctx: scoutToolContext(userId, run.runId, DEFAULT_PACKAGE_BUDGET),
    run,
    onProgress: (d) => console.log(`  ${d}`),
  })
  await run.finish(r.migrationMissing ? 'failed' : 'succeeded', { checked: r.checked, outcomes: r.outcomes, changed: r.changed.length }, r.errors[0] ?? null)
  if (r.migrationMissing) {
    console.error('migration 014_career_os.sql has not been applied')
    process.exitCode = 2
    return
  }

  console.log(`\nchecked ${r.checked}`)
  for (const [k, v] of Object.entries(r.outcomes)) if (v) console.log(`  ${k}: ${v}`)
  console.log(`\nCHANGED (${r.changed.length})`)
  for (const c of r.changed) console.log(`  ${c.company} / ${c.title}: ${c.from} → ${c.to} — ${c.note}`)
  if (r.applicationsClosed.length) {
    console.log(`\nAPPLICATIONS CLOSED (${r.applicationsClosed.length})`)
    for (const a of r.applicationsClosed) console.log(`  application ${a.application_id} (was ${a.from}) — job ${a.job_id}`)
  }
  if (r.errors.length) {
    console.log(`\nERRORS (${r.errors.length})`)
    for (const e of r.errors) console.log(`  - ${e}`)
  }
  console.log(`\ncost $${run.costUsd().toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
