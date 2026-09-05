// The deploy-configuration judgement, one rule at a time.
//
//   npm run test:deploy-config
//
// Every rule in lib/runs/deploy-config.ts is exercised with a synthetic
// environment: on Vercel and off, production and preview, both severities.
// No network, no database, no keys, no process.env.

import { judgeDeployConfig, type DeployCheck, type DeploySeverity } from '../lib/runs/deploy-config'

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

type Env = Record<string, string | undefined>

/** A production deployment with everything set: the baseline every rule perturbs. */
function goodProduction(): Env {
  return {
    VERCEL: '1',
    VERCEL_ENV: 'production',
    VERCEL_URL: 'app-abc1234-team.vercel.app',
    VERCEL_PROJECT_PRODUCTION_URL: 'app.vercel.app',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret-value',
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
    NEXT_PUBLIC_APP_URL: 'https://app.vercel.app',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
    ANTHROPIC_API_KEY: 'sk-ant-value',
    APOLLO_API_KEY: 'apollo-value',
    OPENAI_API_KEY: 'sk-openai-value',
    CRON_SECRET: 'cron-secret-value',
    GOOGLE_CLIENT_SECRET: 'google-secret-value',
    EMAIL_TOKEN_ENCRYPTION_KEY: 'email-key-value',
  }
}

function goodPreview(): Env {
  return { ...goodProduction(), VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: undefined }
}

function goodLocal(): Env {
  const e = goodProduction()
  delete e.VERCEL
  delete e.VERCEL_ENV
  delete e.VERCEL_URL
  delete e.VERCEL_PROJECT_PRODUCTION_URL
  delete e.VERCEL_AUTOMATION_BYPASS_SECRET
  e.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  return e
}

function without(env: Env, ...names: string[]): Env {
  const e = { ...env }
  for (const n of names) delete e[n]
  return e
}

function byId(checks: DeployCheck[], id: string): DeployCheck | undefined {
  return checks.find((c) => c.id === id)
}

function severityOf(checks: DeployCheck[], id: string): DeploySeverity | 'missing' {
  return byId(checks, id)?.severity ?? 'missing'
}

