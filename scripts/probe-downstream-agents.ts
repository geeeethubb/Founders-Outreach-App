// Validates the two agents that sit downstream of Apollo enrichment —
// Person Research and Ranking — using people ALREADY purchased in Phase 6.
//
// Why this exists: the Apollo account currently has no lead credits, so a full
// smoke run cannot reach these stages. Rather than leave them untested until the
// balance is topped up, this exercises them against 1,373 cached enriched
// records. Zero Apollo credits are spent.
//
//   npx tsx scripts/probe-downstream-agents.ts [count]

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'

const CACHE_DIR = path.join(process.cwd(), '.provider-cache', 'person_enriched')

interface CachedEntry {
  value?: Record<string, unknown>
  [k: string]: unknown
}

/** Pull enriched Apollo records straight off disk — no provider call at all. */
function loadCachedPeople(limit: number): Record<string, unknown>[] {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'))
  const out: Record<string, unknown>[] = []

  for (const f of files) {
    if (out.length >= limit) break
    let parsed: CachedEntry
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'))
    } catch {
      continue
    }
    const person = (parsed.value ?? parsed) as Record<string, unknown>
    const org = person.organization as Record<string, unknown> | undefined

    // Only records complete enough to be a fair test of the agents.
    if (!person.name || !person.title || !org?.name) continue
    out.push(person)
  }
  return out
}

