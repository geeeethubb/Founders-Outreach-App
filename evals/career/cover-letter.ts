// The COVER-LETTER EVAL (docs/CAREER_OS.md §9). Six letters, end to end —
// research → evidence map → writer → grounding gate → DOCX → PDF → QA → an
// independent judge:
//
//   4 REAL companies from the discovery benchmark with a live internship on a
//     keyless board. The researcher runs (cached per company per month), so
//     the writer has grounded points to be specific with.
//   2 FICTIONAL companies from jd-corpus. Nobody can research them, so the
//     letter gets NO company facts — and must still be grounded, and must not
//     invent any. A proper noun about the company beyond its own name is the
//     failure this case exists to catch.
//
// The live posting each real company contributes is pinned under
// .career-out/eval/cover-letter/jobs/ on first fetch, so a re-run measures
// the same six letters even after the board changes (and costs nothing).

import fs from 'fs'
import path from 'path'
import { runCompanyResearcher, type CompanyResearch } from '@/lib/agents/company-researcher'
import { bannedPhrasesIn } from '@/lib/agents/cover-letter-writer'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { buildBankPool } from '@/lib/career/evidence/render'
import { generateCoverLetter, letterJobSummary, type GenerateLetterResult } from '@/lib/career/package/letter'
import { groundedPoints } from '@/lib/career/research/company'
import { getSourceRegistry } from '@/lib/career/sources/registry'
import type { AtsBoardRef, RawJobPosting } from '@/lib/career/sources/types'
import type { CareerRun } from '@/lib/career/runs'
import type { AtsType, CareerMission, EvidenceBank, JobOpportunity } from '@/lib/career/types'
import { count, outDir, rate, round4, type MetricResult } from './harness'
import { judgeCoverLetter, LETTER_DIMENSIONS, type LetterDimension, type LetterJudgement } from './judge'
import { evidenceMapFor, letterMapFrom, loadCorpusJd, masterBulletsText, mean, projectJob, rawPostingAsJd, type JdLike, type StableBank } from './letter-harness'

export const SUITE = 'cover-letter'

/** Benchmark companies with confirmed keyless boards, in the order they are tried; the first four with a live internship are used. */
export const REAL_CANDIDATES: { name: string; domain: string; ats: AtsType; identifier: string }[] = [
  { name: 'Kairos Power', domain: 'kairospower.com', ats: 'greenhouse', identifier: 'kairospower' },
  { name: 'Rondo Energy', domain: 'rondo.com', ats: 'greenhouse', identifier: 'rondoenergy' },
  { name: 'Commonwealth Fusion Systems', domain: 'cfs.energy', ats: 'lever', identifier: 'cfsenergy' },
  { name: 'Form Energy', domain: 'formenergy.com', ats: 'ashby', identifier: 'formenergy' },
  { name: 'Zipline', domain: 'flyzipline.com', ats: 'greenhouse', identifier: 'flyzipline' },
  { name: 'Formlabs', domain: 'formlabs.com', ats: 'greenhouse', identifier: 'formlabs' },
  { name: 'Tulip Interfaces', domain: 'tulip.co', ats: 'greenhouse', identifier: 'tulip' },
  { name: 'Skydio', domain: 'skydio.com', ats: 'ashby', identifier: 'skydio' },
  { name: 'Applied Intuition', domain: 'appliedintuition.com', ats: 'ashby', identifier: 'applied' },
]
export const FICTIONAL_IDS = ['jd-pos-02-industrial-ai-intern', 'jd-pos-06-product-intern-robotics']
export const REAL_N = 4

/** The band the writer is held to: its own minimum less the validator's slack, its maximum plus it. */
export const WORD_BAND = { min: 180, max: 315 }

// ─── Live postings, pinned ───────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** The first internship on the board with a real description, by id so the pick is stable. */
export function pickInternship(postings: RawJobPosting[]): RawJobPosting | null {
  return postings
    .filter((p) => /\bintern(ship)?\b/i.test(p.title) && (p.description_text ?? '').length >= 600)
    .sort((a, b) => String(a.external_id ?? a.source_url).localeCompare(String(b.external_id ?? b.source_url)))[0] ?? null
}

