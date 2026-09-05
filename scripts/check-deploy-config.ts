// Can the deployment this environment describes actually work?
//
//   npm run check:deploy
//
// Runs first in `npm run build`, so an invalid Vercel configuration fails the
// build instead of shipping a site whose Scout button queues runs that nothing
// can ever start. Offline and fast: no network, no database — it reads the
// environment and applies lib/runs/deploy-config.ts.
//
// Exit code 1 on an `error` verdict. Warnings print and pass. Off Vercel it
// never errors, so a laptop with a partial .env.local still builds.

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { formatDeployCheck, judgeDeployConfig } from '../lib/runs/deploy-config'

function main(): void {
  const verdict = judgeDeployConfig(process.env)
  const where = verdict.environment.onVercel ? `Vercel (${verdict.environment.vercelEnv ?? 'VERCEL_ENV unset'})` : 'local'
  console.log(`deploy config — ${where}`)
  for (const c of verdict.checks) console.log(formatDeployCheck(c))

  const errors = verdict.checks.filter((c) => c.severity === 'error').length
  const warns = verdict.checks.filter((c) => c.severity === 'warn').length
  console.log('')
  if (verdict.severity === 'error') {
    console.log(`${errors} error(s), ${warns} warning(s). This configuration cannot work; fix it before deploying.`)
    process.exitCode = 1
    return
  }
  if (verdict.severity === 'warn') {
    console.log(`${warns} warning(s). This will probably work, but something is inferred or missing; see FIX lines.`)
    return
  }
  console.log('ok: configuration can work.')
}

main()
