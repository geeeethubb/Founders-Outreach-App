// Context benchmark: how much of the bank each agent used to see, versus what
// the retrieval layer hands it now. Rows and estimated tokens (chars / 4).
//
//   npm run evidence:benchmark                  live bank, read-only
//   npm run evidence:benchmark -- --user <id>
//   npm run evidence:benchmark -- --fixture     the synthetic bank, no database
//
// Writes .career-out/evidence/benchmark-<stamp>.json. Never mutates rows.

import { defaultProfiles } from './lib/cli-user'
import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'
import { renderExperienceSummaries, experienceLabel } from '../lib/career/evidence/render'
import { bulletsForExperience, factsForExperience, metricsForExperience } from '../lib/career/evidence/store'
import { getRelevantPersonalEvidence, renderRelevantEvidence } from '../lib/career/evidence/retrieval'
import { backgroundForOutreach, toScoutItems } from '../lib/outreach/background'
import { buildTailorInput } from '../lib/career/tailor/render'
import { resumeTailorPrompt, type ResumeTailorInput, type TailorExperience } from '../lib/agents/resume-tailor/prompt'
import { renderRules } from '../lib/career/tailor/rules'
import { stripMarkdown } from '../lib/career/documents/docx-read'
import type { EvidenceBank } from '../lib/career/types'
import type { RetrievalInput } from '../lib/career/evidence/retrieval-types'

const tokens = (s: string) => Math.ceil(s.length / 4)

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

const PERSONAS: { name: string; input: Omit<RetrievalInput, 'bank'> }[] = [
  { name: 'deep-tech founder', input: { mission: 'Find deep-tech founders working on catalysis, clean energy and hard science', target: { kind: 'person', title: 'Co-founder & CTO', company: 'a clean-energy catalysis startup', description: 'Electrochemical catalysts for hydrogen; ex-national lab; techno-economic modelling.' } } },
  { name: 'AI founder', input: { mission: 'Meet AI founders building agents and agentic workflows', target: { kind: 'person', title: 'Founder & CEO', company: 'an AI agents startup', description: 'LLM agents and agentic workflow automation for enterprises.' } } },
  { name: 'industrial exec', input: { mission: 'Find manufacturing and quality leaders at industrial plants', target: { kind: 'person', title: 'VP Manufacturing & Quality', company: 'a consumer goods manufacturer', description: 'Plant operations, quality systems, SOPs, process automation.' } } },
  { name: 'VC', input: { mission: 'Meet venture investors who back student founders', target: { kind: 'person', title: 'Partner', company: 'a seed-stage venture fund', description: 'Pre-seed and seed rounds; accelerator; Y Combinator alumnus; campus scouts.' } } },
  { name: 'UIUC alumnus', input: { mission: 'Reconnect with UIUC alumni active in campus entrepreneurship', target: { kind: 'person', title: 'Founder', company: 'a startup founded by a UIUC alumnus', description: 'UIUC alumnus, Founders member, hackathon organizer.' } } },
  { name: 'speaker / event organizer', input: { mission: 'Invite speakers and event organizers for a campus series', target: { kind: 'person', title: 'Head of Community', company: 'a conference organizer', description: 'Summits, hackathons, podcast host, books speakers.' } } },
]

const JOB = {
  title: 'Process Engineering Intern',
  company: 'Acme Specialty Chemicals',
  key_requirements: ['Chemical engineering student', 'SOPs and quality systems', 'process improvement', 'data analysis'],
  responsibilities: ['support production line operations', 'write and validate SOPs', 'quality risk assessment'],
  description_excerpt: 'Summer internship at a specialty chemicals plant supporting quality and process engineering.',
}

/** The pre-retrieval tailor input: every approved experience, facts capped at 12 in bank order. */
function oldTailorInput(bank: EvidenceBank): ResumeTailorInput {
  const experiences: TailorExperience[] = bank.experiences
    .filter((e) => e.approved)
    .sort((a, b) => a.display_order - b.display_order)
    .map((e) => ({
      id: e.id,
      label: experienceLabel(e),
      bullets: bulletsForExperience(bank, e.id).filter((b) => b.approved).map((b) => ({ id: b.id, text: stripMarkdown(b.text), is_on_master: b.is_on_master, fact_ids: b.evidence_fact_ids })),
      facts: factsForExperience(bank, e.id).filter((f) => f.approved).slice(0, 12).map((f) => ({ id: f.id, statement: f.statement })),
      metrics: metricsForExperience(bank, e.id).filter((m) => m.approved).map((m) => ({ id: m.id, value: m.value, unit: m.unit, context: m.context })),
    }))
  return { job: JOB, evidenceMap: { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [] }, experiences, rules: renderRules() }
}

function promptChars(input: ResumeTailorInput): number {
  const built = resumeTailorPrompt.build(input) as unknown as Record<string, unknown>
  return JSON.stringify(built).length
}

