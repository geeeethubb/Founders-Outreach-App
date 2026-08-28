// Shared no-DB helpers for the three writing suites — factuality, minimal-edit
// and cover-letter (docs/CAREER_OS.md §9). Builds on evals/career/harness.ts
// (environment, cost meter, result files) and adds what those suites need:
//
//   a STABLE bank      buildMemoryBank mints fresh uuids per call, and the
//                      matcher, tailor-verifier and writer caches all key on
//                      ids — so a second run would pay again for identical
//                      inputs. The bank is cached as JSON under
//                      .career-out/eval/bank/ (gitignored) keyed by the
//                      résumé's sha256; same ids, same cache hits, $0.
//   a job projection   JD text → extractor → normalized JobOpportunity, the
//                      way a scouted posting arrives.
//   an evidence map    runEvidenceMatcher with the orchestrator's exact inputs
//                      (validIds from the bank), without research or fit.
//
// Nothing here touches a database, and nothing here writes the résumé's text
// anywhere tracked.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { runEvidenceMatcher, type EvidenceMatch } from '@/lib/agents/evidence-matcher'
import type { JobExtraction } from '@/lib/agents/job-extractor'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { buildMemoryBank } from '@/lib/career/evidence/memory-bank'
import { buildExperiencePool, renderExperienceSummaries, renderSkills, renderStories } from '@/lib/career/evidence/render'
import { renderRetrievedDetail, retrieveEvidenceForJob } from '@/lib/career/evidence/retrieve'
import { bulletsForExperience, factsForExperience } from '@/lib/career/evidence/store'
import { evidenceVersion } from '@/lib/career/intelligence/orchestrator'
import { fitJobInputFrom } from '@/lib/career/intelligence/load'
import { buildNormalizedJob } from '@/lib/career/jobs/normalize'
import { descriptionSha } from '@/lib/career/jobs/snapshot'
import { contactFromParagraphMap } from '@/lib/career/package/letter'
import { stripMarkdown } from '@/lib/career/documents/docx-read'
import type { RawJobPosting } from '@/lib/career/sources/types'
import type { CareerRun } from '@/lib/career/runs'
import type { CareerMission, EvidenceBank, JobOpportunity } from '@/lib/career/types'
import { EVAL_OUT_ROOT, EVAL_USER, extractCached, round4, toJobOpportunity } from './harness'

// ─── The stable bank ─────────────────────────────────────────────────────────

export interface StableBank {
  bank: EvidenceBank
  /** The applicant's name from the résumé's name paragraph. */
  name: string
  contact: { email: string | null; phone: string | null; linkedin: string | null }
  costUsd: number
  fromCache: boolean
  sha256: string
}

const BANK_CACHE_VERSION = 1

/**
 * The real résumé as an Evidence Bank with ids that survive across runs.
 * Deleting .career-out/eval/bank/ is how to force fresh ids (and re-pay for
 * every id-keyed cache).
 */
