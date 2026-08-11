// Probes the Anthropic web-research provider end to end: does the server-side
// web_search tool run, and do we get real citations back?
//
//   npx tsx scripts/probe-anthropic-web.ts

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const { anthropicWebResearchProvider, anthropicWebStats } = await import(
    '../lib/providers/anthropic/web-research'
  )
  const { anthropicUsage } = await import('../lib/providers/anthropic/client')

  const r = await anthropicWebResearchProvider.researchRaw({
    query: 'What does Sunburst Chemicals manufacture, and where is it headquartered?',
    max_results: 4,
  })

  console.log('error      :', r.error ?? 'none')
  console.log('searches   :', r.searches)
  console.log('text length:', r.text.length)
  console.log('citations  :', r.citations.length)
  for (const c of r.citations.slice(0, 5)) console.log('   -', c.url)
  console.log('\nsearch stats:', JSON.stringify(anthropicWebStats()))
  console.log('model usage :', JSON.stringify(anthropicUsage()))

  if (r.error) process.exitCode = 1
}

main().catch((e) => {
  console.error('probe failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
