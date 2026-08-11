// Phase 3 eval entry point.
//   npm run eval:phase3 -- <iteration-label> [profileId ...]
//
// Apollo responses are cached on disk (.provider-cache/), so repeated runs after
// a scoring or prompt change cost model tokens only.

import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const args = process.argv.slice(2)
  const iteration = args[0] ?? '1'
  const profileFilter = args.slice(1)

  // Imported after dotenv so module-level env reads see the loaded values.
  const { runEval, printSummary, saveRun } = await import('../evals/phase3/run')
  const { SEARCH_PROFILES } = await import('../evals/phase3/mission')

  const profiles = profileFilter.length
    ? SEARCH_PROFILES.filter((p) => profileFilter.includes(p.id))
    : SEARCH_PROFILES

  if (profiles.length === 0) {
    process.stderr.write(`No profiles matched: ${profileFilter.join(', ')}\n`)
    process.stderr.write(`Available: ${SEARCH_PROFILES.map((p) => p.id).join(', ')}\n`)
    process.exit(1)
  }

  const result = await runEval(iteration, undefined, profiles)
  printSummary(result)
  const file = saveRun(result)
  process.stdout.write(`Saved: ${file}\n`)

  process.exit(result.passed ? 0 : 1)
}

main().catch((e) => {
  process.stderr.write(`\nEval failed: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(2)
})
