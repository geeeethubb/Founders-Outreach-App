// The COVER-LETTER EVAL from the command line (docs/CAREER_OS.md §9).
//
//   npx tsx scripts/career-eval-cover-letter.ts [--research-fictional]
//
// No database. Needs ./Zuyu_Resume.docx (or CAREER_RESUME), ANTHROPIC_API_KEY,
// network access to the four live boards, and a PDF renderer for the
// one-page check. First run ≈ $12–15 (four company researchers at ~$2.5,
// six letters, six matcher calls, six judge calls); the researcher is cached
// per company per month and everything else by content, so a re-run is
// close to free. Results: .career-out/eval/cover-letter/results.json plus the
// DOCX/PDF of every letter. Exit 1 when a target fails.

import { shutdownPdfRenderers, selectPdfRenderer } from '../lib/career/documents/pdf'
import { costMeter, evalMission, evalToolContext, memoryRun, metricsTable, money, requireLiveEnv, short, writeResult } from '../evals/career/harness'
import { runCoverLetterEval } from '../evals/career/cover-letter'
import { LETTER_DIMENSIONS } from '../evals/career/judge'
import { loadStableBank } from '../evals/career/letter-harness'
import { printTable } from '../evals/career/metrics'

async function main(): Promise<void> {
  const resume = requireLiveEnv()
  const meter = costMeter()
  const mission = evalMission()
  const ctx = evalToolContext()
  const run = memoryRun()
  const started = Date.now()

  console.log('\nCOVER-LETTER EVAL — 4 live companies + 2 fictional, no DB\n')
  const renderer = await selectPdfRenderer()
  console.log(`renderer: ${renderer?.id ?? 'none (one-page check unavailable)'}`)
  const stable = await loadStableBank(resume, ctx)
  console.log(`bank: ${stable.bank.experiences.length} experiences · ${stable.bank.facts.length} facts · ${stable.fromCache ? 'stable ids from cache' : 'fresh ids'} · ${money(meter.lap('bank').costUsd)}\n`)

  const r = await runCoverLetterEval({ stable, mission, ctx, run, researchFictional: process.argv.includes('--research-fictional'), log: (l) => console.log(`  ${l}`) })
  const pipeline = meter.lap('research + match + write + judge')

  console.log('\n── per letter ──')
  printTable(
    ['id', 'kind', 'facts/pts', 'attempts', '1p-retry', 'words', 'grounding', 'pages', 'banned', 'foreign', ...LETTER_DIMENSIONS.map((d) => d.slice(0, 8)), 'cost'],
    r.cases.map((c) => [
      c.id, c.kind, c.research.ran ? `${c.research.facts}/${c.research.grounded_points}` : '-', c.attempts, c.one_page_retried ? `from ${c.one_page_retry_from}` : '-', c.word_count ?? '-',
      c.grounding_ok === null ? '-' : c.grounding_ok ? 'ok' : `${c.blocking.length} BLOCK`, c.page_count ?? '-', c.banned_phrases.length, c.foreign_proper_nouns ? c.foreign_proper_nouns.length : '-',
      ...LETTER_DIMENSIONS.map((d) => (c.judge ? c.judge.scores[d].toFixed(2) : '-')), money(c.costUsd + c.judgeCostUsd),
    ])
  )
  for (const c of r.cases) {
    console.log(`\n── ${c.id} (${c.kind}) — ${c.company}: ${c.title}${c.source_url ? `\n   ${c.source_url}` : ''}`)
    if (c.research.error) console.log(`  research error: ${c.research.error}`)
    for (const b of c.blocking) console.log(`  BLOCKING ${b}`)
    for (const w of c.warnings) console.log(`  warn ${w}`)
    for (const q of c.qa_failed) console.log(`  qa: ${q}`)
    if (c.banned_phrases.length) console.log(`  banned: ${c.banned_phrases.join(', ')}`)
    if (c.foreign_proper_nouns?.length) console.log(`  foreign proper nouns: ${c.foreign_proper_nouns.join(', ')}`)
    if (c.judge) {
      for (const d of LETTER_DIMENSIONS) console.log(`  ${d.padEnd(20)} ${c.judge.scores[d].toFixed(2)}  ${short(c.judge.justifications[d], 140)}`)
      for (const s of c.judge.suspect_claims) console.log(`  suspect: ${short(s, 180)}`)
    } else if (c.judge_error) console.log(`  judge error: ${c.judge_error}`)
    for (const e of c.errors) console.log(`  error: ${e}`)
    console.log(`  ${c.pdf ?? c.docx ?? '(no document)'}`)
  }
  for (const e of r.errors) console.log(`  error: ${e}`)

  console.log('\n── results ──')
  console.log(metricsTable(r.metrics))
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(`\ncost: ${money(meter.total())} this process (${pipeline.calls} live calls, ${pipeline.cached} cached) · agents ${money(r.costUsd)} · judge ${money(r.judgeCostUsd)} · ${elapsed}s`)

  const file = writeResult('cover-letter', 'results.json', { ran_at: new Date().toISOString(), n: r.cases.length, metrics: r.metrics, dimension_means: r.dimension_means, suspect_claims: r.suspect_claims, cases: r.cases, errors: r.errors, cost: { process: meter.total(), laps: meter.laps(), agents: r.costUsd, judge: r.judgeCostUsd }, elapsed_s: elapsed })
  console.log(`wrote ${file}`)
  shutdownPdfRenderers()
  process.exitCode = r.metrics.every((m) => m.pass) ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  shutdownPdfRenderers()
  process.exitCode = 1
})
