// Phase 6 eval entry point.
//   npm run eval:phase6 -- <iteration-label> [profileId ...]
//
// Defaults to APOLLO_CACHE_ONLY=true: Apollo lead credits are exhausted, and
// replaying the frozen candidate pool also keeps iterations comparable.
// Set APOLLO_CACHE_ONLY=false explicitly to spend credits.

import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })

if (process.env.APOLLO_CACHE_ONLY === undefined) {
  process.env.APOLLO_CACHE_ONLY = 'true'
}

async function main() {
  const args = process.argv.slice(2)
  const iteration = args[0] ?? '1'
  const profileFilter = args.slice(1)

  const { runPhase6Eval, printPhase6Summary, savePhase6Run } = await import('../evals/phase6/run')
  const { SEARCH_PROFILES } = await import('../evals/phase3/mission')

  const profiles = profileFilter.length
    ? SEARCH_PROFILES.filter((p) => profileFilter.includes(p.id))
    : SEARCH_PROFILES

  if (profiles.length === 0) {
    process.stderr.write(`No profiles matched: ${profileFilter.join(', ')}\n`)
    process.stderr.write(`Available: ${SEARCH_PROFILES.map((p) => p.id).join(', ')}\n`)
    process.exit(1)
  }

  const result = await runPhase6Eval(iteration, undefined, profiles)
  printPhase6Summary(result)
  process.stdout.write(`Saved: ${savePhase6Run(result)}\n`)
  process.exit(result.passed ? 0 : 1)
}

main().catch((e) => {
  process.stderr.write(`\nPhase 6 eval failed: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(2)
})
