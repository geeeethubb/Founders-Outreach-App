// Confirms Apollo's person_locations filter actually bites, rather than being
// silently ignored. A filter that no-ops looks identical to a filter that works
// until someone reads the locations in the output.
//
//   npx tsx scripts/probe-geo-filter.ts

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const { apolloPeopleProvider } = await import('../lib/providers/apollo/people')

  const scope = { company_domains: ['dow.com'], title_patterns: ['Plant Manager'], per_page: 25 }

  const noGeo = await apolloPeopleProvider.searchStubs(scope)
  const geo = await apolloPeopleProvider.searchStubs({ ...scope, locations: ['United States'] })

  console.log(`unfiltered : ${noGeo.items.length} rows, total_available=${noGeo.total_available} ${noGeo.error ?? ''}`)
  console.log(`US-scoped  : ${geo.items.length} rows, total_available=${geo.total_available} ${geo.error ?? ''}`)

  const changed = noGeo.total_available !== geo.total_available
  console.log(
    changed
      ? `\nFILTER IS ACTIVE — the result set changed (${noGeo.total_available} -> ${geo.total_available}).`
      : '\nWARNING: identical totals. The location filter may be a no-op for this query.'
  )
}

main().catch((e) => {
  console.error('probe failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
