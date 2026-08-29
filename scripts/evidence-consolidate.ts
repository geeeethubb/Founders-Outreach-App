// Evidence Bank consolidation.
//
//   npm run evidence:consolidate                          dry run (default): print the plan, write plan-<stamp>.json
//   npm run evidence:consolidate -- --apply               apply every HIGH proposal (snapshot first)
//   npm run evidence:consolidate -- --apply --pair <keep_id>:<merge_id> [--possible]
//   npm run evidence:consolidate -- --user <id>
//
// --apply refuses (exit 2) when migration 015 is not applied. Nothing is
// deleted by an apply: merged rows are tombstoned and a snapshot of the
// whole bank is written before the first write.

import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

function flag(name: string): boolean { return process.argv.includes(`--${name}`) }
function opt(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const { loadEvidenceBank } = await import('../lib/career/evidence/store')
  const { buildConsolidationPlan } = await import('../lib/career/evidence/consolidate')
  const { applyConsolidation, loadSuppressedPairs } = await import('../lib/career/evidence/consolidate-apply')
  const { planToJson, renderPlanReport } = await import('../lib/career/evidence/consolidate-report')

  let userId = opt('user')
  if (!userId) {
    const { data } = await createServiceClient().from('profiles').select('id').limit(1)
    userId = (data?.[0]?.id as string | undefined) ?? null
  }
  if (!userId) { console.error('no user'); process.exitCode = 1; return }

  const { bank, migrationMissing, canonical, errors } = await loadEvidenceBank(userId, { approvedOnly: false, includeTombstones: true })
  if (migrationMissing) { console.error('migration 014 not applied'); process.exitCode = 2; return }
  for (const e of errors) console.error(`load: ${e}`)
  const { pairs: suppressed } = await loadSuppressedPairs(userId)
  const plan = buildConsolidationPlan(bank, { suppressed, migration015: canonical })

  console.log(renderPlanReport(plan))
  const outDir = path.join(process.cwd(), '.career-out', 'evidence')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `plan-${stamp()}.json`)
  fs.writeFileSync(outPath, planToJson(plan))
  console.log(`\nwrote ${outPath}`)

  if (!flag('apply')) { console.log('\ndry run — nothing written. Re-run with --apply to execute the HIGH merges.'); return }
  if (!canonical) {
    console.error('\n--apply refused: migration 015_evidence_canonical.sql is not applied. Apply it in the Supabase SQL editor (npm run check:sql -- 015 first), then re-run.')
    process.exitCode = 2
    return
  }

  const pair = opt('pair')
  let only: { entity_type: 'experience' | 'fact' | 'metric' | 'project'; keep_id: string; merge_id: string }[] | undefined
  if (pair) {
    const [keep, merge] = pair.split(':')
    const found = [...plan.experiences, ...plan.facts, ...plan.metrics].find((p) => p.keep_id === keep && p.merge_id === merge)
    if (!found) { console.error(`pair ${pair} is not in the plan`); process.exitCode = 1; return }
    only = [{ entity_type: found.entity_type, keep_id: keep, merge_id: merge }]
  }
  const result = await applyConsolidation(userId, plan, { only, allowPossible: flag('possible'), reason: pair ? `cli pair ${pair}` : 'cli apply HIGH' })
  console.log('\nAPPLY RESULT')
  console.log(`  snapshot ${result.snapshot_id ?? '(none)'}`)
  console.log(`  organizations created ${result.organizations_created} / updated ${result.organizations_updated} · statement_norm backfilled ${result.statement_norms_backfilled} · sources ${result.sources_created} · fact_sources ${result.fact_sources_created} · experience_sources ${result.experience_sources_created}`)
  console.log(`  merged ${result.merged.length} · suggestions ${result.suggestions_written} · conflicts ${result.conflicts_written} · summaries ${result.summaries_refreshed}`)
  for (const m of result.merged) console.log(`    merged ${m.entity_type} ${m.merge_id} → ${m.keep_id} (${m.repointed} children re-pointed)`)
  for (const s of result.skipped) console.log(`    skipped ${s.entity_type} ${s.merge_id} → ${s.keep_id}: ${s.reason}`)
  for (const e of result.errors) console.error(`  error: ${e}`)
  if (result.errors.length) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
