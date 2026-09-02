// Does this deployment know where its scouting worker lives?
//
//   npm run check:worker-env
//
// Run it in the deploy pipeline, or by hand before shipping. It exits non-zero
// on an `error` verdict so a build step fails loudly rather than shipping a
// configuration in which "Scout now" queues a run that nothing can ever start.
//
// This is the check that would have caught the 328-minute incident before it
// happened: on Vercel with SCOUT_WORKER_BASE_URL unset, the app POSTs to its own
// per-deployment hostname, Deployment Protection answers 401, and — before this
// pass — that was recorded as a successful dispatch.

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { resolveWorkerBase } from '../lib/career/scout/run-dispatch'
import { checkWorkerBase } from '../lib/career/scout/worker-env'

function main(): void {
  const resolved = resolveWorkerBase(null)
  const health = checkWorkerBase(process.env, resolved)

  const icon = health.severity === 'ok' ? 'ok  ' : health.severity === 'warn' ? 'WARN' : 'FAIL'
  console.log(`${icon} scout worker base`)
  console.log(`     url      ${health.baseUrl || '(none)'}`)
  console.log(`     source   ${health.source}`)
  console.log(`     vercel   ${health.onVercel}`)
  console.log(`     ${health.message}`)
  if (health.remedy) console.log(`     FIX: ${health.remedy}`)

  if (health.severity === 'error') {
    console.log('')
    console.log('Scouting would queue runs that nothing can start. Fix the base URL before deploying.')
    process.exitCode = 1
    return
  }
  if (health.severity === 'warn') {
    console.log('')
    console.log('This will probably work, but it is inferred rather than configured. Pin it to be sure.')
  }
}

main()
