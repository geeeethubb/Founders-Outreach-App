// Does this deployment know where its scouting worker lives?
//
//   npm run check:worker-env
//
// The worker-address view of the deploy judgement. It prints the resolved
// address in full (url, source, headers by name), then every check from
// lib/runs/deploy-config.ts — the SAME judgement `npm run build` runs, so the
// two can never disagree — and exits non-zero on an `error`.
//
// This is the check that would have caught the 328-minute incident before it
// happened: on Vercel with SCOUT_WORKER_BASE_URL unset and no bypass secret,
// the app POSTs to its own per-deployment hostname, Deployment Protection
// answers 401, and — before this pass — that was recorded as a successful
// dispatch.

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { resolveWorkerBase } from '../lib/career/scout/worker-target'
import { formatDeployCheck, judgeDeployConfig } from '../lib/runs/deploy-config'

function main(): void {
  const resolved = resolveWorkerBase(null, process.env)
  console.log('scout worker base')
  console.log(`     url      ${resolved.baseUrl || '(none)'}`)
  console.log(`     source   ${resolved.source}`)
  console.log(`     vercel   ${resolved.vercel.onVercel}${resolved.vercel.env ? ` (${resolved.vercel.env})` : ''}`)
  console.log(`     headers  ${Object.keys(resolved.headers).join(', ') || '(none)'}`)
  console.log('')

  const verdict = judgeDeployConfig(process.env)
  for (const c of verdict.checks) console.log(formatDeployCheck(c))
  console.log('')

  if (verdict.severity === 'error') {
    console.log('Scouting would queue runs that nothing can start. Fix the configuration before deploying.')
    process.exitCode = 1
    return
  }
  if (verdict.severity === 'warn') {
    console.log('This will probably work, but something is inferred rather than configured. Pin it to be sure.')
    return
  }
  console.log('ok: the worker address is configured and the deployment can start runs.')
}

main()
