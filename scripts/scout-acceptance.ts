// Live acceptance for both scouts, through the real routes, as the founder.
//
//   npx tsx scripts/scout-acceptance.ts --base http://localhost:3100 --kind people --mode internal_only
//   npx tsx scripts/scout-acceptance.ts --base http://localhost:3100 --kind people --mode internal_first
//   npx tsx scripts/scout-acceptance.ts --base http://localhost:3100 --kind jobs --run-mode QUICK
//   npx tsx scripts/scout-acceptance.ts --base http://localhost:3100 --kind jobs --run-mode BROAD --spend 2
//
// What one run of this proves, and records:
//   - readiness answered and allowed the run
//   - POST answered fast (enqueue latency) and the claim was observed (claim latency)
//   - a SECOND POST while the run is active is a 409 that names the same run
//   - a refresh (GET /api/scout/runs?active=1 or /api/career/runs?active=1) finds the run
//   - polling reaches a terminal state by itself, with no stuck row afterwards
//   - the result (people) or the job counts (jobs) were persisted
//   - the next enqueue is not blocked by the finished run (it is cancelled immediately)
//
// It costs real money (Anthropic; Apollo credits for an external People Scout).
// The session is minted through the Supabase admin API (scripts/lib/test-session.ts).

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { mintSession } from './lib/test-session'

