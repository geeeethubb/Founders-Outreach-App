// Ad-hoc grounded-research probe. Useful for sanity-checking the research agent
// against companies whose correct verdict you already know.
//
//   npm run probe:research -- "Fero Labs" "GGA Partners"

import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const names = process.argv.slice(2)
  if (names.length === 0) {
    process.stderr.write('usage: npm run probe:research -- "Company A" "Company B"\n')
    process.exit(1)
  }

  const { researchCompany } = await import('../lib/research/company')
  const blank = (name: string) => ({
    name, domain: null, description: null, industry: null, sub_industries: [] as string[],
    employee_count: null, employee_range: null, stage: null, founded_year: null,
    hq_location: null, country: null, website_url: null, linkedin_url: null,
    raw: {} as Record<string, unknown>,
    provenance: { provider_id: 'apollo', retrieved_at: new Date().toISOString() },
  })

  for (const name of names) {
    const { dossier } = await researchCompany(blank(name))
    const facts = dossier.claims.filter((c) => c.type === 'FACT')
    const domains = Object.entries(dossier.domain_evidence).filter(([, v]) => v).map(([k]) => k)

    process.stdout.write(`\n=== ${name} ===\n`)
    process.stdout.write(`  mission_relevant: ${dossier.mission_relevant}\n`)
    process.stdout.write(`  reasoning: ${dossier.relevance_reasoning.slice(0, 200)}\n`)
    process.stdout.write(`  what they do: ${dossier.what_they_do.slice(0, 200)}\n`)
    process.stdout.write(`  domain evidence: ${domains.join(', ') || 'NONE'}\n`)
    process.stdout.write(`  claims: ${dossier.claims.length} (${facts.length} FACT, ${facts.filter((f) => f.source_url).length} sourced)\n`)
    if (facts[0]?.source_url) process.stdout.write(`  sample source: ${facts[0].source_url}\n`)
    if (dossier.research_failed) process.stdout.write(`  RESEARCH FAILED\n`)
  }
}

main().catch((e) => {
  process.stderr.write(`probe failed: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