async function livePosting(c: (typeof REAL_CANDIDATES)[number], log: (l: string) => void): Promise<RawJobPosting | null> {
  const pin = path.join(outDir(`${SUITE}/jobs`), `${slug(c.name)}.json`)
  if (fs.existsSync(pin)) {
    try {
      return JSON.parse(fs.readFileSync(pin, 'utf8')) as RawJobPosting
    } catch {
      // A damaged pin is refetched, not trusted.
    }
  }
  const adapter = getSourceRegistry().byId(c.ats)
  if (!adapter) {
    log(`${c.name}: ${c.ats} adapter unavailable`)
    return null
  }
  const board: AtsBoardRef = { ats: c.ats, identifier: c.identifier, company_name: c.name }
  const listing = await adapter.listPostings(board, { internshipsOnly: true, limit: 60 })
  const pick = pickInternship(listing.postings)
  log(`${c.name}: ${listing.postings.length} internship-like of ${listing.total_on_board} on ${c.ats}${listing.error ? ` (${listing.error})` : ''} → ${pick ? `"${pick.title}"` : 'none usable'}`)
  if (pick) fs.writeFileSync(pin, JSON.stringify({ ...pick, company_name: c.name, company_domain: c.domain }, null, 2))
  return pick ? { ...pick, company_name: c.name, company_domain: c.domain } : null
}

// ─── Proper nouns the letter had no right to ─────────────────────────────────

const COMMON_CAPS = new Set(['I', "I'm", "I'd", "I've", 'Dear', 'Sincerely', 'Summer', 'Fall', 'Spring', 'Winter', 'The', 'A', 'An', 'In', 'At', 'As', 'My', 'This', 'That', 'When', 'What', 'Your', 'We', 'It', 'If', 'For', 'On', 'To', 'With', 'From', 'But', 'And', 'Or', 'Beyond', 'While', 'During', 'After', 'Before', 'Because', 'Since', 'Through', 'Over', 'Most', 'Each', 'One', 'Two', 'Three', 'These', 'Those', 'There', 'Here', 'Then', 'Now', 'Yet', 'So', 'Not', 'No', 'Yes', 'Where', 'Why', 'How', 'Who', 'Which', 'Both', 'Even', 'Every', 'Beyond', 'Last', 'First', 'Second', 'Working', 'Building', 'Having', 'Learning', 'Thank', 'Please', 'Also', 'Instead', 'Rather', 'Still', 'Being', 'Doing', 'Getting', 'Seeing', 'Given', 'Between', 'Within', 'Without', 'Until', 'Across', 'Along', 'Around', 'Under', 'Beyond', 'Perhaps', 'Just', 'Only', 'Once', 'Again', 'Later', 'Earlier', 'Today', 'Tomorrow', 'Chemical', 'Engineering'])

/**
 * Capitalized words in the paragraphs that are not: sentence-initial, the
 * company, the applicant, the role, or anything in the applicant's own
 * evidence (their employers and schools are theirs to name). What is left is
 * a name the letter had no source for.
 */