interface Row { section: string; case: string; beforeRows: number; beforeTokens: number; afterRows: number; afterTokens: number }

function bench(bank: EvidenceBank): Row[] {
  const rows: Row[] = []
  const whole = renderExperienceSummaries(bank)
  const wholeRows = bank.experiences.length
  for (const p of PERSONAS) {
    const rel = getRelevantPersonalEvidence({ bank, ...p.input })
    const compact = renderRelevantEvidence(rel, { style: 'compact' })
    rows.push({ section: 'persona (summaries → compact retrieval)', case: p.name, beforeRows: wholeRows, beforeTokens: tokens(whole), afterRows: rel.experiences.length, afterTokens: tokens(compact) })
  }
  const oldT = oldTailorInput(bank)
  const newT = buildTailorInput(bank, JOB, { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [] })
  rows.push({
    section: 'tailor input (one synthetic job)', case: JOB.title,
    beforeRows: oldT.experiences.reduce((n, e) => n + e.facts.length, 0), beforeTokens: Math.ceil(promptChars(oldT) / 4),
    afterRows: newT.experiences.reduce((n, e) => n + e.facts.length, 0), afterTokens: Math.ceil(promptChars(newT) / 4),
  })
  const oldScout = RESUME_ITEMS.filter((i) => i.credibility !== 'supporting').map((i) => `${i.title} — ${i.org} (${i.period}): ${i.summary}`)
  const bg = backgroundForOutreach(bank, { mission: PERSONAS[2].input.mission, maxExperiences: 12, maxFacts: 24 })
  const newScout = toScoutItems(bg.items).map((s) => s.summary)
  rows.push({ section: `scout background (fixture → ${bg.source})`, case: 'RESUME_ITEMS vs backgroundForOutreach', beforeRows: oldScout.length, beforeTokens: tokens(oldScout.join('\n')), afterRows: newScout.length, afterTokens: tokens(newScout.join('\n')) })
  return rows
}

function printTable(rows: Row[]): void {
  const w = [38, 30, 8, 10, 8, 10]
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join(' ')
  console.log(line(['section', 'case', 'rows', 'tokens', 'rows', 'tokens']))
  console.log(line(['', '', 'before', 'before', 'after', 'after']))
  console.log('-'.repeat(w.reduce((n, x) => n + x + 1, 0)))
  for (const r of rows) console.log(line([r.section.slice(0, 37), r.case.slice(0, 29), String(r.beforeRows), String(r.beforeTokens), String(r.afterRows), String(r.afterTokens)]))
}

async function main() {
  let bank: EvidenceBank
  let source: string
  let migration015 = false
  if (flag('fixture')) {
    const { buildSyntheticBank } = await import('./lib/synthetic-evidence-bank')
    bank = buildSyntheticBank()
    source = 'fixture'
  } else {
    const { loadEvidenceBank } = await import('../lib/career/evidence/store')
    const { createServiceClient } = await import('../lib/supabase/server')
    let userId = arg('user')
    if (!userId) {
      const { data } = await defaultProfiles()
      userId = (data?.[0]?.id as string | undefined) ?? null
    }
    if (!userId) throw new Error('no profile found; pass --user <id> or --fixture')
    const res = await loadEvidenceBank(userId, { approvedOnly: true })
    if (res.migrationMissing) throw new Error('migration 014_career_os.sql has not been applied; use --fixture')
    bank = res.bank
    source = `live user ${userId}`
    // The loader's own flag. On a 014-only database it should be false; the
    // source/organization counts printed beside it are the cross-check.
    migration015 = res.canonical
    if (res.errors.length) console.log(`  bank errors: ${res.errors.join('; ')}`)
  }
  console.log(`\nEVIDENCE CONTEXT BENCHMARK — ${source} · ${bank.experiences.length} experiences, ${bank.facts.length} facts, ${bank.metrics.length} metrics · loader canonical flag: ${migration015} (${bank.sources.length} sources, ${bank.organizations.length} organizations)\n`)
  const rows = bench(bank)
  printTable(rows)
  const total = (k: 'beforeTokens' | 'afterTokens') => rows.reduce((n, r) => n + r[k], 0)
  console.log(`\n  total estimated tokens  before ${total('beforeTokens')}  after ${total('afterTokens')}  (${Math.round((1 - total('afterTokens') / Math.max(1, total('beforeTokens'))) * 100)}% less)`)

  const dir = path.join(process.cwd(), '.career-out', 'evidence')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = path.join(dir, `benchmark-${stamp}.json`)
  fs.writeFileSync(out, JSON.stringify({ source, migration015, counts: { experiences: bank.experiences.length, facts: bank.facts.length, metrics: bank.metrics.length }, rows }, null, 2))
  console.log(`\nwritten to ${path.relative(process.cwd(), out)}`)
}

main().catch((e) => {
  console.error('BENCHMARK FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
