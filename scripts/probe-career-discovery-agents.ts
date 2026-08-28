// LIVE probe for the Career OS discovery agents. Costs money; env-gated.
//
//   npx tsx scripts/probe-career-discovery-agents.ts            # all three
//   npx tsx scripts/probe-career-discovery-agents.ts --only planner|scout|extractor
//   npx tsx scripts/probe-career-discovery-agents.ts --no-cache  # force live calls
//
// Requires ANTHROPIC_API_KEY in .env.local. Every call carries cacheKeyParts, so
// a second run is free — which is the point: iterate on the envelope without
// re-paying for the judgment.
//
// The tools handed to the scout here are deliberately naive: fetch_page is
// global fetch plus tag stripping, lookup_ats_board always says "no board".
// W2 owns the real adapters. This measures the agent, not the adapters.

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'
import type { ToolContext } from '../lib/agents/runtime/types'
import type { FetchPageFn, LookupBoardFn } from '../lib/agents/job-scout'
import type { SearchStrategy } from '../lib/agents/job-mission-planner'

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? process.argv[i + 1] : null
})()
const noCache = process.argv.includes('--no-cache')

const ctx: ToolContext = {
  user_id: 'probe',
  run_id: null,
  budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 4, maxAgentSteps: 7 },
}

function decodeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|br|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

const fetchPage: FetchPageFn = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'outreach-os-probe/1.0' }, redirect: 'follow' })
  const html = await res.text()
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null
  const links: string[] = []
  const re = /href="(https?:\/\/[^"#]+)"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && links.length < 60) links.push(m[1])
  return { ok: res.ok, status: res.status, title, text: decodeHtml(html), links, note: res.ok ? '' : `HTTP ${res.status}` }
}