export function foreignProperNouns(paragraphs: string[], allowed: { company: string; name: string; title: string; personalPool: string[] }): string[] {
  const allow = new Set<string>()
  const addWords = (s: string) => { for (const w of s.match(/[A-Za-z][A-Za-z0-9&'’.-]*/g) ?? []) allow.add(w.replace(/[.,;:!?'’]+$/, '').toLowerCase()) }
  addWords(allowed.company)
  addWords(allowed.name)
  addWords(allowed.title)
  for (const l of allowed.personalPool) addWords(l)
  const found = new Set<string>()
  for (const p of paragraphs) {
    const sentences = p.split(/(?<=[.!?])\s+/)
    for (const s of sentences) {
      const words = s.match(/[A-Za-z][A-Za-z0-9&'’.-]*/g) ?? []
      words.forEach((w, i) => {
        if (i === 0) return
        const clean = w.replace(/[.,;:!?'’]+$/, '')
        if (!/^[A-Z]/.test(clean) || clean.length < 2) return
        if (COMMON_CAPS.has(clean) || allow.has(clean.toLowerCase())) return
        found.add(clean)
      })
    }
  }
  return [...found]
}

// ─── One letter ──────────────────────────────────────────────────────────────

export interface LetterCase {
  id: string
  kind: 'real' | 'fictional'
  company: string
  title: string
  source_url: string | null
  research: { ran: boolean; facts: number; claims: number; grounded_points: number; cached: boolean; costUsd: number; error: string | null }
  matcher_status: string
  attempts: number
  one_page_retried: boolean
  one_page_retry_from: number | null
  word_count: number | null
  grounding_ok: boolean | null
  blocking: string[]
  warnings: string[]
  page_count: number | null
  one_page: boolean | null
  qa_failed: string[]
  banned_phrases: string[]
  foreign_proper_nouns: string[] | null
  judge: LetterJudgement | null
  judge_error: string | null
  paragraphs: string[]
  docx: string | null
  pdf: string | null
  costUsd: number
  judgeCostUsd: number
  errors: string[]
}

export interface CoverLetterEvalResult {
  cases: LetterCase[]
  metrics: MetricResult[]
  dimension_means: Record<LetterDimension, number | null>
  suspect_claims: { id: string; claim: string }[]
  costUsd: number
  judgeCostUsd: number
  errors: string[]
}

async function research(job: JobOpportunity, domain: string | null, mission: CareerMission, ctx: ToolContext, run: CareerRun): Promise<{ research: CompanyResearch | null; cached: boolean; costUsd: number; error: string | null }> {
  const desc = (job.description_text ?? '').slice(0, 600).replace(/\s+/g, ' ').trim()
  const res = await runCompanyResearcher(
    {
      company: { name: job.company_name, domain, careers_url: null, what_we_know: desc ? `Posting opens: "${desc}"` : '' },
      job_title: job.title,
      mission_interests: `${mission.preferences.optimize_for.join(' > ')} · ${mission.preferences.company_types.join(', ')}`,
      depth: 'standard',
    },
    ctx
  )
  await run.trace(res, { eval: SUITE, company: job.company_name })
  return { research: res.output, cached: res.trace.cost_usd === 0, costUsd: round4(res.trace.cost_usd), error: res.status === 'succeeded' ? null : `${res.status}: ${res.error ?? 'no output'}` }
}

async function runLetter(jd: JdLike, kind: LetterCase['kind'], domain: string | null, stable: StableBank, mission: CareerMission, ctx: ToolContext, run: CareerRun, doResearch: boolean, log: (l: string) => void): Promise<LetterCase> {
  const { bank } = stable
  const errors: string[] = []
  const { job } = await projectJob(jd, ctx, run, mission)

  let r: LetterCase['research'] = { ran: false, facts: 0, claims: 0, grounded_points: 0, cached: false, costUsd: 0, error: null }
  let researched: CompanyResearch | null = null
  if (doResearch) {
    const x = await research(job, domain, mission, ctx, run)
    researched = x.research
    r = { ran: true, facts: researched?.claims.filter((c) => c.type === 'FACT').length ?? 0, claims: researched?.claims.length ?? 0, grounded_points: researched ? groundedPoints(researched).length : 0, cached: x.cached, costUsd: x.costUsd, error: x.error }
    if (x.error) errors.push(`research: ${x.error}`)
  }
  const points = researched ? groundedPoints(researched).map((p) => ({ id: p.id, text: p.text })) : []
  const map = await evidenceMapFor(bank, job, ctx, run)
  log(`${jd.id}: research ${r.ran ? `${r.facts} FACT / ${r.claims} claims · ${r.grounded_points} points${r.cached ? ' (cached)' : ''}` : 'skipped'} · matcher ${map.status}`)

  const dir = path.join(outDir(SUITE), slug(jd.id))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const gen: GenerateLetterResult = await generateCoverLetter({
    bank, ctx, run, output: { kind: 'dir', dir }, persist: null,
    job: { title: job.title, company_name: job.company_name, location_raw: job.location_raw, description_text: job.description_text, responsibilities: job.responsibilities },
    research: { points, summary: researched?.summary ?? '', factClaims: researched ? researched.claims.filter((c) => c.type === 'FACT').map((c) => c.claim) : [], domain },
    evidenceMap: letterMapFrom(map.map),
    user: { name: stable.name, email: stable.contact.email ?? '', phone: stable.contact.phone ?? '', linkedin: stable.contact.linkedin },
    onStep: (s) => log(`  ${jd.id} attempt ${s.attempt}: ${s.detail}`),
  })
  errors.push(...gen.errors)
  const letter = gen.letter
  const qa = gen.documents?.qa ?? null
  const onePage = qa?.checks.find((c) => c.name === 'one_page')
  const fillerCheck = qa?.checks.find((c) => c.name === 'no_banned_filler')
  const banned = [...bannedPhrasesIn(letter.paragraphs.join('\n')), ...(fillerCheck && !fillerCheck.pass ? fillerCheck.detail.split(', ') : [])]

  let judge: LetterJudgement | null = null
  let judgeError: string | null = null
  let judgeCost = 0
  if (letter.fullText) {
    const j = await judgeCoverLetter(letter.fullText, letterJobSummary({ title: job.title, company_name: job.company_name, location_raw: job.location_raw, description_text: job.description_text, responsibilities: job.responsibilities }), masterBulletsText(bank), points.map((p) => p.text))
    judge = j.result
    judgeError = j.error ?? null
    judgeCost = j.costUsd
  }

  return {
    id: jd.id, kind, company: jd.company, title: jd.title, source_url: jd.source_url ?? null,
    research: r, matcher_status: map.status,
    attempts: letter.attempts, one_page_retried: gen.onePageRetried, one_page_retry_from: gen.onePageRetryFrom,
    word_count: letter.wordCount, grounding_ok: letter.grounding?.ok ?? null,
    blocking: (letter.grounding?.blocking ?? []).map((f) => `${f.kind}: "${f.span}" — ${f.reason}`),
    warnings: (letter.grounding?.warnings ?? []).map((f) => `${f.kind}: "${f.span}"`),
    page_count: qa?.page_count ?? null, one_page: onePage ? onePage.pass : null,
    qa_failed: (qa?.checks ?? []).filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`),
    banned_phrases: banned,
    foreign_proper_nouns: kind === 'fictional' ? foreignProperNouns(letter.paragraphs, { company: jd.company, name: stable.name, title: jd.title, personalPool: buildBankPool(bank).lines }) : null,
    judge, judge_error: judgeError, paragraphs: letter.paragraphs,
    docx: gen.documents?.docxPath ?? null, pdf: gen.documents?.pdfPath ?? null,
    costUsd: round4(gen.costUsd + map.costUsd + r.costUsd), judgeCostUsd: round4(judgeCost), errors,
  }
}

// ─── The suite ───────────────────────────────────────────────────────────────

export async function runCoverLetterEval(params: { stable: StableBank; mission: CareerMission; ctx: ToolContext; run: CareerRun; researchFictional?: boolean; log?: (l: string) => void }): Promise<CoverLetterEvalResult> {
  const log = params.log ?? (() => {})
  const cases: LetterCase[] = []
  const errors: string[] = []

  // Real companies: the first four with a usable live internship.
  const real: { jd: JdLike; domain: string }[] = []
  for (const c of REAL_CANDIDATES) {
    if (real.length >= REAL_N) break
    try {
      const p = await livePosting(c, log)
      if (p) real.push({ jd: rawPostingAsJd(`live-${slug(c.name)}`, p, c.domain), domain: c.domain })
    } catch (e) {
      errors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (real.length < REAL_N) errors.push(`only ${real.length}/${REAL_N} real companies had a usable live internship`)

  const specs: { jd: JdLike; kind: LetterCase['kind']; domain: string | null; research: boolean }[] = [
    ...real.map((r) => ({ jd: r.jd, kind: 'real' as const, domain: r.domain, research: true })),
    ...FICTIONAL_IDS.map((id) => {
      const j = loadCorpusJd(id)
      return { jd: { id: j.id, title: j.title, company: j.company, location_raw: j.location_raw, jd_text: j.jd_text } as JdLike, kind: 'fictional' as const, domain: null, research: params.researchFictional === true }
    }),
  ]
  for (const s of specs) {
    try {
      cases.push(await runLetter(s.jd, s.kind, s.domain, params.stable, params.mission, params.ctx, params.run, s.research, log))
    } catch (e) {
      errors.push(`${s.jd.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const n = cases.length
  const written = cases.filter((c) => c.word_count !== null)
  const grounded = cases.filter((c) => c.grounding_ok === true).length
  const rendered = cases.filter((c) => c.page_count !== null)
  const onePage = rendered.filter((c) => c.one_page === true).length
  const inBand = written.filter((c) => (c.word_count ?? 0) >= WORD_BAND.min && (c.word_count ?? 0) <= WORD_BAND.max).length
  const bannedTotal = cases.reduce((s, c) => s + c.banned_phrases.length, 0)
  const fictional = cases.filter((c) => c.kind === 'fictional')
  const foreign = fictional.reduce((s, c) => s + (c.foreign_proper_nouns?.length ?? 0), 0)
  const judged = cases.filter((c) => c.judge)
  const dimension_means = Object.fromEntries(LETTER_DIMENSIONS.map((d) => [d, mean(judged.map((c) => (c.judge as LetterJudgement).scores[d]))])) as Record<LetterDimension, number | null>
  const suspect = judged.flatMap((c) => (c.judge as LetterJudgement).suspect_claims.map((claim) => ({ id: c.id, claim })))
  const words = written.map((c) => c.word_count as number)

  const metrics: MetricResult[] = [
    rate('grounding ok (after the retry)', n ? grounded / n : 0, n, '100%', n > 0 && grounded === n),
    rate('one page (rendered)', rendered.length ? onePage / rendered.length : 0, rendered.length, '100%', rendered.length > 0 && onePage === rendered.length, rendered.length < n ? `${n - rendered.length} not rendered` : `${cases.filter((c) => c.one_page_retried).length} needed the one-page retry`),
    rate(`word count in ${WORD_BAND.min}–${WORD_BAND.max}`, written.length ? inBand / written.length : 0, written.length, '100%', written.length > 0 && inBand === written.length, words.length ? `min ${Math.min(...words)} · mean ${Math.round(words.reduce((a, b) => a + b, 0) / words.length)} · max ${Math.max(...words)}` : ''),
    count('banned phrases', bannedTotal, n, '0', bannedTotal === 0),
    count('fictional: proper nouns beyond the company name', foreign, fictional.length, '0', fictional.length > 0 && foreign === 0, fictional.flatMap((c) => c.foreign_proper_nouns ?? []).join(', ')),
    count('letters written', written.length, specs.length, String(REAL_N + FICTIONAL_IDS.length), written.length === REAL_N + FICTIONAL_IDS.length, errors.join('; ')),
    ...LETTER_DIMENSIONS.map((d) => ({ metric: `judge ${d} (mean, reported)`, actual: dimension_means[d] ?? -1, display: dimension_means[d] === null ? 'n/a' : String(dimension_means[d]), target: 'report', pass: true, n: judged.length })),
    count('judge suspect claims (reported)', suspect.length, judged.length, 'report', true),
  ]

  return {
    cases, metrics, dimension_means, suspect_claims: suspect, errors,
    costUsd: round4(cases.reduce((s, c) => s + c.costUsd, 0)),
    judgeCostUsd: round4(cases.reduce((s, c) => s + c.judgeCostUsd, 0)),
  }
}
