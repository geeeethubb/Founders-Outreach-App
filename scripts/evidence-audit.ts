// Evidence Bank audit — READ-ONLY.
//
//   npm run evidence:audit [-- --user <id>] [--json <path>]
//
// Loads everything (approved or not, tombstones included), prints the bank
// grouped by organization key with every duplicate candidate the
// consolidation engine would raise, and writes the plan + counts to
// .career-out/evidence/audit-<stamp>.json. Never writes a row.

import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

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
  const { buildConsolidationPlan, experienceLabelShort } = await import('../lib/career/evidence/consolidate')
  const { orgKey } = await import('../lib/career/evidence/consolidate-rules')
  const { loadSuppressedPairs } = await import('../lib/career/evidence/consolidate-apply')
  const { renderPlanReport } = await import('../lib/career/evidence/consolidate-report')

  let userId = opt('user')
  if (!userId) {
    const { data } = await createServiceClient().from('profiles').select('id').limit(1)
    userId = (data?.[0]?.id as string | undefined) ?? null
  }
  if (!userId) { console.error('no user'); process.exitCode = 1; return }

  const { bank, migrationMissing, canonical, errors } = await loadEvidenceBank(userId, { approvedOnly: false, includeTombstones: true })
  if (migrationMissing) { console.error('migration 014 not applied'); process.exitCode = 1; return }
  for (const e of errors) console.error(`load: ${e}`)
  const { pairs: suppressed } = await loadSuppressedPairs(userId)
  const plan = buildConsolidationPlan(bank, { suppressed, migration015: canonical })

  const counts: Record<string, number> = {}
  for (const [k, v] of Object.entries(bank)) if (Array.isArray(v)) counts[k] = v.length
  console.log(`user ${userId} · migration015 ${canonical ? 'applied' : 'NOT applied'}`)
  console.log('counts: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '))
  const tomb = bank.experiences.filter((e) => e.status === 'merged').length + bank.facts.filter((f) => f.status === 'merged').length
  console.log(`tombstones: ${tomb}`)

  console.log('\nORGANIZATION GROUPS')
  const groups = new Map<string, typeof bank.experiences>()
  for (const e of bank.experiences) groups.set(orgKey(e.organization), [...(groups.get(orgKey(e.organization)) ?? []), e])
  for (const [key, rows] of [...groups.entries()].sort()) {
    console.log(`\n  ${key}`)
    for (const e of rows) {
      const nf = bank.facts.filter((f) => f.experience_id === e.id && f.status !== 'merged').length
      const nm = bank.metrics.filter((m) => m.experience_id === e.id && m.status !== 'merged').length
      const nb = bank.bullets.filter((b) => b.experience_id === e.id).length
      console.log(`    ${e.id.slice(0, 8)} ${e.status === 'merged' ? '[merged] ' : ''}${e.kind.padEnd(10)} | ${e.title} | ${[e.start_date, e.end_date].filter(Boolean).join('–') || 'no dates'} | ${e.source} | ${e.approved ? 'approved' : 'pending'} | ${nf} facts ${nm} metrics ${nb} bullets`)
    }
  }

  console.log('\n' + renderPlanReport(plan))

  console.log('\nFACTS WITHOUT PROVENANCE ROWS')
  for (const f of plan.provenance.facts_missing_provenance) {
    const fact = bank.facts.find((x) => x.id === f.fact_id)
    console.log(`  ${f.fact_id.slice(0, 8)} ${f.source}${f.source_location ? ` ${f.source_location}` : ''} · ${(fact?.statement ?? '').slice(0, 80)}`)
  }
  console.log('\nORPHAN METRICS (fact_ids = [])')
  for (const m of bank.metrics) if (m.fact_ids.length === 0 && m.status !== 'merged') {
    const e = bank.experiences.find((x) => x.id === m.experience_id)
    console.log(`  ${m.id.slice(0, 8)} ${m.value}${m.context ? ` — ${m.context}` : ''} · ${e ? experienceLabelShort(e) : '(no experience)'}`)
  }

  const outDir = path.join(process.cwd(), '.career-out', 'evidence')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = opt('json') ?? path.join(outDir, `audit-${stamp()}.json`)
  fs.writeFileSync(outPath, JSON.stringify({ user_id: userId, migration015: canonical, counts, plan }, null, 2))
  console.log(`\nwrote ${outPath}`)
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
