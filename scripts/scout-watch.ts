// Watch one scouting run to its terminal state, through the real routes, as the founder.
//
//   npx tsx scripts/scout-watch.ts --base http://localhost:3100 --kind people --run <id>
//   npx tsx scripts/scout-watch.ts --base https://<app> --kind jobs --run <id> --max-wait 2400
//
// The acceptance harness (scripts/scout-acceptance.ts) starts a run and watches
// it; this only watches — for a run started from the page, or when the harness
// process itself cannot live as long as the run. It prints every change of
// status/stage/pass, every queue action the server took on the run, the
// terminal row, the persisted result, and whether the kind is free again.
// Nothing here changes the run.
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
const MAX_WAIT_MS = Number(opt('max-wait', '2400')) * 1000
const POLL_MS = Number(opt('poll', '5')) * 1000
if (!RUN) {
  console.error('--run <id> is required')
  process.exit(2)
}

const t0 = Date.now()
function note(step: string, detail: string): void {
  console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${step}: ${detail}`)
}

async function call(cookie: string, pathname: string): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`${BASE}${pathname}`, { headers: { cookie } })
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

async function main(): Promise<void> {
  const session = await mintSession()
  const cookie = session.cookieHeader
  note('session', `minted for user ${session.userId}; watching ${KIND} run ${RUN}`)
  const detailPath = (withResult: boolean) => (KIND === 'people' ? `/api/scout/runs/${RUN}${withResult ? '?result=1' : ''}` : `/api/career/scout/runs/${RUN}`)
  const activePath = KIND === 'people' ? '/api/scout/runs?active=1&limit=1' : '/api/career/runs?active=1&kind=job_scout&limit=1'

  let lastStage = ''
  let lastInvocation = 0
  let lastAttempts = -1
  let terminal: Record<string, unknown> | null = null
  let polls = 0
  let pollFailures = 0
  const seenActions = new Set<string>()
  while (Date.now() - t0 < MAX_WAIT_MS) {
    const r = await call(cookie, detailPath(false))
    polls++
    if (r.status !== 200 || !r.json?.run) {
      pollFailures++
      note('poll-failure', `${r.status} ${r.text.slice(0, 200)}`)
      if (r.status === 404 || r.status === 401) break
      await new Promise((res) => setTimeout(res, POLL_MS))
      continue
    }
    const run = r.json.run as Record<string, unknown>
    const stage = `${run.status}/${run.stage ?? ''}/${run.invocation ?? 1}`
    const attempts = Number(run.attempts ?? 0)
    if (stage !== lastStage || attempts !== lastAttempts) {
      lastStage = stage
      lastAttempts = attempts
      note('progress', `status=${run.status} stage=${run.stage} pass=${run.invocation} attempts=${attempts} stale=${run.stale} detail=${String(run.detail ?? '').slice(0, 140)} counts=${JSON.stringify(run.counts)}`)
    }
    if (typeof run.invocation === 'number' && run.invocation > lastInvocation) {
      if (lastInvocation > 0) note('chained', `pass ${run.invocation} is executing (the previous pass handed the run back with its checkpoint)`)
      lastInvocation = run.invocation
    }
    const actions = (r.json.queueActions as { action: string; message: string }[] | undefined) ?? []
    for (const a of actions) {
      const key = `${a.action}:${a.message}`
      if (seenActions.has(key)) continue
      seenActions.add(key)
      note('queue-action', `${a.action}: ${a.message}`)
    }
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(String(run.status))) {
      terminal = run
      break
    }
    await new Promise((res) => setTimeout(res, POLL_MS))
  }

  if (!terminal) {
    note('timeout', `no terminal state after ${Math.round(MAX_WAIT_MS / 1000)}s (${polls} polls, ${pollFailures} failures)`)
    process.exitCode = 2
  } else {
    note('terminal', `status=${terminal.status} error_code=${terminal.error_code} remedy=${terminal.remedy ?? null} passes=${terminal.invocation} error=${String(terminal.error ?? '').slice(0, 240)}`)
    note('stats', JSON.stringify(terminal.stats).slice(0, 900))
    if (KIND === 'people') {
      const full = await call(cookie, detailPath(true))
      const result = (full.json?.run as Record<string, unknown> | undefined)?.result as Record<string, unknown> | null
      const prospects = (result?.prospects as Record<string, unknown>[] | undefined) ?? []
      const unranked = (result?.unranked as unknown[] | undefined) ?? []
      note('result', `prospects=${prospects.length} unranked=${unranked.length} complete=${result?.complete} stages=${JSON.stringify(result?.stages)} funnel=${JSON.stringify(result?.funnel)} usage=${JSON.stringify(result?.usage)}`)
      note('result-errors', JSON.stringify((result?.errors as unknown[] | undefined)?.slice(0, 8) ?? []))
      for (const p of prospects.slice(0, 12)) console.log(`      • ${p.name} — ${p.title} @ ${p.company} · ${p.score} ${p.recommendation} · ${p.source}`)
    } else {
      note('result', `jobs=${JSON.stringify(terminal.jobs)} resumable=${terminal.resumable}`)
    }
  }
  const after = await call(cookie, activePath)
  note('after', `${after.status} active=${(after.json?.active as { id?: string } | null)?.id ?? null} (a terminal run must leave the kind free)`)
  console.log(`\nrun ${RUN} · ${polls} polls · ${pollFailures} poll failures · ${terminal ? String(terminal.status) : 'NO TERMINAL STATE'}`)
}

main().catch((e) => {
  console.error('WATCH FAILED', e)
  process.exitCode = 1
})
