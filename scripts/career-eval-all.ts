// Every Career OS eval suite in sequence, one summary table, non-zero exit
// on any failure (docs/CAREER_OS.md §9).
//
//   npx tsx scripts/career-eval-all.ts [--only factuality,cover-letter]
//
// Each suite is its own process, so one crash does not take the others down
// and each keeps its own exit code. Suites write
// .career-out/eval/<suite>/results.json; the table below reads each file's
// metrics after the run, so what is printed is what was measured.

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { formatTable } from '../evals/career/metrics'

interface Suite {
  name: string
  script: string
  results: string
}

const SUITES: Suite[] = [
  { name: 'documents', script: 'scripts/career-eval-documents.ts', results: '.career-out/eval/documents/results.json' },
  { name: 'discovery', script: 'scripts/career-eval-discovery.ts', results: '.career-out/eval/discovery/results.json' },
  { name: 'fit', script: 'scripts/career-eval-fit.ts', results: '.career-out/eval/fit/results.json' },
  { name: 'factuality', script: 'scripts/career-eval-factuality.ts', results: '.career-out/eval/factuality/results.json' },
  { name: 'minimal-edit', script: 'scripts/career-eval-minimal-edit.ts', results: '.career-out/eval/minimal-edit/results.json' },
  { name: 'cover-letter', script: 'scripts/career-eval-cover-letter.ts', results: '.career-out/eval/cover-letter/results.json' },
]

interface Metric {
  metric: string
  display: string
  target: string
  pass: boolean
  n: number
}

function readMetrics(file: string, since: number): { metrics: Metric[] | null; cost: number | null; stale: boolean } | null {
  const p = path.resolve(file)
  if (!fs.existsSync(p)) return null
  try {
    const stale = fs.statSync(p).mtimeMs < since
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as { metrics?: Metric[]; cost?: { process?: number } }
    // The documents suite writes a results file with no metrics array — its
    // exit code is the verdict. `null` here says "exit code only" rather than
    // letting an empty list read as "0 metrics pass".
    return { metrics: Array.isArray(data.metrics) ? data.metrics : null, cost: typeof data.cost?.process === 'number' ? data.cost.process : null, stale }
  } catch {
    return null
  }
}

const RULE = '='.repeat(78)

function main(): void {
  const i = process.argv.indexOf('--only')
  const only = i >= 0 ? new Set(process.argv[i + 1].split(',')) : null
  const suites = SUITES.filter((s) => !only || only.has(s.name))
  const rows: (string | number)[][] = []
  const started = Date.now()
  let failures = 0

  for (const s of suites) {
    if (!fs.existsSync(path.resolve(s.script))) {
      rows.push([s.name, 'MISSING', '-', '-', '-', `${s.script} not found`])
      failures++
      continue
    }
    console.log(`\n${RULE}\n${s.name}  (${s.script})\n${RULE}`)
    const t0 = Date.now()
    const r = spawnSync('npx', ['tsx', s.script], { stdio: 'inherit', shell: true })
    const secs = Math.round((Date.now() - t0) / 1000)
    const status = r.status ?? -1
    const res = readMetrics(s.results, t0)
    const failed = res?.metrics?.filter((m) => !m.pass) ?? []
    // Exit 2 is the suites' "cannot run here" (no résumé, no key, no
    // migration) — reported, not counted as a failure of what was measured.
    const verdict = status === 0 ? 'PASS' : status === 2 ? 'SKIP' : 'FAIL'
    if (status !== 0 && status !== 2) failures++
    rows.push([
      s.name, verdict, status, `${secs}s`, res?.cost !== null && res?.cost !== undefined ? `$${res.cost.toFixed(2)}` : '-',
      res === null ? 'no results file (exit code only)' : res.stale ? 'results file not updated by this run' : res.metrics === null ? 'exit code only (no metrics in results file)' : failed.length ? failed.map((m) => `${m.metric} ${m.display} (target ${m.target})`).join('; ') : `${res.metrics.length} metrics pass`,
    ])
  }

  console.log(`\n${RULE}\nSUMMARY  ${Math.round((Date.now() - started) / 1000)}s\n${RULE}`)
  console.log(formatTable(['suite', 'verdict', 'exit', 'time', 'cost', 'detail'], rows))
  console.log('\nexit 2 = skipped for a missing prerequisite (résumé, key, migration); it does not fail the run.')
  process.exitCode = failures ? 1 : 0
}

main()
