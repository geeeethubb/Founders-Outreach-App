// Ask a scouting run to stop, through the real route, as the founder.
//
//   npx tsx scripts/scout-cancel.ts --base http://localhost:3100 --kind people --run <id>
//   npx tsx scripts/scout-cancel.ts --base https://<app> --kind jobs --run <id>
//
// A QUEUED run is cancelled outright; a RUNNING run is asked to stop and the
// worker stops at its next step, keeping everything it has found. This prints
// the route's answer and then reads the run once so the row's own state is on
// record. Watch it to the end with scripts/scout-watch.ts.
import { config } from 'dotenv'
import path from 'path'
import { mintSession } from './lib/test-session'

config({ path: path.resolve(process.cwd(), '.env.local') })

function opt(name: string, fallback: string | null): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const BASE = (opt('base', 'http://localhost:3100') as string).replace(/\/$/, '')
const KIND = (opt('kind', 'people') as string) === 'jobs' ? 'jobs' : 'people'
const RUN = opt('run', null)
if (!RUN) {
  console.error('--run <id> is required')
  process.exit(2)
}

async function main(): Promise<void> {
  const session = await mintSession()
  const cookie = session.cookieHeader
  const cancelPath = KIND === 'people' ? `/api/scout/runs/${RUN}/cancel` : `/api/career/scout/runs/${RUN}/cancel`
  const detailPath = KIND === 'people' ? `/api/scout/runs/${RUN}` : `/api/career/scout/runs/${RUN}`
  const started = Date.now()
  const res = await fetch(`${BASE}${cancelPath}`, { method: 'POST', headers: { cookie } })
  const text = await res.text()
  console.log(`cancel: ${res.status} in ${Date.now() - started}ms → ${text.slice(0, 400)}`)
  const after = await fetch(`${BASE}${detailPath}`, { headers: { cookie } })
  const body = (await after.json().catch(() => null)) as { run?: Record<string, unknown> } | null
  const run = body?.run
  console.log(`row: status=${run?.status} stage=${run?.stage} cancel_requested=${run?.cancel_requested} error_code=${run?.error_code} detail=${String(run?.detail ?? '').slice(0, 160)}`)
  if (res.status >= 400) process.exitCode = 1
}

main().catch((e) => {
  console.error('CANCEL FAILED', e)
  process.exitCode = 1
})
