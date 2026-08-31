// LIVE probe of the job source adapters. Network only — no model, no keys.
//
// Lists real public boards on each ATS, counts internships, prints sample
// normalized postings and latency; then runs ATS detection from name+domain
// and a careers-page scan. A board that has vanished is reported, not thrown:
// that is a finding about the surface.
//   npx tsx scripts/probe-career-sources.ts            (cached listings)
//   CAREER_SOURCE_CACHE_BYPASS=1 npx tsx scripts/probe-career-sources.ts

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { getSourceRegistry } from '../lib/career/sources/registry'
import { detectAtsForCompany } from '../lib/career/sources/detect'
import { scanCareersPage } from '../lib/career/sources/careers'
import { createPageFetcher, slugCandidates } from '../lib/career/sources/fetch'
import { WORKDAY_PODS, preferredWorkdaySite, workdaySites } from '../lib/career/sources/workday'
import { cacheStats } from '../lib/providers/cache'
import type { AtsBoardRef } from '../lib/career/sources/types'

// Boards confirmed live in Aug 2026. Adjust when one moves ATS — the probe will say so.
const BOARDS: AtsBoardRef[] = [
  { ats: 'greenhouse', identifier: 'andurilindustries', company_name: 'Anduril Industries' },
  { ats: 'greenhouse', identifier: 'stripe', company_name: 'Stripe' },
  { ats: 'lever', identifier: 'palantir', company_name: 'Palantir' },
  { ats: 'ashby', identifier: 'ramp', company_name: 'Ramp' },
  { ats: 'smartrecruiters', identifier: 'BoschGroup', company_name: 'Bosch Group' },
  { ats: 'workable', identifier: 'blueground', company_name: 'Blueground' },
  // Workday: the founder's own watchlist companies that used to yield zero.
  { ats: 'workday', identifier: 'intel/wd1/External', company_name: 'Intel Corporation' },
  { ats: 'workday', identifier: 'micron/wd1/External', company_name: 'Micron Technology' },
  { ats: 'workday', identifier: 'amat/wd1/External', company_name: 'Applied Materials' },
  { ats: 'workday', identifier: 'amgen/wd1/Careers', company_name: 'Amgen' },
  { ats: 'workday', identifier: '3m/wd1/Search', company_name: '3M Company' },
  { ats: 'workday', identifier: 'globalfoundries/wd1/External', company_name: 'GlobalFoundries' },
  { ats: 'workday', identifier: 'illumina/wd1/illumina-careers', company_name: 'Illumina' },
  { ats: 'workday', identifier: 'chevron/wd5/University', company_name: 'Chevron' },
  { ats: 'workday', identifier: 'argonne/wd1/Argonne_Careers', company_name: 'Argonne National Laboratory' },
  // A board that does not exist — exercises the not-found path.
  { ats: 'greenhouse', identifier: 'anduril', company_name: 'Anduril (wrong slug)' },
  // Wrong site on a real tenant (404) and a tenant that does not exist (422).
  { ats: 'workday', identifier: 'micron/wd1/NoSuchSite', company_name: 'Micron (wrong site)' },
  { ats: 'workday', identifier: 'zzznotarealtenant/wd1/External', company_name: 'Nobody (wrong tenant)' },
]

const DETECT = [
  { companyName: 'Anduril Industries', domain: 'anduril.com' },
  { companyName: 'Ramp', domain: 'ramp.com' },
  { companyName: 'Figma', domain: 'figma.com' },
]

const SCAN = [
  { companyName: 'Anduril Industries', domain: 'anduril.com' },
  { companyName: 'Stripe', domain: 'stripe.com', careersUrl: 'https://stripe.com/jobs' },
]

const bypass = process.env.CAREER_SOURCE_CACHE_BYPASS === '1'

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - t0 }
}

// ─── Watchlist coverage ──────────────────────────────────────────────────────
//
//   npx tsx scripts/probe-career-sources.ts --watchlist
//
// Read-only. Answers the one number that matters for discovery supply: how many
// watchlist companies resolve to a board something can actually LIST. It reuses
// the same robots.txt read the adapter uses, so a hit here is a hit in product.

const WATCHLIST_CONCURRENCY = 4

async function resolveWorkdayByName(name: string, domain: string | null): Promise<AtsBoardRef | null> {
  // Two slugs, two pods — a measurement sweep, not the product path. Detection
  // proper (detect.ts) only probes once a careers page has named Workday.
  const slugs = slugCandidates(name, domain).slice(0, 2)
  for (const slug of slugs) {
    for (const pod of WORKDAY_PODS.slice(0, 2)) {
      const sites = await workdaySites(slug, pod)
      const site = preferredWorkdaySite(sites)
      if (site) return { ats: 'workday', identifier: `${slug}/${pod}/${site}`, company_name: name }
    }
  }
  return null
}

