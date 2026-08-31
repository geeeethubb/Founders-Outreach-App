// What discovery has actually produced, read-only.
//
// Written because "how many jobs do I have?" was being answered by opening the
// Jobs page and scrolling, which counts what the page chose to show rather than
// what the database holds. This prints the inventory, where it came from, and
// how fresh it is. It reads; it never writes, never calls a model, and never
// spends.
//
//   npx tsx scripts/career-discovery-stats.ts [--user <id>]

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createServiceClient } from '../lib/supabase/server'
import { defaultProfiles } from './lib/cli-user'

type Row = Record<string, unknown>

/** `--user <id>`, else the same resolution every other CLI uses. */
function opt(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

function tally(rows: Row[], key: string): [string, number][] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const v = r[key]
    const k = v === null || v === undefined || v === '' ? '(none)' : String(v)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function bar(n: number, max: number, width = 28): string {
  return '#'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / Math.max(1, max)) * width)))
}

function section(title: string, pairs: [string, number][], limit = 12): void {
  console.log(`\n${title}`)
  if (pairs.length === 0) {
    console.log('  (nothing)')
    return
  }
  const max = pairs[0][1]
  for (const [k, n] of pairs.slice(0, limit)) {
    console.log(`  ${k.slice(0, 34).padEnd(34)} ${String(n).padStart(5)}  ${bar(n, max)}`)
  }
  if (pairs.length > limit) console.log(`  … and ${pairs.length - limit} more`)
}

async function main(): Promise<void> {
  let userId = opt('user')
  if (!userId) {
    const { data: profiles } = await defaultProfiles()
    if (!profiles?.length) {
      console.error('no profiles row exists')
      process.exitCode = 1
      return
    }
    userId = profiles[0].id
  }
  const sb = createServiceClient()

  const { data: jobs, error } = await sb
    .from('job_opportunities')
    .select('id, company_name, title, ats_type, verification_status, employment_type, disposition, fit_overall, created_at, last_verified_at, posted_at, first_seen_at')
    .eq('user_id', userId)
    .limit(5000)
  if (error) {
    console.error(`could not read jobs: ${error.message}`)
    process.exitCode = 1
    return
  }
  const rows = (jobs ?? []) as Row[]

  console.log(`\nDISCOVERY INVENTORY — ${rows.length} job(s) for ${userId}`)
  console.log(`read at ${new Date().toISOString()}`)

  const open = rows.filter((r) => r.verification_status === 'VERIFIED_OPEN' || r.verification_status === 'LIKELY_OPEN')
  const companies = new Set(rows.map((r) => String(r.company_name ?? '').toLowerCase()).filter(Boolean))
  const openCompanies = new Set(open.map((r) => String(r.company_name ?? '').toLowerCase()).filter(Boolean))
  console.log(`\n  total ${rows.length}   ·   open (verified or likely) ${open.length}   ·   companies ${companies.size} (${openCompanies.size} with an open posting)`)

  // source_type lives on job_sources, one row per surface a job was seen on —
  // which is the point of the table: a job found twice keeps both provenances.
  const ids = rows.map((r) => String(r.id))
  const sources: Row[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('job_sources').select('job_id, source_type').in('job_id', ids.slice(i, i + 200))
    sources.push(...((data ?? []) as Row[]))
  }

  section('by verification status', tally(rows, 'verification_status'))
  section('by source surface (job_sources rows)', tally(sources, 'source_type'))
  section('by ATS', tally(rows, 'ats_type'))
  section('by disposition', tally(rows, 'disposition'))
  section('top companies', tally(rows, 'company_name'), 10)

  // Concentration is the number the audit cared about: one employer filling the
  // list looks like volume and is not.
  const byCompany = tally(rows, 'company_name')
  if (byCompany.length) {
    const [topName, topCount] = byCompany[0]
    console.log(`\n  largest single company: ${topName} ${topCount}/${rows.length} (${Math.round((topCount / rows.length) * 100)}%)`)
  }

  const DAY = 86_400_000
  const now = Date.now()
  const age = (v: unknown): number | null => {
    const t = Date.parse(String(v ?? ''))
    return Number.isFinite(t) ? (now - t) / DAY : null
  }
  const seen = rows.map((r) => age(r.created_at)).filter((n): n is number => n !== null)
  const verified = rows.map((r) => age(r.last_verified_at)).filter((n): n is number => n !== null)
  console.log('\nfreshness')
  console.log(`  added in the last 24 h   ${seen.filter((d) => d <= 1).length}`)
  console.log(`  added in the last 7 d    ${seen.filter((d) => d <= 7).length}`)
  console.log(`  never verified           ${rows.length - verified.length}`)
  console.log(`  verified in the last 7 d ${verified.filter((d) => d <= 7).length}`)

  const { data: runs } = await sb
    .from('scouting_runs')
    .select('id, kind, status, label, started_at, completed_at, stats')
    .eq('user_id', userId)
    .eq('kind', 'job_scout')
    .order('started_at', { ascending: false })
    .limit(5)
  console.log('\nrecent scout runs')
  for (const r of (runs ?? []) as Row[]) {
    const started = String(r.started_at ?? '').slice(0, 16).replace('T', ' ')
    console.log(`  ${started}  ${String(r.status).padEnd(9)} ${String(r.label ?? '').slice(0, 46)}`)
  }
  if (!runs?.length) console.log('  (none)')
  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
