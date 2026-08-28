// The RÉSUMÉ FACTUALITY EVAL from the command line (docs/CAREER_OS.md §9).
//
//   npx tsx scripts/career-eval-factuality.ts [--only atk-02-invented-software]
//
// No database. Needs ./Zuyu_Resume.docx (or CAREER_RESUME) and
// ANTHROPIC_API_KEY. First run ≈ $8–12 (8 extractions, 8 matcher calls, 8
// tailor runs with their verifier calls, ~16 planted-bullet verifier calls,
// one judge call per SUPPORTED rewrite); a re-run of unchanged inputs is
// free. Results: .career-out/eval/factuality/results.json — which holds the
// résumé's bullets, and is gitignored for that reason.
//
// Exit 1 when an unsupported claim reaches the output or a planted
// fabrication passes both gates.

import { costMeter, evalMission, evalToolContext, memoryRun, metricsTable, money, requireLiveEnv, short, writeResult } from '../evals/career/harness'
import { runFactualityEval } from '../evals/career/factuality'
import { loadAttacks, loadStableBank } from '../evals/career/letter-harness'
import { printTable } from '../evals/career/metrics'

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const resume = requireLiveEnv()
  const meter = costMeter()
  const mission = evalMission()
  const ctx = evalToolContext()
  const run = memoryRun()
  const started = Date.now()

  console.log('\nRÉSUMÉ FACTUALITY EVAL — factuality-attacks, no DB\n')
  const stable = await loadStableBank(resume, ctx)
  console.log(`bank: ${stable.bank.experiences.length} experiences · ${stable.bank.bullets.length} bullets · ${stable.bank.facts.length} facts · ${stable.fromCache ? 'stable ids from cache' : 'fresh ids'} · ${money(meter.lap('bank').costUsd)}\n`)

  const only = opt('only')
  const attacks = loadAttacks().filter((a) => !only || a.id === only)
  const r = await runFactualityEval({ attacks, stable, mission, ctx, run, log: (l) => console.log(`  ${l}`) })
  const pipeline = meter.lap('extract + match + tailor + verify + judge')

  console.log('\n── per attack ──')
  printTable(
    ['attack', 'proposed', 'supported', 'auto-rej', 'tailor-rej', 'unsupported', 'legit', 'judge-no', 'plants', 'caught', 'cost'],
    r.attacks.map((a) => [a.id, a.proposed, a.supported, a.auto_rejected, a.tailor_rejected, a.unsupported_in_output.length, a.legitimately_present.length, a.judge_disagreements.length, a.plants.length, a.plants.filter((p) => p.caught_by.length).length, money(a.costUsd + a.judgeCostUsd)])
  )

  for (const a of r.attacks) {
    console.log(`\n── ${a.id} (${a.attack}) — ${a.company}: ${a.title}`)
    if (a.tailor_error) console.log(`  tailor error: ${a.tailor_error}`)
    if (a.no_change_reason) console.log(`  no change: ${a.no_change_reason}`)
    for (const c of a.changes) {
      const tag = c.review_status === 'pending' ? 'SUPPORTED   ' : `${c.verification_result.padEnd(12)}`
      const kind = c.change_type === 'reword' && !c.wording_changed ? ' (emphasis / wording unchanged)' : ''
      console.log(`  ${tag} ${c.change_type} L${c.edit_level}${kind} [${short(c.experience, 40)}]`)
      if (c.final && c.final !== c.original) console.log(`     + ${short(c.final, 150)}`)
      if (c.review_status === 'auto_rejected') console.log(`     reason: ${short(c.notes, 200)}`)
      for (const h of c.term_hits) console.log(`     ${h.legitimate ? 'legitimately present' : 'UNSUPPORTED IN OUTPUT'}: "${h.term}"`)
      if (c.judge && !c.judge.faithful) console.log(`     judge disagrees (${c.judge.factual ? 'factual' : 'stylistic'}): ${c.judge.issues.join(' | ')}`)
    }
    for (const p of a.plants) {
      console.log(`  plant "${p.template}" → ${p.caught_by.length ? `caught by ${p.caught_by.join(' + ')}` : 'PASSED BOTH GATES'}`)
      console.log(`     ${short(p.fabricated, 160)}`)
      if (p.precheck.caught) console.log(`     precheck: ${p.precheck.findings.join('; ')}`)
      if (p.verifier.overall) console.log(`     verifier: ${p.verifier.overall}${p.verifier.failing.length ? ` — ${short(p.verifier.failing.join('; '), 200)}` : ''}`)
      if (p.verifier.error) console.log(`     verifier error: ${p.verifier.error}`)
    }
  }
  for (const e of r.errors) console.log(`  error: ${e}`)

  console.log('\n── results ──')
  console.log(metricsTable(r.metrics))
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(`\ncost: ${money(meter.total())} this process (${pipeline.calls} live calls, ${pipeline.cached} cached) · agents ${money(r.costUsd)} · judge ${money(r.judgeCostUsd)} · ${elapsed}s`)

  const file = writeResult('factuality', 'results.json', { ran_at: new Date().toISOString(), n: attacks.length, metrics: r.metrics, attacks: r.attacks, errors: r.errors, cost: { process: meter.total(), laps: meter.laps(), agents: r.costUsd, judge: r.judgeCostUsd }, elapsed_s: elapsed })
  console.log(`wrote ${file}`)
  process.exitCode = r.metrics.every((m) => m.pass) ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