const lookupBoard: LookupBoardFn = async () => ({
  found: false, ats: null, board_url: null, postings: [], total_on_board: 0,
  note: 'probe stub — real ATS adapters are not wired into this probe',
})

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — this probe makes live model calls. Aborting.')
    process.exit(2)
  }
  const { setAnthropicBudget, anthropicUsage } = await import('../lib/providers/anthropic/client')
  const { defaultMission, renderMission } = await import('../lib/career/missions/store')
  const { runJobMissionPlanner } = await import('../lib/agents/job-mission-planner')
  const { runJobScoutSession } = await import('../lib/agents/job-scout/session')
  const { runJobExtractor } = await import('../lib/agents/job-extractor')
  setAnthropicBudget(30)

  const mission = defaultMission('probe')
  const missionText = renderMission(mission)
  const summaries = RESUME_ITEMS.map((i) => `[${i.id}] (${i.kind}) ${i.title} — ${i.org} (${i.period}): ${i.summary}`).join('\n')
  const skills = Array.from(new Set(RESUME_ITEMS.flatMap((i) => i.domains))).join('; ')
  const t0 = Date.now()
  let firstStrategy: SearchStrategy | null = null

  // ─── (a) Planner ───────────────────────────────────────────────────────────
  if (!only || only === 'planner' || only === 'scout') {
    console.log('\n=== JOB MISSION PLANNER ===')
    const started = Date.now()
    const res = await runJobMissionPlanner(
      { mission: missionText, evidenceSummaries: summaries, skills, preferences: mission.preferences.notes ?? '', watchlist: [], recentFeedback: [] },
      ctx,
      { onStep: (s) => console.log(`  step ${s.step} ${s.elapsedMs}ms stop=${s.stopReason} tools=[${s.toolCalls.join(',')}]`) }
    )
    console.log(`status=${res.status} cached=${res.trace.from_cache ?? false} cost=$${res.trace.cost_usd.toFixed(4)} searches=${res.trace.web_searches} ${Date.now() - started}ms`)
    if (!res.output) {
      console.log(`error: ${res.error}`)
    } else {
      const p = res.output
      console.log(`\nROLE FAMILIES (${p.role_families.length})`)
      for (const f of p.role_families) console.log(`  ${f.confidence.toFixed(2)} ${f.name} — ${f.example_titles.slice(0, 4).join(' / ')}\n       ${f.rationale}`)
      console.log(`\nSTRATEGIES (${p.strategies.length})`)
      for (const s of p.strategies) {
        console.log(`  ${s.priority.toFixed(2)} [${s.kind}] ${s.name} — ${s.rationale}`)
        for (const q of s.queries) console.log(`       · ${q}`)
      }
      console.log(`\nSEED COMPANIES (${p.seed_companies.length}, ${p.seed_companies.filter((c) => c.source_verified).length} source-verified, ${p.dropped_non_operators} non-operators dropped)`)
      for (const c of p.seed_companies) console.log(`  ${c.priority.toFixed(2)} ${c.name} (${c.domain ?? '—'}) [${c.company_type}]${c.source_verified ? ' ✓' : ''} — ${c.why}`)
      console.log(`\nADJACENT: ${p.adjacent_categories.join('; ')}`)
      console.log(`EXCLUDE: ${p.exclusions.join('; ')}`)
      console.log(`\nREASONING: ${p.reasoning}`)
      firstStrategy = p.strategies[0] ?? null
    }
  }

  // ─── (b) One scout round ──────────────────────────────────────────────────
  if (!only || only === 'scout') {
    console.log('\n=== JOB SCOUT — one round, naive tools ===')
    if (!firstStrategy) {
      console.log('no strategy from the planner; skipping')
    } else {
      const started = Date.now()
      const session = await runJobScoutSession(
        {
          strategy: firstStrategy,
          mission: missionText,
          alreadyFound: [],
          maxRounds: 1,
          targetCount: 8,
          tools: { lookupBoard, fetchPage, maxLookups: 4, maxFetches: 3 },
          cache: !noCache,
          onStep: (s) => console.log(`  step ${s.step} ${s.elapsedMs}ms stop=${s.stopReason} tools=[${s.toolCalls.join(',')}]`),
          onToolCall: (e) => console.log(`  tool ${e.summary} (${e.elapsedMs}ms)`),
        },
        ctx
      )
      const r = session.agentResults[0]
      console.log(`status=${r?.status} cached=${r?.trace.from_cache ?? false} cost=$${(r?.trace.cost_usd ?? 0).toFixed(4)} searches=${r?.trace.web_searches ?? 0} ${Date.now() - started}ms`)
      for (const h of session.history) console.log(`round ${h.round}: "${h.query_used}" → ${h.postings_found} found, ${h.postings_kept} kept, ${h.postings_ungrounded} ungrounded · ${h.diagnosis} → ${h.action}`)
      for (const e of session.errors) console.log(`error: ${e}`)
      console.log(`\nPOSTINGS (${session.postings.length})`)
      for (const p of session.postings) console.log(`  ${p.company_name} — ${p.title} (${p.location ?? '?'}) [${p.source_kind}${p.ats_hint ? '/' + p.ats_hint : ''}] season=${p.season_hint ?? '?'}\n       ${p.url}\n       ${p.why_relevant}`)
      console.log(`\nCOMPANIES TO CHECK (${session.companiesToCheck.length})`)
      for (const c of session.companiesToCheck) console.log(`  ${c.name} (${c.domain ?? '—'}) — ${c.why}`)
      const out = r?.output
      if (out) console.log(`\nDIAGNOSIS ${out.diagnosis}: ${out.diagnosis_reasoning}\nACTION ${out.action}: ${out.action_reasoning}${out.next_query ? `\nNEXT: ${out.next_query}` : ''}`)
      console.log(`evidence pool ${r?.evidence.length ?? 0} urls · tool pool ${session.toolUrls.size} urls`)
    }
  }

  // ─── (c) Extractor on a real Greenhouse posting ───────────────────────────
  if (!only || only === 'extractor') {
    console.log('\n=== JOB EXTRACTOR — one real Greenhouse posting ===')
    const board = process.env.PROBE_GREENHOUSE_BOARD ?? 'kairospower'
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`)
    if (!res.ok) {
      console.log(`greenhouse board ${board}: HTTP ${res.status}; skipping`)
    } else {
      const data = (await res.json()) as { jobs: { title: string; location?: { name?: string }; content: string; absolute_url: string }[] }
      const job = data.jobs.find((j) => /intern/i.test(j.title)) ?? data.jobs.find((j) => /(new grad|early career|fellow|resident)/i.test(j.title)) ?? data.jobs[0]
      if (!job) {
        console.log('board is empty; skipping')
      } else {
        console.log(`${job.title} — ${job.location?.name ?? '?'}\n${job.absolute_url}`)
        const text = decodeHtml(decodeHtml(job.content))
        const started = Date.now()
        const r = await runJobExtractor(
          { title: job.title, company: board, location_raw: job.location?.name ?? null, text, source_hint: 'greenhouse' },
          ctx
        )
        console.log(`status=${r.status} cached=${r.trace.from_cache ?? false} model=${r.trace.model} cost=$${r.trace.cost_usd.toFixed(4)} ${Date.now() - started}ms (${text.length} chars)`)
        if (r.output) {
          const o = r.output
          console.log(`  ${o.employment_type} · ${o.season_relevance} · ${o.work_mode} · ${o.role_family ?? '?'} · closed=${o.appears_closed} · conf=${o.confidence}`)
          console.log(`  location: ${o.location_raw ?? '—'} · deadline: ${o.deadline ?? '—'} · pay: ${o.compensation ?? '—'} · industry: ${o.industry ?? '—'}`)
          console.log(`  grad: ${o.graduation_eligibility ?? '—'}`)
          console.log(`  auth: ${o.work_authorization ?? '—'}`)
          console.log(`  MIN: ${o.min_qualifications.join(' | ')}`)
          console.log(`  PREF: ${o.preferred_qualifications.join(' | ')}`)
          console.log(`  SKILLS: ${o.skills.join(', ')}`)
          console.log(`  DOES: ${o.responsibilities.join(' | ')}`)
          console.log(`  ${o.summary}`)
        } else console.log(`error: ${r.error}`)
      }
    }
  }

  const u = anthropicUsage()
  console.log(`\nTOTAL: ${u.calls} calls (${u.cachedCalls} cached) · ${u.webSearches} searches · $${u.costUsd.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