async function watchlistCoverage(): Promise<void> {
  const { createServiceClient } = await import('../lib/supabase/server')
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, domain, careers_url, ats_type, ats_identifier, watch_status')
    .not('watch_status', 'is', null)
    .limit(1000)
  if (error) {
    console.log(`watchlist read failed: ${error.message}`)
    return
  }
  const rows = data ?? []
  const registry = getSourceRegistry()
  const already = rows.filter((c) => c.ats_type && c.ats_type !== 'other' && registry.byId(c.ats_type))
  const fromUrl: typeof rows = []
  const candidates: typeof rows = []
  for (const c of rows) {
    if (already.includes(c)) continue
    const m = c.careers_url ? registry.matchUrl(c.careers_url) : null
    if (m) fromUrl.push(c)
    else candidates.push(c)
  }

  console.log(`\n=== watchlist coverage (${rows.length} companies) ===`)
  console.log(`  already stored on a listable ATS: ${already.length}`)
  console.log(`  stored careers_url is a listable board: ${fromUrl.length}`)
  console.log(`  probing ${candidates.length} unresolved for a Workday tenant…`)

  const found: { name: string; identifier: string }[] = []
  let done = 0
  const queue = [...candidates]
  await Promise.all(
    Array.from({ length: WATCHLIST_CONCURRENCY }, async () => {
      for (;;) {
        const c = queue.shift()
        if (!c) return
        try {
          const board = await resolveWorkdayByName(c.name, c.domain)
          if (board) found.push({ name: c.name, identifier: board.identifier })
        } catch {
          // A probe failure is a miss, not a crash.
        }
        if (++done % 25 === 0) console.log(`    …${done}/${candidates.length} probed, ${found.length} tenants found`)
      }
    })
  )

  const listable = already.length + fromUrl.length + found.length
  console.log(`\n  NEW Workday tenants resolved: ${found.length}`)
  for (const f of found.sort((a, b) => a.name.localeCompare(b.name))) console.log(`    • ${f.name} → ${f.identifier}`)
  console.log(`\n  LISTABLE BOARDS: ${listable} of ${rows.length} (was ${already.length + fromUrl.length})`)
}

async function main() {
  if (process.argv.includes('--watchlist')) {
    await watchlistCoverage()
    return
  }
  const registry = getSourceRegistry()
  const summary: Record<string, unknown>[] = []

  console.log(`\n=== listPostings (${bypass ? 'cache bypassed' : 'cached when available'}) ===`)
  for (const board of BOARDS) {
    const adapter = registry.byId(board.ats)
    if (!adapter) {
      console.log(`${board.ats}/${board.identifier}: adapter unavailable`)
      continue
    }
    const { value: all, ms } = await timed(() => adapter.listPostings(board))
    const { value: interns } = await timed(() => adapter.listPostings(board, { internshipsOnly: true }))
    const line = { board: `${board.ats}/${board.identifier}`, total: all.total_on_board, listed: all.postings.length, internships: interns.postings.length, ms, error: all.error ?? null, note: all.note ?? null }
    summary.push(line)
    console.log(JSON.stringify(line))
    for (const p of interns.postings.slice(0, 3)) {
      console.log(`   • ${p.title} | ${p.location_raw} | hint=${p.employment_type_hint} | ${p.canonical_url}`)
      console.log(`     text: ${(p.description_text ?? '(none)').slice(0, 140).replace(/\s+/g, ' ')}`)
    }
    // Verification primitive: re-fetch the first posting by id.
    const first = all.postings[0]
    if (first?.ats_job_id) {
      const { value: one, ms: fetchMs } = await timed(() => adapter.fetchPosting(board, first.ats_job_id!))
      console.log(`   fetchPosting(${first.ats_job_id}) → ${one.status} in ${fetchMs}ms — ${one.note}${one.posting?.description_text ? ` (${one.posting.description_text.length} chars)` : ''}`)
      const { value: gone } = await timed(() => adapter.fetchPosting(board, '00000000-0000-0000-0000-000000000000'))
      console.log(`   fetchPosting(bogus) → ${gone.status} — ${gone.note}`)
    }
  }

  console.log('\n=== detectAtsForCompany (name + domain only) ===')
  for (const input of DETECT) {
    const { value, ms } = await timed(() => detectAtsForCompany(input, { bypassCache: bypass }))
    console.log(`${input.companyName}: ${value.method} → ${value.board ? `${value.board.ats}/${value.board.identifier}` : 'none'} (${ms}ms)`)
    for (const a of value.attempts) console.log(`   - ${a}`)
  }

  console.log('\n=== scanCareersPage ===')
  const fetcher = createPageFetcher({ bypassCache: bypass })
  for (const input of SCAN) {
    const { value, ms } = await timed(() => scanCareersPage(input, fetcher))
    console.log(`${input.companyName}: ${value.careers_url ?? 'no page'} (${ms}ms)${value.error ? ` error=${value.error}` : ''}`)
    console.log(`   boards: ${value.boards.map((b) => `${b.ats}/${b.identifier}`).join(', ') || 'none'}`)
    console.log(`   posting links: ${value.posting_links.length}; hints: ${value.hints.slice(0, 5).join(' | ') || 'none'}`)
    if (value.fetched) console.log(`   page: status ${value.fetched.status}, ${value.fetched.text.length} chars, ${value.fetched.links.length} links, robots_blocked=${value.fetched.robots_blocked}`)
  }

  console.log('\n=== excluded platform ===')
  const li = await fetcher.fetch('https://www.linkedin.com/jobs/view/1')
  console.log(`linkedin → robots_blocked=${li.robots_blocked} error=${li.error}`)

  console.log(`\ncache: ${JSON.stringify(cacheStats())}`)
  console.log('\nsummary:')
  console.table(summary)
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(1)
})