async function main() {
  const count = Number(process.argv[2] ?? 2)
  const { runPersonResearch, renderPersonResearch } = await import('../lib/agents/person-research')
  const { runRanking } = await import('../lib/agents/ranking')
  const { anthropicUsage, resetAnthropicUsage, setAnthropicBudget } = await import(
    '../lib/providers/anthropic/client'
  )
  const { apolloStats } = await import('../lib/providers/apollo/client')

  setAnthropicBudget(30)
  resetAnthropicUsage()

  const people = loadCachedPeople(count)
  if (people.length === 0) {
    console.error('FAILED: no usable enriched people in the cache')
    process.exit(1)
  }

  const backgroundItems = RESUME_ITEMS.filter((i) => i.credibility === 'strong')
    .slice(0, 8)
    .map((i) => ({ id: i.id, summary: `${i.title} — ${i.org}: ${i.summary}` }))
  const validIds = new Set(backgroundItems.map((b) => b.id))

  const ctx = {
    user_id: 'probe',
    run_id: null,
    budget: {
      maxCompanies: 1,
      maxPeoplePerCompany: 1,
      maxApolloCalls: 0,
      maxWebSearches: 3,
      maxAgentSteps: 5,
    },
  }

  console.log(`\nProbing Person Research + Ranking on ${people.length} cached people (0 Apollo credits)\n`)

  let researchOk = 0
  let rankOk = 0
  let sourcedFacts = 0
  let totalFacts = 0
  let downgraded = 0
  let ungrounded = 0
  const totals: number[] = []

  for (const raw of people) {
    const org = raw.organization as Record<string, unknown>
    const name = String(raw.name)
    const title = raw.title ? String(raw.title) : null
    const companyName = String(org.name)

    const companyContext = [
      `WHAT THEY DO: ${org.short_description ?? org.industry ?? 'unknown'}`,
      org.industry ? `INDUSTRY: ${org.industry}` : '',
      org.estimated_num_employees ? `HEADCOUNT: ${org.estimated_num_employees}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    console.log(`── ${name} — ${title ?? '?'} @ ${companyName}`)

    const research = await runPersonResearch(
      {
        person: {
          name,
          title,
          company_name: companyName,
          linkedin_url: raw.linkedin_url ? String(raw.linkedin_url) : null,
          location: raw.city ? String(raw.city) : null,
        },
        companyContext,
        mission: {
          goal:
            'Find a high-value winter 2026-27 internship or technical project at the intersection of ' +
            'industrial AI, manufacturing, and chemical/process engineering.',
        },
        backgroundSummary: backgroundItems.map((b) => `  [${b.id}] ${b.summary}`).join('\n'),
      },
      ctx
    )

    if (!research.output) {
      console.log(`   research FAILED: ${research.error}`)
      continue
    }
    researchOk++

    const facts = research.output.claims.filter((c) => c.type === 'FACT')
    totalFacts += facts.length
    sourcedFacts += facts.filter((f) => f.source_url).length
    downgraded += research.output.downgraded_claims

    console.log(
      `   research OK — ${research.output.claims.length} claims (${facts.length} FACT, all sourced: ` +
        `${facts.every((f) => f.source_url)}), ${research.evidence.length} cited URLs, ` +
        `${research.trace.web_searches} searches, thin=${research.output.thin_public_record}`
    )
    if (research.output.downgraded_claims > 0) {
      console.log(`   ${research.output.downgraded_claims} FACT(s) downgraded — cited a URL never retrieved`)
    }

    const ranked = await runRanking(
      {
        candidate: {
          key: name,
          name,
          title,
          company_name: companyName,
          location: raw.city ? String(raw.city) : null,
          email_status: raw.email ? 'verified' : 'unavailable',
        },
        companyContext,
        personContext: renderPersonResearch(research.output),
        mission: {
          goal: 'Winter 2026-27 internship in industrial AI / manufacturing / process engineering.',
          timeframe: 'Winter 2026-27',
        },
        positioningAngle:
          'Hands-on manufacturing floor experience combined with shipped AI agent work at industrial scale.',
        backgroundItems,
      },
      ctx
    )

    if (!ranked.output) {
      console.log(`   ranking FAILED: ${ranked.error}`)
      continue
    }
    rankOk++
    totals.push(ranked.output.total)
    ungrounded += ranked.output.ungrounded_ids.length

    // Independently re-derive the total. The model must not have controlled it.
    const recomputed = Math.round(
      ranked.output.components.reduce((s, c) => s + c.normalized * c.max, 0)
    )
    const arithmeticOk = recomputed === ranked.output.total
    const citedAllValid = ranked.output.resume_item_ids.every((id) => validIds.has(id))

    console.log(
      `   ranking OK — total ${ranked.output.total} (${ranked.output.recommendation}), ` +
        `arithmetic verified: ${arithmeticOk}, cited ids valid: ${citedAllValid}`
    )
    console.log(
      `      components: ${ranked.output.components.map((c) => `${c.dimension}=${c.normalized.toFixed(2)}`).join(' ')}`
    )
    console.log(`      hook: ${ranked.output.why_i_fit_them.slice(0, 120)}`)
  }

  const usage = anthropicUsage()
  const spread = totals.length > 1 ? Math.max(...totals) - Math.min(...totals) : 0

  console.log('\n' + '─'.repeat(70))
  console.log(`person research succeeded : ${researchOk}/${people.length}`)
  console.log(`ranking succeeded         : ${rankOk}/${people.length}`)
  console.log(`FACT sourcing             : ${sourcedFacts}/${totalFacts} carry a source URL`)
  console.log(`FACTs downgraded          : ${downgraded} (cited a URL never retrieved)`)
  console.log(`ungrounded resume ids     : ${ungrounded}`)
  console.log(`score spread              : ${spread} points across ${totals.length} prospects`)
  console.log(`Apollo credits spent      : ${apolloStats().enrichmentCredits}`)
  console.log(`Anthropic                 : ${usage.calls} calls, $${usage.costUsd.toFixed(4)}`)
  console.log('─'.repeat(70))

  const ok =
    researchOk === people.length &&
    rankOk === people.length &&
    sourcedFacts === totalFacts &&
    apolloStats().enrichmentCredits === 0
  console.log(ok ? 'DOWNSTREAM AGENTS VALIDATED' : 'DOWNSTREAM VALIDATION INCOMPLETE')
  if (!ok) process.exitCode = 1
}

main().catch((e) => {
  console.error('probe crashed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
