// The fault-injection matrix for the two scouting flows, run in sequence.
//
//   npm run test:scout-reliability
//
// No network, no keys, no database: every suite drives the durable-run kernel
// and the platform edges against in-memory fakes and fake clocks. Each suite
// is its own process (spawnSync, like scripts/test-career-all.ts), so a suite
// that leaks a handle shows up as a slow line here rather than a hung run.
// Exits non-zero if any suite fails — or is missing.

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

/** tsx's CLI entry, run under this same node — no shell, so arguments are never concatenated. */
const TSX = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')

const SUITES = [
  'scripts/reliability/kernel.ts',
  'scripts/reliability/kernel-edges.ts',
  'scripts/reliability/watchdog.ts',
  'scripts/reliability/dispatch.ts',
  'scripts/reliability/readiness.ts',
  'scripts/reliability/apollo.ts',
  'scripts/reliability/fetch-bounds.ts',
  'scripts/reliability/api-errors.ts',
  'scripts/reliability/log.ts',
  // Written by the people-scout pass; reported as missing until it exists.
  'scripts/reliability/people-scout.ts',
]

/** A suite that takes longer than this has leaked a timer or is sleeping for real. */
const SLOW_SUITE_MS = 30_000

let failed = 0
for (const suite of SUITES) {
  if (!existsSync(suite)) {
    failed++
    console.log(`MISS ${suite.padEnd(44)} (file not found)`)
    continue
  }
  const started = Date.now()
  const res = spawnSync(process.execPath, [TSX, suite], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  })
  const took = Date.now() - started
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  // Two summary shapes: "<suite>: all N checks passed" / "<suite>: N FAILED, M passed"
  // from scripts/reliability/fake-db.ts, and "N passed" / "N passed, M failed" elsewhere.
  const summary = out
    .trim()
    .split('\n')
    .filter((l) => /checks passed$|FAILED, \d+ passed$|^\d+ passed(, \d+ failed)?$|crashed/.test(l.trim()))
    .slice(-1)
    .join(' · ')
    .trim()
  // A suite must SAY it passed. A process that drains its event loop mid-await
  // exits 0 without a summary line, and that is a failure, not a pass.
  const reported = /checks passed$|^\d+ passed$/.test(summary)
  const ok = res.status === 0 && !res.error && took < SLOW_SUITE_MS && reported
  if (!ok) failed++
  const why = res.error
    ? ` (${res.error.message})`
    : took >= SLOW_SUITE_MS
      ? ' (too slow: a handle or a real sleep is holding the process)'
      : res.status === 0 && !reported
        ? ' (exited 0 without reporting: the event loop drained before the suite finished)'
        : ''
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${suite.padEnd(44)} ${(took / 1000).toFixed(1)}s  ${summary}${why}`)
  if (!ok) {
    // Each failing check is printed inline and again in the suite's summary; show it once.
    const lines = [...new Set(out.split('\n').filter((l) => /^\s*FAIL |crashed|Error/.test(l)).map((l) => l.trim()))]
    console.log(lines.slice(0, 20).map((l) => `      ${l}`).join('\n'))
  }
}

console.log(failed === 0 ? `\nall ${SUITES.length} suites passed` : `\n${failed} of ${SUITES.length} suite(s) FAILED`)
process.exitCode = failed === 0 ? 0 : 1
