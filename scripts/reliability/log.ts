// formatScoutLog (lib/runs/log.ts): redaction and the ambient run identity.
//
//   npx tsx scripts/reliability/log.ts

import { formatScoutLog, scoutLog } from '../../lib/runs/log'
import { createRunContext, withRunContext } from '../../lib/runs/context'
import { RunClock } from '../../lib/runs/deadline'
import { captureConsole, makeChecker } from './fake-db'

const t = makeChecker()

const ANTHROPIC = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
const OPENAI_SHAPE = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
const CLAIM = 'kcpIQ9toku_uqMTcyjx6ejSTN55xpURn'

async function redaction() {
  console.log('\nredaction by key')
  const line = formatScoutLog({ event: 'x', claim_token: CLAIM, token: CLAIM, secret: 'shh', api_key: 'k1', VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass', authorization: 'Basic abc', cookie: 'sb=1', password: 'pw', worker: 'w_abc' })
  for (const [k, v] of [['claim_token', CLAIM], ['token', CLAIM], ['secret', 'shh'], ['api_key', 'k1'], ['VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass'], ['authorization', 'Basic abc'], ['cookie', 'sb=1'], ['password', 'pw']]) {
    t.check(`key "${k}" is redacted`, line.includes(`${k}="[redacted]"`) && !line.includes(v), line)
  }
  t.check('a non-secret key keeps its value', line.includes('worker="w_abc"'))
  t.check('an empty secret value is dropped, not rendered', !formatScoutLog({ token: '' }).includes('token='))

  console.log('\nredaction by shape')
  const shapes: [string, string][] = [
    ['sk-ant- key', `provider error: invalid x-api-key ${ANTHROPIC} rejected`],
    ['sk- key', `key ${OPENAI_SHAPE} is bad`],
    ['bearer', `Authorization: Bearer ${CLAIM}${CLAIM}`],
    ['jwt', `token was ${JWT}`],
  ]
  for (const [name, value] of shapes) {
    const out = formatScoutLog({ error: value })
    const leaked = [ANTHROPIC, OPENAI_SHAPE, JWT, `Bearer ${CLAIM}${CLAIM}`].some((s) => out.includes(s))
    t.check(`${name} shape inside a value is redacted`, !leaked && out.includes('[redacted]'), out)
  }
  const nested = formatScoutLog({ detail: JSON.stringify({ headers: { 'x-api-key': ANTHROPIC } }) })
  t.check('a key inside a JSON-encoded value is still redacted', !nested.includes(ANTHROPIC), nested)
  const plain = formatScoutLog({ error: 'the worker answered HTTP 401' })
  t.check('an ordinary sentence is not redacted', plain.includes('the worker answered HTTP 401') && !plain.includes('[redacted]'))
}

async function ambient() {
  console.log('\nambient run identity')
  const clock = RunClock.forBudget(60_000, { now: () => 1_800_000_000_000 })
  const ctx = createRunContext({ runId: 'run-77', kind: 'people', invocation: 3, clock, label: 'x' })
  const inside = await withRunContext(ctx, async () => formatScoutLog({ event: 'stage', stage: 'rank' }))
  t.check('run_id comes from the context', inside.includes('run_id="run-77"'), inside)
  t.check('scout_kind comes from the context', inside.includes('scout_kind="people"'))
  t.check('invocation comes from the context', inside.includes('invocation=3'))
  t.check('elapsed and remaining come from the clock', /elapsed_ms=0\b/.test(inside) && /remaining_ms=\d+/.test(inside), inside)
  t.check('the line starts with the [scout] tag and event first among the fields', inside.startsWith('[scout] run_id=') && inside.includes('event="stage"'))
  const override = await withRunContext(ctx, async () => formatScoutLog({ run_id: 'explicit', invocation: 9 }))
  t.check('explicit fields win over the context', override.includes('run_id="explicit"') && override.includes('invocation=9'))
  const outside = formatScoutLog({ event: 'x' })
  t.check('outside a run: no run_id, no scout_kind, no invocation, no clock', !/run_id=|scout_kind=|invocation=|elapsed_ms=|remaining_ms=/.test(outside), outside)
  const nested = await withRunContext(ctx, async () => {
    const other = createRunContext({ runId: 'run-88', kind: 'jobs', invocation: 1, clock })
    return withRunContext(other, async () => formatScoutLog({ event: 'inner' }))
  })
  t.check('a nested context shadows the outer one', nested.includes('run_id="run-88"') && nested.includes('scout_kind="jobs"'))

  console.log('\nlevels and bounds')
  const { lines } = await captureConsole(async () => {
    scoutLog({ event: 'a' }, 'log')
    scoutLog({ event: 'b' }, 'warn')
    scoutLog({ event: 'c', token: CLAIM }, 'error')
  })
  t.check('scoutLog writes exactly one line per call', lines.length === 3 && lines.every((l) => l.startsWith('[scout] ')), JSON.stringify(lines))
  t.check('scoutLog redacts on every level', !lines.some((l) => l.includes(CLAIM)))
  const long = formatScoutLog({ error: 'x'.repeat(1_000) })
  t.check('a value is cut at 300 chars', long.length < 400, String(long.length))
  const num = formatScoutLog({ latency_ms: 812.7, cost_usd: 0.004 })
  t.check('numbers are rounded, not quoted', num.includes('latency_ms=813') && num.includes('cost_usd=0'), num)
  const nul = formatScoutLog({ event: 'x', error: null, detail: undefined, stage: '' })
  t.check('null, undefined and empty are omitted', !/error=|detail=|stage=/.test(nul), nul)
}

async function main() {
  await redaction()
  await ambient()
  t.finish('log')
}

main().catch((e) => {
  console.error('log suite crashed', e)
  process.exitCode = 1
})
