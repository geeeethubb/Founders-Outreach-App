// The FIT-RANKING EVAL from the command line (docs/CAREER_OS.md §9, "fit").
//
//   npx tsx scripts/career-eval-fit.ts
//
// No database. Needs ./Zuyu_Resume.docx (or CAREER_RESUME) and
// ANTHROPIC_API_KEY. First run ≈ $3 (24 cheap extractions + 24 fit
// evaluations + one judge batch); a re-run of unchanged inputs is free.
// Results: .career-out/eval/fit/results.json. Exit 1 when a target fails.

import { costMeter, evalMission, evalToolContext, loadEvalBank, metricsTable, money, requireLiveEnv, short, writeResult } from '../evals/career/harness'
import { loadCorpus, runFitEval } from '../evals/career/fit'
import { printTable } from '../evals/career/metrics'

async function main(): Promise<void> {
  const resume = requireLiveEnv()
  const meter = costMeter()
  const mission = evalMission()
  const ctx = evalToolContext()
  const started = Date.now()

  console.log('\nFIT-RANKING EVAL — jd-corpus, no DB\n')
  const bank = await loadEvalBank(resume, ctx, mission)
  console.log(`bank: ${bank.bank.experiences.length} experiences · ${bank.bank.facts.length} facts · ${bank.bank.skills.length} skills · ${money(meter.lap('bank').costUsd)}\n`)

  const corpus = loadCorpus()
  const r = await runFitEval({ corpus, bank, mission, ctx, log: (l) => console.log(`  ${l}`) })
  const pipeline = meter.lap('extract + fit + judge')

  console.log('\n── ranked ──')
  printTable(
    ['rank', 'id', 'expected', 'elig expected', 'elig got', 'overall', 'band', 'judge', 'type/season/tier'],
    r.rows.map((x) => [x.rank, x.id, x.expected.fit_class, x.expected.eligibility_for_user, x.got.eligibility ?? '-', x.got.overall?.toFixed(3) ?? '-', x.got.band ?? '-', x.judge ?? '', `${x.got.employment_type}/${x.got.season_relevance}/t${x.got.location_tier ?? '-'}`])
  )

  console.log('\n── eligibility confusion (rows expected → columns got) ──')
  const cols = ['QUALIFIED', 'STRETCH', 'NOT_QUALIFIED', 'UNKNOWN', 'NONE']
  printTable(['expected', ...cols], Object.entries(r.confusion).map(([e, got]) => [e, ...cols.map((c) => got[c] ?? 0)]))

  const misclassified = r.rows.filter((x) => x.got.employment_type !== x.expected.employment_type || x.got.season_relevance !== x.expected.season_relevance || x.got.eligibility !== x.expected.eligibility_for_user)
  if (misclassified.length) {
    console.log('\n── rows worth reading ──')
    for (const x of misclassified) {
      console.log(`  ${x.id}: expected ${x.expected.employment_type}/${x.expected.season_relevance}/${x.expected.eligibility_for_user} got ${x.got.employment_type}/${x.got.season_relevance}/${x.got.eligibility ?? '-'} · role ${x.got.role_family ?? '-'}`)
      if (x.got.eligibility !== x.expected.eligibility_for_user) console.log(`      ${short(x.got.eligibility_reasoning, 220)}`)
    }
  }
  if (r.violations.length) {
    console.log('\n── rank-order violations ──')
    for (const v of r.violations) console.log(`  ${v.negative} above ${v.positive}`)
  }
  for (const e of r.errors) console.log(`  error: ${e}`)

  console.log('\n── results ──')
  console.log(metricsTable(r.metrics))
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(`\ncost: ${money(meter.total())} this process (${pipeline.calls} live calls, ${pipeline.cached} cached) · agents ${money(r.costUsd)} · judge ${money(r.judgeCostUsd)} · ${elapsed}s`)

  const file = writeResult('fit', 'results.json', { ran_at: new Date().toISOString(), corpus_n: corpus.length, metrics: r.metrics, confusion: r.confusion, violations: r.violations, rows: r.rows, errors: r.errors, cost: { process: meter.total(), laps: meter.laps(), agents: r.costUsd, judge: r.judgeCostUsd }, elapsed_s: elapsed })
  console.log(`wrote ${file}`)
  process.exitCode = r.metrics.every((m) => m.pass) ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
