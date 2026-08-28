// The DISCOVERY EVAL from the command line (docs/CAREER_OS.md §9, "discovery").
//
//   npx tsx scripts/career-eval-discovery.ts                 # all three parts
//   npx tsx scripts/career-eval-discovery.ts --skip-job-first  # boards + P@20 only
//
// Live network (the benchmark's public ATS boards, the scout's web search),
// no database. Needs ./Zuyu_Resume.docx (or CAREER_RESUME) and
// ANTHROPIC_API_KEY. First run ≈ $10; every agent call is cached by content,
// so a re-run after a fix costs only what changed. Results land under
// .career-out/eval/discovery/. Exit 1 when any target fails.

import { keylessBoards, loadBenchmark, runCompanyFirstEval, runJobFirstEval, runPrecisionEval } from '../evals/career/discovery'
import { costMeter, evalMission, evalToolContext, loadEvalBank, metricsTable, money, requireLiveEnv, short, writeResult, type MetricResult } from '../evals/career/harness'
import { printTable } from '../evals/career/metrics'
import { summarizeStats } from '../lib/career/scout/stats'

const skipJobFirst = process.argv.includes('--skip-job-first')

async function main(): Promise<void> {
  const resume = requireLiveEnv()
  const meter = costMeter()
  const mission = evalMission()
  const ctx = evalToolContext()
  const started = Date.now()
  const benchmark = loadBenchmark()
  const boards = keylessBoards(benchmark)

  console.log(`\nDISCOVERY EVAL — ${benchmark.length} benchmark companies, ${boards.length} keyless boards, no DB\n`)
  const bank = await loadEvalBank(resume, ctx, mission)
  console.log(`bank: ${bank.bank.experiences.length} experiences · ${bank.bank.facts.length} facts · ${money(meter.lap('bank').costUsd)}\n`)

  // ─── (a) Company-first ───
  console.log('── (a) company-first over the benchmark boards ──')
  const cf = await runCompanyFirstEval({ companies: boards, mission, ctx, log: (l) => console.log(`  ${l}`) })
  const cfCost = meter.lap('company-first')
  console.log(`\n  ${cf.jobs.length} jobs after constraints (${cf.clusters} clusters) · rejected: ${Object.entries(cf.rejected).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'} · ${money(cfCost.costUsd)} (${cfCost.calls} live, ${cfCost.cached} cached)`)
  console.log(`  pool: ${cf.postingsListed} internship-like postings listed across ${boards.length} boards · ${cf.boardsAtCap} board(s) filled the per-board cap (pool may be truncated)`)
  if (cf.zeroInternships.length) console.log(`  boards with zero internship-like postings today: ${cf.zeroInternships.join(', ')}`)
  if (cf.internshipDisagreements.length) {
    console.log('  internship classification disagreements (extractor vs title):')
    for (const d of cf.internshipDisagreements) console.log(`    ${d.company} / ${short(d.title, 70)} → ${d.employment_type} (title says intern: ${d.titleSaysIntern})`)
  }
  if (cf.location.tierMismatches.length) {
    console.log('  tier mismatches at HQ:')
    for (const m of cf.location.tierMismatches) console.log(`    ${m.company}: "${m.location_raw}" → tier ${m.tier ?? 'null'}, benchmark ${m.expected}`)
  }
  if (cf.stale.notOpen.length) {
    console.log('  shown open but not open on re-check:')
    for (const s of cf.stale.notOpen) console.log(`    ${s.company} / ${short(s.title, 60)}: ${s.status} — ${s.note}`)
  }

  // ─── (b) Job-first ───
  let jf: Awaited<ReturnType<typeof runJobFirstEval>> | null = null
  if (!skipJobFirst) {
    console.log('\n── (b) job-first: one real scout run in memory ──')
    jf = await runJobFirstEval({ bank, mission, log: (stage, detail) => console.log(`  [${stage}] ${detail}`) })
    const jfCost = meter.lap('job-first')
    for (const l of summarizeStats(jf.result.stats)) console.log(`  ${l}`)
    console.log(`  queries: ${jf.result.stats.queries.map((q) => `"${q}"`).join(' · ')}`)
    console.log(`  runtime ${Math.round(jf.runtimeMs / 1000)}s · ${money(jfCost.costUsd)} this process (${jfCost.calls} live, ${jfCost.cached} cached) · run reports ${money(jf.result.costUsd)}`)
    for (const e of jf.result.errors) console.log(`  error: ${e}`)
    if (jf.canonical.miss.length) {
      console.log('  canonical misses (aggregator, or no first-party URL):')
      for (const m of jf.canonical.miss) console.log(`    ${m.company} / ${short(m.title, 60)}: ${m.canonical_url ?? 'null'} [${m.source_types.join(',')}]`)
    }
    console.log('  rejected by reason:')
    for (const [k, n] of Object.entries(jf.result.stats.jobs_rejected)) console.log(`    ${k}: ${n}`)
  }

  // ─── (c) P@20 ───
  console.log('\n── (c) fit-ranked union, judged ──')
  const pe = await runPrecisionEval({ companyFirst: cf.jobs, jobFirst: jf?.jobs ?? [], benchmark, bank, mission, ctx, log: (l) => console.log(`  ${l}`) })
  const peCost = meter.lap('fit + judge')
  if (pe.judgeError) console.log(`  judge: ${pe.judgeError}`)
  for (const f of pe.fitFailures) console.log(`  fit failed: ${f}`)
  console.log(`  ${pe.rows.length} jobs ranked · eligibility: ${Object.entries(pe.eligibility).map(([k, n]) => `${k} ${n}`).join(', ')} · ${money(peCost.costUsd)} (${peCost.calls} live, ${peCost.cached} cached)\n`)
  printTable(
    ['#', 'company', 'title', 'location', 'tier', 'season', 'fit', 'band', 'eligibility', 'judge', 'from'],
    pe.top20.map((r, i) => [i + 1, short(r.company, 22), short(r.title, 44), short(r.location_raw, 24), r.tier ?? '-', r.season, r.overall?.toFixed(3) ?? '-', r.band ?? '-', r.eligibility ?? '-', r.judge ?? '', r.source])
  )
  const bad = pe.top20.filter((r) => r.judge === 'BAD_FIT')
  if (bad.length) {
    console.log('\n  BAD_FIT in the top 20, per the judge:')
    for (const r of bad) console.log(`    ${r.company} / ${short(r.title, 50)}: ${short(r.reasoning, 200)}`)
  }

  // ─── Results ───
  const metrics: MetricResult[] = [...cf.metrics, ...(jf?.metrics ?? []), ...pe.metrics]
  console.log('\n── results ──')
  console.log(metricsTable(metrics))
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(`\ncost: ${money(meter.total())} this process · ${elapsed}s`)

  // results.json is "the latest"; the stamped copy is the evidence. Two evals
  // running at once (career-eval-all in one shell, this script in another)
  // overwrote each other here once, and the P@20 a builder reported from the
  // console was not the one on disk an hour later.
  const ranAt = new Date().toISOString()
  const payload = {
    ran_at: ranAt, benchmark_version: (benchmark as unknown as { version?: string }).version ?? null, boards: boards.length, metrics,
    company_first: { per_company: cf.perCompany, zero_internships: cf.zeroInternships, jobs: cf.jobs.length, clusters: cf.clusters, rejected: cf.rejected, internship_disagreements: cf.internshipDisagreements, location: cf.location, stale: cf.stale, stats: cf.stats, cost: cf.costUsd },
    job_first: jf ? { stats: jf.result.stats, plan: jf.result.plan, errors: jf.result.errors, rejected: jf.result.rejected, jobs: jf.jobs.map((j) => ({ company: j.company_name, title: j.title, location_raw: j.location_raw, tier: j.location_tier, season: j.season_relevance, canonical_url: j.canonical_url, verification: j.verification_status, sources: [...new Set(j.sources.map((s) => s.source_type))] })), canonical: jf.canonical, runtime_ms: jf.runtimeMs } : null,
    precision: { rows: pe.rows, eligibility: pe.eligibility, fit_failures: pe.fitFailures, judge_error: pe.judgeError, cost: pe.costUsd, judge_cost: pe.judgeCostUsd },
    cost: { process: meter.total(), laps: meter.laps() }, elapsed_s: elapsed,
  }
  const file = writeResult('discovery', 'results.json', payload)
  writeResult('discovery', `results-${ranAt.replace(/[:.]/g, '-')}.json`, payload)
  console.log(`wrote ${file}`)
  process.exitCode = metrics.every((m) => m.pass) ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
