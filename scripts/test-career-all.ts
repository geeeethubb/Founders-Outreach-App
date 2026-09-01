// Runs every offline Career OS check in sequence and fails if any fails.
//
//   npm run test:career
//
// No network, no keys — the document suite renders PDFs only when Word is
// installed and reports 'skipped' otherwise. One command a founder can run
// before applying a migration or after pulling.

import { spawnSync } from 'child_process'

const SUITES = [
  'scripts/test-career-applications.ts',
  'scripts/test-career-identity.ts',
  'scripts/test-career-companies.ts',
  'scripts/test-career-scout-run.ts',
  'scripts/test-career-tmp.ts',
  'scripts/test-career-sources.ts',
  'scripts/test-career-sweep.ts',
  'scripts/test-career-relevance.ts',
  'scripts/test-career-mission.ts',
  'scripts/test-career-ontology.ts',
  'scripts/test-career-coverage.ts',
  'scripts/test-career-modes.ts',
  'scripts/test-career-simplify.ts',
  'scripts/test-career-oracle-taleo.ts',
  'scripts/test-career-ats-feeds.ts',
  'scripts/test-career-dataforseo.ts',
  'scripts/test-career-tenants.ts',
  'scripts/test-career-ui-direction.ts',
  'scripts/test-career-evidence.ts',
  'scripts/test-career-provenance.ts',
  'scripts/test-career-retrieval.ts',
  'scripts/test-career-consolidation.ts',
  'scripts/test-career-canonical-view.ts',
  'scripts/test-career-jobs.ts',
  'scripts/test-career-discovery-agents.ts',
  'scripts/test-career-intelligence.ts',
  'scripts/test-career-tailor.ts',
  'scripts/test-career-auto.ts',
  'scripts/test-career-status-letter.ts',
  'scripts/test-career-batch.ts',
  'scripts/test-career-queue.ts',
  'scripts/test-career-evals.ts',
  'scripts/test-career-scout.ts',
  'scripts/test-career-letter.ts',
  'scripts/test-career-package.ts',
  'scripts/test-career-documents.ts',
]

let failed = 0
for (const suite of SUITES) {
  const started = Date.now()
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', suite], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  const summary = out.trim().split('\n').filter((l) => /passed|failed|FAIL|all .* passed/i.test(l)).slice(-2).join(' · ')
  const ok = res.status === 0
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${suite.padEnd(44)} ${((Date.now() - started) / 1000).toFixed(1)}s  ${summary}`)
  if (!ok) console.log(out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12).map((l) => `      ${l}`).join('\n'))
}

console.log(failed === 0 ? `\nall ${SUITES.length} suites passed` : `\n${failed} suite(s) FAILED`)
process.exitCode = failed === 0 ? 0 : 1