/** No check may print a value that belongs to a secret. */
function leaksAValue(checks: DeployCheck[], env: Env): string | null {
  const secrets = ['SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'APOLLO_API_KEY', 'OPENAI_API_KEY', 'CRON_SECRET', 'VERCEL_AUTOMATION_BYPASS_SECRET', 'GOOGLE_CLIENT_SECRET', 'EMAIL_TOKEN_ENCRYPTION_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']
  for (const c of checks) {
    const text = `${c.message} ${c.remedy ?? ''}`
    for (const s of secrets) {
      const v = env[s]
      if (v && text.includes(v)) return `${c.id} prints the value of ${s}`
    }
  }
  return null
}

function main(): void {
  console.log('baseline: a fully configured production deployment is ok')
  {
    const v = judgeDeployConfig(goodProduction())
    check('severity ok', v.severity === 'ok', v.checks.filter((c) => c.severity !== 'ok').map((c) => `${c.id}:${c.severity}`).join(', '))
    check('environment recorded', v.environment.onVercel && v.environment.vercelEnv === 'production')
    check('every check has an id and a message', v.checks.every((c) => c.id && c.message))
    check('every non-ok check has a remedy', v.checks.filter((c) => c.severity !== 'ok').every((c) => c.remedy))
    check('worker address is the bypassed deployment', byId(v.checks, 'worker-address')?.message.includes('env:VERCEL_URL+bypass') === true)
    check('no secret value printed', leaksAValue(v.checks, goodProduction()) === null, leaksAValue(v.checks, goodProduction()) ?? '')
    check('deterministic', JSON.stringify(judgeDeployConfig(goodProduction())) === JSON.stringify(v))
  }

  console.log('baseline: a fully configured preview is ok')
  {
    const v = judgeDeployConfig(goodPreview())
    check('severity ok', v.severity === 'ok', v.checks.filter((c) => c.severity !== 'ok').map((c) => `${c.id}:${c.severity}`).join(', '))
  }

  console.log('baseline: a local machine with everything set is ok')
  {
    const v = judgeDeployConfig(goodLocal())
    check('severity ok', v.severity === 'ok', v.checks.filter((c) => c.severity !== 'ok').map((c) => `${c.id}:${c.severity}`).join(', '))
    check('worker address is local', byId(v.checks, 'worker-address')?.severity === 'ok')
  }

  console.log('required keys: missing on Vercel is an error')
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']) {
    const v = judgeDeployConfig(without(goodProduction(), name))
    const c = byId(v.checks, `env:${name}`)
    check(`${name} missing → error`, c?.severity === 'error' && v.severity === 'error', c?.severity ?? 'missing check')
    check(`${name} named in the message`, c?.message.includes(name) === true)
    check(`${name} remedy names Vercel`, c?.remedy?.includes('Vercel') === true)
    const empty = judgeDeployConfig({ ...goodProduction(), [name]: '   ' })
    check(`${name} blank → error`, severityOf(empty.checks, `env:${name}`) === 'error')
    const preview = judgeDeployConfig(without(goodPreview(), name))
    check(`${name} missing on preview → error too`, severityOf(preview.checks, `env:${name}`) === 'error')
  }

  console.log('required keys: missing off Vercel is a warning, never an error')
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']) {
    const v = judgeDeployConfig(without(goodLocal(), name))
    check(`${name} missing locally → warn`, severityOf(v.checks, `env:${name}`) === 'warn' && v.severity === 'warn')
    check(`${name} remedy names .env.local`, byId(v.checks, `env:${name}`)?.remedy?.includes('.env.local') === true)
  }
  {
    const v = judgeDeployConfig({})
    check('an empty local environment never errors', v.severity !== 'error', v.checks.filter((c) => c.severity === 'error').map((c) => c.id).join(', '))
    check('an empty local environment does warn', v.severity === 'warn')
  }

  console.log('VERCEL without VERCEL_ENV: the system variables are hidden')
  {
    const v = judgeDeployConfig(without(goodProduction(), 'VERCEL_ENV'))
    const c = byId(v.checks, 'vercel-env')
    check('error', c?.severity === 'error' && v.severity === 'error')
    check('names VERCEL_ENV', c?.message.includes('VERCEL_ENV') === true)
    check('names the toggle', c?.remedy?.includes('Automatically expose System Environment Variables') === true)
    check('explains the localhost consequence', c?.message.toLowerCase().includes('localhost') === true)
    const blank = judgeDeployConfig({ ...goodProduction(), VERCEL_ENV: '' })
    check('blank VERCEL_ENV counts as unset', severityOf(blank.checks, 'vercel-env') === 'error')
    check('present VERCEL_ENV is ok', severityOf(judgeDeployConfig(goodProduction()).checks, 'vercel-env') === 'ok')
    check('off Vercel is ok', severityOf(judgeDeployConfig(goodLocal()).checks, 'vercel-env') === 'ok')
  }

  console.log('a loopback SCOUT_WORKER_BASE_URL on Vercel is an error')
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://localhost', 'http://localhost:3000/']) {
    const v = judgeDeployConfig({ ...goodProduction(), SCOUT_WORKER_BASE_URL: url })
    const c = byId(v.checks, 'worker-loopback')
    check(`${url} → error`, c?.severity === 'error' && v.severity === 'error')
    check(`${url} names the variable`, c?.message.includes('SCOUT_WORKER_BASE_URL') === true)
  }
  {
    const preview = judgeDeployConfig({ ...goodPreview(), SCOUT_WORKER_BASE_URL: 'http://localhost:3000' })
    check('loopback on preview is still an error', severityOf(preview.checks, 'worker-loopback') === 'error' && preview.severity === 'error')
    const local = judgeDeployConfig({ ...goodLocal(), SCOUT_WORKER_BASE_URL: 'http://localhost:3000' })
    check('loopback locally is not an error', local.severity !== 'error' && byId(local.checks, 'worker-loopback') === undefined)
    const real = judgeDeployConfig({ ...goodProduction(), SCOUT_WORKER_BASE_URL: 'https://app.vercel.app' })
    check('a real URL has no loopback check', byId(real.checks, 'worker-loopback') === undefined && real.severity === 'ok')
    check('a real URL is reported as pinned', byId(real.checks, 'worker-address')?.message.includes('env:SCOUT_WORKER_BASE_URL') === true)
  }

  console.log('an unresolvable worker address: error in production, warning on preview')
  {
    // Production with nothing to dispatch to: no explicit URL, no bypass, no alias, no https public URL.
    const prod = judgeDeployConfig(without(goodProduction(), 'VERCEL_AUTOMATION_BYPASS_SECRET', 'VERCEL_PROJECT_PRODUCTION_URL', 'NEXT_PUBLIC_APP_URL'))
    const pc = byId(prod.checks, 'worker-address')
    check('production → error', pc?.severity === 'error' && prod.severity === 'error', pc?.severity ?? 'missing')
    check('production message says scouting cannot start', pc?.message.includes('cannot start') === true)
    check('production remedy names the bypass', pc?.remedy?.includes('Protection Bypass for Automation') === true)

    const preview = judgeDeployConfig(without(goodPreview(), 'VERCEL_AUTOMATION_BYPASS_SECRET'))
    const vc = byId(preview.checks, 'worker-address')
    check('preview → warn, not error', vc?.severity === 'warn' && preview.severity === 'warn', vc?.severity ?? 'missing')
    check('preview says why it is not fatal', vc?.message.includes('runtime') === true)
    check('preview keeps the remedy', vc?.remedy?.includes('Protection Bypass for Automation') === true)

    const dev = judgeDeployConfig({ ...without(goodPreview(), 'VERCEL_AUTOMATION_BYPASS_SECRET'), VERCEL_ENV: 'development' })
    check('development → warn', severityOf(dev.checks, 'worker-address') === 'warn' && dev.severity === 'warn')

    // The production alias alone is enough.
    const alias = judgeDeployConfig(without(goodProduction(), 'VERCEL_AUTOMATION_BYPASS_SECRET'))
    check('production alias resolves without the bypass', severityOf(alias.checks, 'worker-address') === 'ok' && alias.severity === 'ok')
    // NEXT_PUBLIC_APP_URL as the last resort is a guess, so it warns.
    const pub = judgeDeployConfig(without(goodProduction(), 'VERCEL_AUTOMATION_BYPASS_SECRET', 'VERCEL_PROJECT_PRODUCTION_URL'))
    check('NEXT_PUBLIC_APP_URL fallback warns', severityOf(pub.checks, 'worker-address') === 'warn' && pub.severity === 'warn')
  }

  console.log('CRON_SECRET: required in production')
  {
    const prod = judgeDeployConfig(without(goodProduction(), 'CRON_SECRET'))
    const c = byId(prod.checks, 'cron-secret')
    check('production missing → error', c?.severity === 'error' && prod.severity === 'error')
    check('names CRON_SECRET and vercel.json', c?.message.includes('CRON_SECRET') === true && c?.message.includes('vercel.json') === true)
    check('remedy says where', c?.remedy?.includes('Vercel') === true)
    const preview = judgeDeployConfig(without(goodPreview(), 'CRON_SECRET'))
    check('preview missing → warn', severityOf(preview.checks, 'cron-secret') === 'warn' && preview.severity === 'warn')
    const local = judgeDeployConfig(without(goodLocal(), 'CRON_SECRET'))
    check('local missing → no check, no error', byId(local.checks, 'cron-secret') === undefined && local.severity === 'ok')
    check('present → ok', severityOf(judgeDeployConfig(goodProduction()).checks, 'cron-secret') === 'ok')
  }

  console.log('a server secret in a NEXT_PUBLIC_* variable is an error')
  {
    const pairs: Array<[string, string]> = [
      ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
      ['ANTHROPIC_API_KEY', 'NEXT_PUBLIC_ANTHROPIC_API_KEY'],
      ['APOLLO_API_KEY', 'NEXT_PUBLIC_APOLLO_KEY'],
      ['OPENAI_API_KEY', 'NEXT_PUBLIC_OPENAI_API_KEY'],
      ['CRON_SECRET', 'NEXT_PUBLIC_CRON'],
      ['VERCEL_AUTOMATION_BYPASS_SECRET', 'NEXT_PUBLIC_BYPASS'],
      ['GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_GOOGLE_CLIENT_SECRET'],
      ['EMAIL_TOKEN_ENCRYPTION_KEY', 'NEXT_PUBLIC_EMAIL_KEY'],
    ]
    for (const [secret, pub] of pairs) {
      const env = { ...goodProduction(), [pub]: goodProduction()[secret] }
      const v = judgeDeployConfig(env)
      const c = byId(v.checks, `public-leak:${pub}`)
      check(`${pub} = ${secret} → error`, c?.severity === 'error' && v.severity === 'error', c?.severity ?? 'missing check')
      check(`${pub} leak names both variables`, c?.message.includes(pub) === true && c?.message.includes(secret) === true)
      check(`${pub} leak never prints the value`, leaksAValue(v.checks, env) === null, leaksAValue(v.checks, env) ?? '')
      check(`${pub} remedy says rotate`, c?.remedy?.toLowerCase().includes('rotate') === true)
      const local = judgeDeployConfig({ ...goodLocal(), [secret]: goodProduction()[secret], [pub]: goodProduction()[secret] })
      check(`${pub} leak is an error off Vercel too`, severityOf(local.checks, `public-leak:${pub}`) === 'error' && local.severity === 'error')
    }
    const two = judgeDeployConfig({ ...goodProduction(), NEXT_PUBLIC_A: 'sk-ant-value', NEXT_PUBLIC_B: 'cron-secret-value' })
    check('two leaks → two checks', two.checks.filter((c) => c.id.startsWith('public-leak:')).length === 2)
    const empty = judgeDeployConfig({ ...goodProduction(), NEXT_PUBLIC_EMPTY: '', OPENAI_API_KEY: '' })
    check('two empty values are not a leak', empty.checks.every((c) => !c.id.startsWith('public-leak:')))
    const distinct = judgeDeployConfig(goodProduction())
    check('distinct values are ok', severityOf(distinct.checks, 'public-leak') === 'ok')
    const spaced = judgeDeployConfig({ ...goodProduction(), NEXT_PUBLIC_X: ' sk-ant-value ' })
    check('surrounding whitespace does not hide a leak', severityOf(spaced.checks, 'public-leak:NEXT_PUBLIC_X') === 'error')
  }

  console.log('optional and override variables')
  {
    const prod = judgeDeployConfig(without(goodProduction(), 'APOLLO_API_KEY'))
    check('APOLLO_API_KEY missing on Vercel → warn only', severityOf(prod.checks, 'env:APOLLO_API_KEY') === 'warn' && prod.severity === 'warn')
    const local = judgeDeployConfig(without(goodLocal(), 'APOLLO_API_KEY'))
    check('APOLLO_API_KEY missing locally → warn only', severityOf(local.checks, 'env:APOLLO_API_KEY') === 'warn' && local.severity === 'warn')
    const budget = judgeDeployConfig({ ...goodProduction(), SCOUT_INVOCATION_BUDGET_MS: '60000' })
    check('SCOUT_INVOCATION_BUDGET_MS on Vercel → warn', severityOf(budget.checks, 'budget-override') === 'warn' && budget.severity === 'warn')
    check('its message names the variable', byId(budget.checks, 'budget-override')?.message.includes('SCOUT_INVOCATION_BUDGET_MS') === true)
    const budgetLocal = judgeDeployConfig({ ...goodLocal(), SCOUT_INVOCATION_BUDGET_MS: '60000' })
    check('SCOUT_INVOCATION_BUDGET_MS locally → no check', byId(budgetLocal.checks, 'budget-override') === undefined && budgetLocal.severity === 'ok')
  }

  console.log('the worker-base verdict is included')
  {
    const hash = judgeDeployConfig({ ...without(goodProduction(), 'VERCEL_AUTOMATION_BYPASS_SECRET'), SCOUT_WORKER_BASE_URL: 'https://app-abc1234-team.vercel.app' })
    const c = byId(hash.checks, 'worker-address')
    check('a per-deployment URL without a bypass warns (checkWorkerBase)', c?.severity === 'warn' && c?.message.includes('per-deployment') === true)
    const tunnel = judgeDeployConfig({ ...goodLocal(), SCOUT_WORKER_BASE_URL: 'https://tunnel.example.dev' })
    check('a pinned tunnel locally is ok', severityOf(tunnel.checks, 'worker-address') === 'ok' && tunnel.severity === 'ok')
  }

  console.log('severity aggregation')
  {
    const both = judgeDeployConfig(without(goodProduction(), 'APOLLO_API_KEY', 'ANTHROPIC_API_KEY'))
    check('error beats warn', both.severity === 'error')
    check('every check severity is one of ok/warn/error', both.checks.every((c) => ['ok', 'warn', 'error'].includes(c.severity)))
    check('check ids are unique', new Set(both.checks.map((c) => c.id)).size === both.checks.length)
  }

  console.log('')
  console.log(`${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main()
