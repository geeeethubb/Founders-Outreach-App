// The MINIMAL-EDIT EVAL from the command line (docs/CAREER_OS.md §9).
//
//   npx tsx scripts/career-eval-tailoring.ts
//
// No database. Needs ./Zuyu_Resume.docx (or CAREER_RESUME) and
// ANTHROPIC_API_KEY. Three tailoring runs with their verifier calls; ≈ $2–4
// on a first run, free on a re-run of unchanged inputs (case C shares the
// factuality suite's cache). Results: .career-out/eval/tailoring/results.json.
// Exit 1 when case A or C misses its target; case B only reports.

import { costMeter, evalMission, evalToolContext, memoryRun, metricsTable, money, requireLiveEnv, short, writeResult } from '../evals/career/harness'
import { tailoringPassed, runTailoringEval } from '../evals/career/tailoring'
import { loadStableBank } from '../evals/career/letter-harness'
import { printTable } from '../evals/career/metrics'

async function main(): Promise<void> {
  const resume = requireLiveEnv()
  const meter = costMeter()
  const mission = evalMission()
  const ctx = evalToolContext()
  const run = memoryRun()
  const started = Date.now()

  console.log('\nMINIMAL-EDIT EVAL — three cases, no DB\n')
  const stable = await loadStableBank(resume, ctx)
  console.log(`bank: ${stable.bank.experiences.length} experiences · ${stable.bank.bullets.length} bullets · ${stable.fromCache ? 'stable ids from cache' : 'fresh ids'} · ${money(meter.lap('bank').costUsd)}\n`)

  const r = await runTailoringEval({ stable, mission, ctx, run, log: (l) => console.log(`  ${l}`) })
  const pipeline = meter.lap('extract + match + tailor + verify')

  console.log('\n── per case ──')
  printTable(
    ['case', 'id', 'proposed', 'supported', 'auto-rej', 'by level', 'distance', 'changed', 'reordered', 'over-reword', 'alternate', 'cost'],
    r.cases.map((c) => [c.case, c.id, c.proposed, c.supported, c.auto_rejected, Object.entries(c.by_level).map(([k, v]) => `${k}:${v}`).join(' ') || '-', c.distance, c.changedFraction, String(c.reordered), c.over_reworded.length, c.alternate ? (c.alternate.used ? `used/${c.alternate.status}` : 'unused') : '-', money(c.costUsd)])
  )
  for (const c of r.cases) {
    console.log(`\n── case ${c.case} — ${c.company}: ${c.title}`)
    if (c.tailor_error) console.log(`  tailor error: ${c.tailor_error}`)
    if (c.no_change_reason) console.log(`  no change: ${c.no_change_reason}`)
    if (c.alternate) console.log(`  alternate added to "${c.alternate.experience}" — ${c.alternate.used ? `used (${c.alternate.status})` : 'not used'}`)
    for (const ch of c.changes) {
      console.log(`  ${ch.status.padEnd(13)} ${ch.change_type} L${ch.edit_level}${ch.fraction === 0 ? ' (emphasis / wording unchanged)' : ch.fraction !== null ? ` (${Math.round(ch.fraction * 100)}% of words)` : ''} [${short(ch.experience, 40)}]`)
      if (ch.final && ch.final !== ch.original) console.log(`     + ${short(ch.final, 150)}`)
    }
    for (const o of c.over_reworded) console.log(`  over-reworded (${Math.round(o.fraction * 100)}%): ${short(o.final, 120)}`)
  }
  for (const e of r.errors) console.log(`  error: ${e}`)

  console.log('\n── results ──')
  console.log(metricsTable(r.metrics))
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(`\ncost: ${money(meter.total())} this process (${pipeline.calls} live calls, ${pipeline.cached} cached) · agents ${money(r.costUsd)} · ${elapsed}s`)

  const file = writeResult('tailoring', 'results.json', { ran_at: new Date().toISOString(), metrics: r.metrics, cases: r.cases, errors: r.errors, cost: { process: meter.total(), laps: meter.laps(), agents: r.costUsd }, elapsed_s: elapsed })
  console.log(`wrote ${file}`)
  process.exitCode = tailoringPassed(r) ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