export async function loadStableBank(resumePath: string, ctx: ToolContext): Promise<StableBank> {
  const docx = fs.readFileSync(resumePath)
  const sha256 = crypto.createHash('sha256').update(docx).digest('hex')
  const dir = path.join(EVAL_OUT_ROOT, 'bank')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sha256.slice(0, 16)}.v${BANK_CACHE_VERSION}.json`)
  if (fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<StableBank, 'fromCache'>
      if (cached.bank?.experiences?.length) return { ...cached, costUsd: 0, fromCache: true }
    } catch {
      // A damaged cache file is rebuilt, not trusted.
    }
  }
  const mem = await buildMemoryBank({ userId: EVAL_USER, docx, filename: path.basename(resumePath), ctx })
  if (mem.agentError) throw new Error(`résumé importer failed: ${mem.agentError}`)
  if (mem.bank.experiences.length === 0) throw new Error('the memory bank has no experiences — nothing to tailor')
  const contact = contactFromParagraphMap(mem.bank.masterDocument?.paragraph_map ?? [])
  const name = mem.model.name ?? mem.bank.masterDocument?.paragraph_map.find((e) => e.kind === 'name')?.text ?? 'Applicant'
  const out: Omit<StableBank, 'fromCache'> = { bank: mem.bank, name, contact, costUsd: mem.costUsd, sha256 }
  fs.writeFileSync(file, JSON.stringify(out))
  return { ...out, fromCache: false }
}

// ─── Bank views ──────────────────────────────────────────────────────────────

/** The master's approved bullets, plain text, in résumé order — the judge's "résumé text". */
export function masterBulletsText(bank: EvidenceBank): string {
  return bank.experiences
    .slice()
    .sort((a, b) => a.display_order - b.display_order)
    .flatMap((e) => bulletsForExperience(bank, e.id).filter((b) => b.is_on_master && b.approved).map((b) => stripMarkdown(b.text)))
    .join('\n')
}

/** Approved fact statements of one experience — what the faithfulness judge is shown. */
export function factStatements(bank: EvidenceBank, experienceId: string): string[] {
  return factsForExperience(bank, experienceId).filter((f) => f.approved).map((f) => f.statement)
}

export function experienceLabelOf(bank: EvidenceBank, experienceId: string): string {
  const e = bank.experiences.find((x) => x.id === experienceId)
  return e ? `${e.title} — ${e.organization}` : experienceId
}

/** The experiences that carry at least one approved master bullet, in résumé order. */
export function experiencesWithBullets(bank: EvidenceBank): string[] {
  return bank.experiences
    .slice()
    .sort((a, b) => a.display_order - b.display_order)
    .filter((e) => bulletsForExperience(bank, e.id).some((b) => b.is_on_master && b.approved))
    .map((e) => e.id)
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export interface JdLike {
  id: string
  title: string
  company: string
  location_raw: string | null
  jd_text: string
  /** Where the text came from; 'manual' for fixtures, the ATS type for live boards. */
  source_hint?: string | null
  company_domain?: string | null
  source_url?: string | null
}

/** "Title (Summer 2027) — Company, City, ST" — the first line of every factuality attack. */
export function parseAttackHeader(jdText: string): { title: string; company: string; location_raw: string | null } {
  const first = jdText.split('\n')[0].trim()
  const m = first.match(/^(.*?)\s+[—–-]\s+([^,]+)(?:,\s*(.+))?$/)
  if (!m) return { title: first, company: 'Unknown', location_raw: null }
  return { title: m[1].trim(), company: m[2].trim(), location_raw: m[3]?.trim() ?? null }
}

export interface ProjectedJob {
  job: JobOpportunity
  extraction: AgentResult<JobExtraction>
}

/** JD → extractor → normalized row, exactly as scripts/career-package.ts does it. */
export async function projectJob(jd: JdLike, ctx: ToolContext, run: CareerRun, mission: CareerMission): Promise<ProjectedJob> {
  const extraction = await extractCached({ title: jd.title, company: jd.company, location_raw: jd.location_raw, text: jd.jd_text, source_hint: jd.source_hint ?? 'manual' }, ctx, run)
  const now = new Date().toISOString()
  const raw: RawJobPosting = {
    source_type: 'manual', source_url: jd.source_url ?? `manual:${jd.id}`, external_id: null, company_name: jd.company, company_domain: jd.company_domain ?? null,
    title: jd.title, location_raw: jd.location_raw, description_text: jd.jd_text, description_html: null, department: null, posted_at: null, updated_at: null,
    apply_url: jd.source_url ?? null, canonical_url: jd.source_url ?? null, ats_type: null, ats_job_id: null, requisition_id: null, employment_type_hint: null, raw: {}, retrieved_at: now,
  }
  const normalized = buildNormalizedJob(raw, extraction.output, { geo_tiers: mission.preferences.geo_tiers })
  return { job: toJobOpportunity(normalized, `eval-${jd.id}`, mission), extraction }
}

// ─── Evidence map ────────────────────────────────────────────────────────────

export interface EvidenceMapOutcome {
  map: EvidenceMatch | null
  status: string
  error: string | null
  costUsd: number
}

/** The matcher with the orchestrator's inputs and validIds from the bank; no research, no fit. */
export async function evidenceMapFor(bank: EvidenceBank, job: JobOpportunity, ctx: ToolContext, run: CareerRun): Promise<EvidenceMapOutcome> {
  const retrieval = retrieveEvidenceForJob(bank, job)
  const res = await runEvidenceMatcher(
    {
      job: fitJobInputFrom(job),
      evidenceSummaries: renderExperienceSummaries(bank),
      detail: renderRetrievedDetail(bank, retrieval, { maxExperiences: 4 }),
      skills: renderSkills(bank),
      stories: renderStories(bank),
      validIds: {
        experience_ids: bank.experiences.map((e) => e.id),
        fact_ids: bank.facts.map((f) => f.id),
        metric_ids: bank.metrics.map((m) => m.id),
        skill_ids: bank.skills.map((s) => s.id),
        story_ids: bank.stories.map((s) => s.id),
      },
    },
    ctx,
    { cacheKeyParts: { job_id: job.id, description_sha: descriptionSha(job.description_text), evidence_version: evidenceVersion(bank), eval: 'no-db' } }
  )
  await run.trace(res, { job_id: job.id })
  return { map: res.output, status: res.status, error: res.error ?? null, costUsd: round4(res.trace.cost_usd) }
}

/** Retrieval's top experience — the fallback when the matcher gave nothing. */
export function mostRelevantExperience(bank: EvidenceBank, job: JobOpportunity, map: EvidenceMatch | null): string {
  const withBullets = new Set(experiencesWithBullets(bank))
  const fromMap = (map?.top_experience_ids ?? []).find((id) => withBullets.has(id))
  if (fromMap) return fromMap
  const ranked = retrieveEvidenceForJob(bank, job).experiences.map((e) => e.experience_id).filter((id) => withBullets.has(id))
  return ranked[0] ?? experiencesWithBullets(bank)[0]
}

// ─── Text ────────────────────────────────────────────────────────────────────

export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Case-insensitive substring after whitespace normalization — the fixtures' contract. */
export function containsPhrase(text: string, phrase: string): boolean {
  return squash(text).includes(squash(phrase))
}

export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

export function mean(xs: number[]): number | null {
  return xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

export interface AttackFixture {
  id: string
  attack: string
  tempting_terms: string[]
  jd_text: string
  note: string
}

export function loadAttacks(): AttackFixture[] {
  const file = path.resolve('evals/career/fixtures/factuality-attacks.json')
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { attacks: AttackFixture[] }).attacks
}

export interface CorpusJd {
  id: string
  title: string
  company: string
  location_raw: string | null
  jd_text: string
  expected: { fit_class: string; role_family: string }
}

export function loadCorpusJd(id: string): CorpusJd {
  const file = path.resolve('evals/career/fixtures/jd-corpus.json')
  const entry = (JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: CorpusJd[] }).jobs.find((j) => j.id === id)
  if (!entry) throw new Error(`no jd-corpus entry ${id}`)
  return entry
}

/** An attack as a JD the projector accepts. */
export function attackAsJd(a: AttackFixture): JdLike {
  const h = parseAttackHeader(a.jd_text)
  return { id: a.id, title: h.title, company: h.company, location_raw: h.location_raw, jd_text: a.jd_text, source_hint: 'manual' }
}

/** A live posting as a JD: the ATS text, the ATS as the extractor's hint, the board URL kept. */
export function rawPostingAsJd(id: string, raw: RawJobPosting, domain: string | null): JdLike {
  return {
    id, title: raw.title, company: raw.company_name, location_raw: raw.location_raw, jd_text: raw.description_text ?? '',
    source_hint: raw.ats_type ?? raw.source_type, company_domain: domain, source_url: raw.canonical_url ?? raw.source_url,
  }
}

/** The matcher's output as the tailor reads it, or the empty map when the matcher gave nothing. */
export function tailorMapFrom(map: EvidenceMatch | null): { why_i_fit: string | null; emphasize: string[]; do_not_claim: string[]; top_experience_ids: string[] } {
  return map
    ? { why_i_fit: map.why_i_fit, emphasize: map.emphasize, do_not_claim: map.do_not_claim, top_experience_ids: map.top_experience_ids }
    : { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [] }
}

/** The matcher's output as the letter writer reads it. */
export function letterMapFrom(map: EvidenceMatch | null): { why_i_fit: string | null; fact_ids: string[]; story_ids: string[]; top_experience_ids: string[] } {
  return map
    ? { why_i_fit: map.why_i_fit, fact_ids: map.fact_ids, story_ids: map.story_ids, top_experience_ids: map.top_experience_ids }
    : { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] }
}

/** Fixture terms are matched against the pool of ONE experience — a term that is real evidence there is not a fabrication. */
export function termInPool(bank: EvidenceBank, experienceId: string, term: string): boolean {
  return buildExperiencePool(bank, experienceId).lines.some((l) => containsPhrase(l, term))
}
