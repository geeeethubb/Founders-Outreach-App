// Diagnoses why People Scout found no stubs for the last run's companies.
//   npx tsx scripts/debug-apollo-scout.ts

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const { apolloPeopleProvider } = await import('../lib/providers/apollo/people')
  const { buildPeopleSearchBody } = await import('../lib/providers/apollo/people')

  const s = createServiceClient()
  const { data: run } = await s
    .from('scouting_runs')
    .select('id, label, strategy')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const strategy = (run as { strategy?: { segments?: { name: string; title_patterns: string[] }[] } })?.strategy
  const seg = strategy?.segments?.[0]
  console.log('SEGMENT :', seg?.name)
  console.log('TITLES  :', JSON.stringify(seg?.title_patterns))

  const { data: cos } = await s
    .from('companies')
    .select('name, domain')
    .order('created_at', { ascending: false })
    .limit(3)
  console.log('COMPANIES:', JSON.stringify(cos))

  const titles = seg?.title_patterns ?? []

  for (const c of (cos ?? []) as { name: string; domain: string | null }[]) {
    console.log(`\n── ${c.name} (${c.domain ?? 'no domain'})`)

    // A: domain + strategist titles (what the pipeline actually does)
    const bodyA = buildPeopleSearchBody({
      ...(c.domain ? { company_domains: [c.domain] } : { company_names: [c.name] }),
      title_patterns: titles,
      per_page: 10,
    })
    console.log('  query A body:', JSON.stringify(bodyA))
    const a = await apolloPeopleProvider.searchStubs({
      ...(c.domain ? { company_domains: [c.domain] } : { company_names: [c.name] }),
      title_patterns: titles,
      per_page: 10,
    })
    console.log(`  A domain+titles : ${a.items.length} stubs, total=${a.total_available ?? '?'} ${a.error ?? ''}`)

    // B: domain only — is the company itself findable in Apollo?
    const b = await apolloPeopleProvider.searchStubs({
      ...(c.domain ? { company_domains: [c.domain] } : { company_names: [c.name] }),
      per_page: 10,
    })
    console.log(`  B domain only   : ${b.items.length} stubs, total=${b.total_available ?? '?'} ${b.error ?? ''}`)
    for (const p of b.items.slice(0, 6)) console.log(`      - ${p.title}`)

    // C: name instead of domain
    const cRes = await apolloPeopleProvider.searchStubs({ company_names: [c.name], per_page: 10 })
    console.log(`  C name only     : ${cRes.items.length} stubs, total=${cRes.total_available ?? '?'} ${cRes.error ?? ''}`)
    for (const p of cRes.items.slice(0, 4)) console.log(`      - ${p.title} @ ${p.company_name}`)
  }
}

main().catch((e) => {
  console.error('failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
