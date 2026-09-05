// The route segment config that keeps a worker alive, asserted from source.
//
//   npm run test:route-config
//
// Next reads `maxDuration` and `dynamic` from the ROUTE FILE, literally — not
// from a shared module, not from a computed expression. A worker route with
// the default function ceiling dies mid-claim, and a scout route that is
// statically rendered answers a stale page. Nothing at runtime tells you which
// of those happened, so this reads the files and refuses to let the literals
// drift. It also pins the invocation budget to the ceiling it was derived
// from: 300 s minus a 20 s margin.
//
// No network, no database, no imports of the routes (which would pull Next).

import fs from 'fs'
import path from 'path'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL ${name} — ${detail}`)
  }
}

const root = process.cwd()
function read(rel: string): string | null {
  const full = path.join(root, rel)
  try {
    return fs.readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

/** A top-level `export const NAME = <literal>` line, with the literal it carries. */
function exportedLiteral(source: string, name: string): string | null {
  const re = new RegExp(`^export const ${name}\\s*=\\s*([^\\n;]+?)\\s*;?\\s*$`, 'm')
  const m = re.exec(source)
  return m ? m[1].trim() : null
}

const WORKER_MAX_DURATION_S = 300
const BUDGET_MARGIN_MS = 20_000

const WORKER_ROUTES = ['app/api/scout/worker/route.ts', 'app/api/career/scout/worker/route.ts']
const ENQUEUE_ROUTES = ['app/api/scout/route.ts', 'app/api/career/scout/route.ts']

function main(): void {
  console.log('worker routes: maxDuration = 300 and dynamic = force-dynamic, literally')
  for (const rel of WORKER_ROUTES) {
    const src = read(rel)
    check(`${rel} exists`, src !== null)
    if (src === null) continue
    const max = exportedLiteral(src, 'maxDuration')
    check(`${rel} exports maxDuration = ${WORKER_MAX_DURATION_S}`, max === String(WORKER_MAX_DURATION_S), max === null ? 'no literal export' : `found ${max}`)
    const dyn = exportedLiteral(src, 'dynamic')
    check(`${rel} exports dynamic = 'force-dynamic'`, dyn === `'force-dynamic'` || dyn === `"force-dynamic"`, dyn === null ? 'no literal export' : `found ${dyn}`)
    check(`${rel} exports POST`, /^export (async )?function POST\b/m.test(src))
    check(`${rel} exports GET (health)`, /^export (async )?function GET\b/m.test(src))
  }

  console.log('enqueue routes: dynamic = force-dynamic')
  for (const rel of ENQUEUE_ROUTES) {
    const src = read(rel)
    check(`${rel} exists`, src !== null)
    if (src === null) continue
    const dyn = exportedLiteral(src, 'dynamic')
    check(`${rel} exports dynamic = 'force-dynamic'`, dyn === `'force-dynamic'` || dyn === `"force-dynamic"`, dyn === null ? 'no literal export' : `found ${dyn}`)
    const max = exportedLiteral(src, 'maxDuration')
    const maxN = max === null ? null : Number(max.replace(/_/g, ''))
    check(`${rel} maxDuration (if any) is within the worker ceiling`, maxN === null || (Number.isFinite(maxN) && maxN <= WORKER_MAX_DURATION_S), max ?? '(none)')
  }

  console.log('the invocation budget is derived from the ceiling')
  {
    const rel = 'lib/runs/deadline.ts'
    const src = read(rel)
    check(`${rel} exists`, src !== null)
    if (src !== null) {
      const raw = exportedLiteral(src, 'VERCEL_INVOCATION_BUDGET_MS')
      check(`${rel} exports VERCEL_INVOCATION_BUDGET_MS = 280_000`, raw === '280_000', raw ?? 'no literal export')
      const n = raw === null ? NaN : Number(raw.replace(/_/g, ''))
      check('budget = maxDuration × 1000 − 20 s', n === WORKER_MAX_DURATION_S * 1000 - BUDGET_MARGIN_MS, `${n} vs ${WORKER_MAX_DURATION_S * 1000 - BUDGET_MARGIN_MS}`)
    }
  }

  console.log('vercel.json does not override the worker functions')
  {
    const src = read('vercel.json')
    check('vercel.json exists', src !== null)
    if (src !== null) {
      let parsed: { functions?: Record<string, { maxDuration?: number }>; crons?: Array<{ path: string; schedule: string }> } | null = null
      try {
        parsed = JSON.parse(src)
      } catch (e) {
        parsed = null
        check('vercel.json parses', false, e instanceof Error ? e.message : String(e))
      }
      if (parsed) {
        const fns = parsed.functions ?? {}
        const conflicting = Object.entries(fns).filter(([pattern, cfg]) => /scout/.test(pattern) && typeof cfg.maxDuration === 'number' && cfg.maxDuration < WORKER_MAX_DURATION_S)
        check('no functions entry lowers a scout route below the ceiling', conflicting.length === 0, conflicting.map(([p, c]) => `${p}: ${c.maxDuration}`).join(', '))
        const crons = parsed.crons ?? []
        check('the watchdog crons are declared', crons.some((c) => c.path === '/api/career/cron/sweep') && crons.some((c) => c.path === '/api/career/cron/verify'), crons.map((c) => c.path).join(', '))
      }
    }
  }

  console.log('')
  console.log(`${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main()