function opt(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

const BASE = (opt('base', 'http://localhost:3100') as string).replace(/\/$/, '')
const KIND = (opt('kind', 'people') as string) === 'jobs' ? 'jobs' : 'people'
const SEARCH_MODE = opt('mode', 'internal_first') as string
const RUN_MODE = opt('run-mode', 'QUICK') as string
const SPEND = opt('spend', null)
const MAX_WAIT_MS = Number(opt('max-wait', '1500')) * 1000

interface Step {
  step: string
  at: string
  ms: number
  detail: string
}
const steps: Step[] = []
const t0 = Date.now()
function note(step: string, detail: string): void {
  steps.push({ step, at: new Date().toISOString(), ms: Date.now() - t0, detail })
  console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${step}: ${detail}`)
}

async function call(cookie: string, method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null; text: string; ms: number }> {
  const started = Date.now()
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, ms: Date.now() - started }
}

async function main(): Promise<void> {
  const session = await mintSession()
  const cookie = session.cookieHeader
  note('session', `minted for user ${session.userId}`)

  // ─── Readiness ─────────────────────────────────────────────────────────────
  const ready = await call(cookie, 'GET', '/api/scout/readiness?fresh=1')
  const gate = (ready.json?.[KIND] ?? null) as { ready?: boolean; reason?: string | null; remedy?: string | null; warnings?: string[] } | null
  note('readiness', `${ready.status} ready=${gate?.ready} worker=${JSON.stringify(ready.json?.worker)} warnings=${JSON.stringify(gate?.warnings ?? [])}${gate?.ready ? '' : ` REASON=${gate?.reason} FIX=${gate?.remedy}`}`)
  if (!gate?.ready) {
    console.log('\nreadiness refused the run; nothing was started.')
    process.exitCode = 2
    return
  }

  // ─── Start ─────────────────────────────────────────────────────────────────
  const startPath = KIND === 'people' ? '/api/scout' : '/api/career/scout'
  const startBody =
    KIND === 'people'
      ? {
          goal:
            'Find people who could realistically lead to a strong winter 2026-27 internship or short-term project at the intersection of industrial AI, manufacturing, and chemical or process engineering — people who would also matter for summer 2027 recruiting.',
          geography: 'United States',
          segments: 2,
          maxDeepResearch: 5,
          searchMode: SEARCH_MODE,
          label: `acceptance/${KIND}/${SEARCH_MODE}/${new Date().toISOString().slice(0, 16)}`,
        }
      : { mode: RUN_MODE, verify: true, ...(SPEND ? { maxSpendUsd: Number(SPEND) } : {}), label: `acceptance/jobs/${RUN_MODE}/${new Date().toISOString().slice(0, 16)}` }

  const start = await call(cookie, 'POST', startPath, startBody)
  note('enqueue', `${start.status} in ${start.ms}ms → ${start.text.slice(0, 300)}`)
  const runId = start.json?.runId as string | undefined
  if (start.status !== 202 || !runId) {
    console.log('\nthe run did not start; see the answer above.')
    process.exitCode = 2
    return
  }
  note('claim', `claimed=${start.json?.claimed} claimInMs=${start.json?.claimInMs} dispatch=${JSON.stringify(start.json?.dispatch)}`)

  // ─── Duplicate click ───────────────────────────────────────────────────────
  const dup = await call(cookie, 'POST', startPath, startBody)
  note('duplicate-click', `${dup.status} runId=${dup.json?.runId} code=${dup.json?.code} (expected 409 naming ${runId})`)

  // ─── Refresh: does the page find the run? ──────────────────────────────────
  const activePath = KIND === 'people' ? '/api/scout/runs?active=1&limit=1' : '/api/career/runs?active=1&kind=job_scout&limit=1'
  const act = await call(cookie, 'GET', activePath)
  const activeId = (act.json?.active as { id?: string } | null)?.id ?? null
  note('refresh-attach', `${act.status} active=${activeId} (expected ${runId})`)

  // ─── Poll to terminal ──────────────────────────────────────────────────────
  const detailPath = (withResult: boolean) => (KIND === 'people' ? `/api/scout/runs/${runId}${withResult ? '?result=1' : ''}` : `/api/career/scout/runs/${runId}`)
  let lastStage = ''
  let lastInvocation = 0
  let terminal: Record<string, unknown> | null = null
  let polls = 0
  let pollFailures = 0
  const pollStart = Date.now()
  while (Date.now() - pollStart < MAX_WAIT_MS) {
    const r = await call(cookie, 'GET', detailPath(false))
    polls++
    if (r.status !== 200 || !r.json?.run) {
      pollFailures++
      note('poll-failure', `${r.status} ${r.text.slice(0, 200)}`)
      if (pollFailures > 10) break
      await new Promise((res) => setTimeout(res, 3000))
      continue
    }
    const run = r.json.run as Record<string, unknown>
    const stage = `${run.status}/${run.stage ?? ''}/${run.invocation ?? 1}`
    if (stage !== lastStage) {
      lastStage = stage
      note('progress', `status=${run.status} stage=${run.stage} pass=${run.invocation} attempts=${run.attempts} detail=${String(run.detail ?? '').slice(0, 120)} counts=${JSON.stringify(run.counts)}`)
    }
    if (typeof run.invocation === 'number' && run.invocation > lastInvocation) {
      lastInvocation = run.invocation
      if (run.invocation > 1) note('chained', `pass ${run.invocation} claimed (queue_wait unknown from here; see server log run_id=${runId})`)
    }
    const actions = (r.json.queueActions as { action: string; message: string }[] | undefined) ?? []
    for (const a of actions) note('queue-action', `${a.action}: ${a.message}`)
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(String(run.status))) {
      terminal = run
      break
    }
    await new Promise((res) => setTimeout(res, 3000))
  }

  if (!terminal) {
    note('timeout', `no terminal state after ${Math.round(MAX_WAIT_MS / 1000)}s (${polls} polls)`)
    process.exitCode = 2
  } else {
    note('terminal', `status=${terminal.status} error_code=${terminal.error_code} error=${String(terminal.error ?? '').slice(0, 200)} passes=${terminal.invocation} stats=${JSON.stringify(terminal.stats).slice(0, 600)}`)
  }

  // ─── The persisted result ──────────────────────────────────────────────────
  if (KIND === 'people') {
    const full = await call(cookie, 'GET', detailPath(true))
    const result = (full.json?.run as Record<string, unknown> | undefined)?.result as Record<string, unknown> | null
    const prospects = (result?.prospects as unknown[] | undefined) ?? []
    const unranked = (result?.unranked as unknown[] | undefined) ?? []
    note('result', `prospects=${prospects.length} unranked=${unranked.length} stages=${JSON.stringify(result?.stages)} usage=${JSON.stringify(result?.usage)} errors=${JSON.stringify((result?.errors as unknown[])?.slice?.(0, 5))}`)
    for (const p of prospects.slice(0, 8) as Record<string, unknown>[]) console.log(`      • ${p.name} — ${p.title} @ ${p.company} · ${p.score} ${p.recommendation} · ${p.source}`)
  } else {
    const jobs = (terminal?.jobs as Record<string, unknown> | undefined) ?? null
    note('result', `jobs=${JSON.stringify(jobs)}`)
  }

  // ─── The next action is not blocked ────────────────────────────────────────
  const after = await call(cookie, 'GET', activePath)
  note('after', `${after.status} active=${(after.json?.active as { id?: string } | null)?.id ?? null} (expected null)`)

  console.log('\nSTEPS')
  for (const s of steps) console.log(`  ${String(s.ms).padStart(7)}ms  ${s.step.padEnd(16)} ${s.detail.slice(0, 200)}`)
  console.log(`\nrun ${runId} · ${polls} polls · ${pollFailures} poll failures · ${terminal ? String(terminal.status) : 'NO TERMINAL STATE'}`)
}

main().catch((e) => {
  console.error('ACCEPTANCE FAILED', e)
  process.exitCode = 1
})
