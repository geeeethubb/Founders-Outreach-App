// The application package from the command line. Two modes.
//
//   DB mode — a stored job, the founder's Supabase (migration 014 applied):
//     npx tsx scripts/career-package.ts --job <job_id> [--user <id>]
//     generatePackage → approve every safe change → finishPackage → the view.
//
//   NO-DB mode — the real résumé, a JD file, no database anywhere:
//     npx tsx scripts/career-package.ts --jd <path.json> --resume ./Zuyu_Resume.docx --out .career-out/packages/cli
//     npx tsx scripts/career-package.ts --jd-id jd-pos-01-process-eng-industrial
//     The JD JSON is { title, company, location_raw, jd_text }. Everything the
//     package pipeline does — extraction, research, fit, matching, tailoring,
//     verification, review, documents, letter — runs on an in-memory bank.
//     This is the eval harness's foundation.
//
// Every agent call is cached on disk by content, so a second run of the same
// inputs costs nothing. Live calls need ANTHROPIC_API_KEY in .env.local.

import { defaultProfiles } from './lib/cli-user'
import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import type { ToolContext } from '../lib/agents/runtime/types'
import type { RawJobPosting } from '../lib/career/sources/types'
import type { CareerMission, JobOpportunity } from '../lib/career/types'

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function money(n: number): string {
  return `$${n.toFixed(4)}`
}

// ─── DB mode ─────────────────────────────────────────────────────────────────

async function dbMode(jobId: string): Promise<void> {
  const { createServiceClient } = await import('../lib/supabase/server')
  const { generatePackage, finishPackage } = await import('../lib/career/package/orchestrator')
  const { reviewResumeChanges } = await import('../lib/career/package/review')
  const { packageView } = await import('../lib/career/package/view')

  let userId = opt('user')
  if (!userId) {
    const { data } = await defaultProfiles()
    userId = (data?.[0] as { id: string } | undefined)?.id
  }
  if (!userId) throw new Error('no user — pass --user <id>')

  console.log(`\nPACKAGE — job ${jobId} → user ${userId}\n`)
  const gen = await generatePackage({ userId, jobId, onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`) })
  if (gen.migrationMissing) {
    console.error('migration 014_career_os.sql has not been applied')
    process.exitCode = 2
    return
  }
  console.log(`\ngenerate: status=${gen.status} stage=${gen.stage} cost=${money(gen.costUsd)}`)
  for (const w of gen.warnings) console.log(`  warn: ${w}`)
  for (const e of gen.errors) console.log(`  error: ${e}`)
  if (!gen.packageId) {
    process.exitCode = 1
    return
  }
  console.log(`  résumé: ${gen.resume?.proposed ?? 0} proposed, ${gen.resume?.supported ?? 0} supported, ${gen.resume?.autoRejected ?? 0} auto-rejected${gen.resume?.noChangeReason ? ` — ${gen.resume.noChangeReason}` : ''}`)

  const review = await reviewResumeChanges({ userId, packageId: gen.packageId, approveAllSafe: true })
  console.log(`review: ${review.updated} approved as safe${review.error ? ` — ${review.error}` : ''}`)
  for (const c of review.changes) console.log(`  ${c.review_status.padEnd(13)} ${c.change_type} L${c.edit_level} ${c.verification_result}: ${(c.final_text ?? c.original_text ?? '').slice(0, 90)}`)

  const fin = await finishPackage({ userId, packageId: gen.packageId, onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`) })
  console.log(`\nfinish: status=${fin.status} stage=${fin.stage} cost=${money(fin.costUsd)}${fin.error ? ` error=${fin.error}` : ''}`)
  for (const w of fin.warnings) console.log(`  warn: ${w}`)

  const view = await packageView(userId, gen.packageId)
  const v = view.view as Record<string, any> | null
  if (v) {
    console.log(`\nVIEW: ${v.job.company_name} — ${v.job.title} · fit ${v.fit?.overall ?? '-'} (${v.fit?.band ?? '-'}) · application ${v.application?.state ?? '-'}`)
    for (const [k, d] of Object.entries(v.documents as Record<string, { path: string } | null>)) console.log(`  ${k.padEnd(12)} ${d?.path ?? '-'}`)
    console.log(`  letter: ${v.cover_letter?.word_count ?? '-'} words, ${v.cover_letter?.review_status ?? '-'}`)
  }
  process.exitCode = fin.status === 'failed' ? 1 : 0
}

// ─── NO-DB mode ──────────────────────────────────────────────────────────────

interface JdFile {
  id?: string
  title: string
  company: string
  location_raw: string | null
  jd_text: string
}

function loadJd(): JdFile {
  const id = opt('jd-id')
  if (id) {
    const corpus = JSON.parse(fs.readFileSync(path.resolve('evals/career/fixtures/jd-corpus.json'), 'utf8')) as { jobs: (JdFile & { expected: { fit_class: string } })[] }
    const entry = id === 'first-strong' ? corpus.jobs.find((j) => j.expected.fit_class === 'strong') : corpus.jobs.find((j) => j.id === id)
    if (!entry) throw new Error(`no jd-corpus entry ${id}`)
    return entry
  }
  const file = opt('jd')
  if (!file) throw new Error('pass --job <id>, --jd <path.json> or --jd-id <corpus id>')
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as JdFile
}

async function noDbMode(): Promise<void> {
  const jd = loadJd()
  const resumePath = path.resolve(opt('resume') ?? 'Zuyu_Resume.docx')
  const out = path.resolve(opt('out') ?? path.join('.career-out', 'packages', 'cli'), (jd.id ?? jd.company).replace(/[^A-Za-z0-9_-]+/g, '_'))
  if (!fs.existsSync(resumePath)) throw new Error(`résumé not found at ${resumePath}`)
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — the no-DB run makes live model calls (cached on disk after the first run).')
    process.exit(2)
  }

  const { setAnthropicBudget } = await import('../lib/providers/anthropic/client')
  const { buildMemoryBank } = await import('../lib/career/evidence/memory-bank')
  const { runJobExtractor } = await import('../lib/agents/job-extractor')
  const { buildNormalizedJob } = await import('../lib/career/jobs/normalize')
  const { defaultMission } = await import('../lib/career/missions/store')
  const { runJobIntelligence, memoryRun, packageToolContext } = await import('../lib/career/intelligence/orchestrator')
  const { runTailoringPipeline, applyReviewDecisions } = await import('../lib/career/tailor/pipeline')
  const { jobTermsFor, tailorJobFromOpportunity } = await import('../lib/career/tailor/render')
  const { safeToApprove } = await import('../lib/career/package/review')
  const { generateResumeDocuments } = await import('../lib/career/package/resume')
  const { generateCoverLetter, contactFromParagraphMap } = await import('../lib/career/package/letter')
  const { groundedPoints } = await import('../lib/career/research/company')
  const { shutdownPdfRenderers } = await import('../lib/career/documents/pdf')
  const { stripMarkdown } = await import('../lib/career/documents/docx-read')

  setAnthropicBudget(Number(process.env.PROBE_ANTHROPIC_BUDGET ?? 60))
  const userId = 'cli'
  const ctx: ToolContext = packageToolContext(userId, null)
  const run = memoryRun()
  const started = Date.now()
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })

  console.log(`\nPACKAGE (no DB) — ${jd.company}: ${jd.title}\n  résumé ${resumePath}\n  out    ${out}\n`)

  // 1. Evidence Bank in memory (the importer is cached by input hash).
  console.log('[bank] importing the résumé')
  const mem = await buildMemoryBank({ userId, docx: fs.readFileSync(resumePath), filename: path.basename(resumePath), ctx })
  if (mem.agentError) console.log(`  importer error: ${mem.agentError} (structural bank only)`)
  console.log(`  ${mem.bank.experiences.length} experiences · ${mem.bank.bullets.length} bullets · ${mem.bank.facts.length} facts · ${mem.bank.metrics.length} metrics · ${mem.bank.skills.length} skills · ${money(mem.costUsd)}`)

  // 2. The job, extracted and normalized exactly as a scouted posting would be.
  console.log('[job] extracting')
  const extraction = await runJobExtractor({ title: jd.title, company: jd.company, location_raw: jd.location_raw, text: jd.jd_text, source_hint: 'manual' }, ctx)
  await run.trace(extraction)
  const now = new Date().toISOString()
  const raw: RawJobPosting = {
    source_type: 'manual', source_url: `manual:${jd.id ?? jd.company}`, external_id: null, company_name: jd.company, company_domain: null, title: jd.title,
    location_raw: jd.location_raw, description_text: jd.jd_text, description_html: null, department: null, posted_at: null, updated_at: null, apply_url: null,
    canonical_url: null, ats_type: null, ats_job_id: null, requisition_id: null, employment_type_hint: null, raw: {}, retrieved_at: now,
  }
  const missionBase = defaultMission(userId)
  const mission: CareerMission = { ...missionBase, id: 'cli-mission', created_at: now, updated_at: now }
  const normalized = buildNormalizedJob(raw, extraction.output, { geo_tiers: mission.preferences.geo_tiers })
  const { sources: _s, company_domain: _d, company_key: _k, normalized_title: _t, ...jobCols } = normalized
  const job: JobOpportunity = {
    ...jobCols, id: `cli-${jd.id ?? 'job'}`, user_id: userId, company_id: null, mission_id: mission.id, discovery_run_id: null, duplicate_cluster_id: null,
    fit_overall: null, fit_eligibility: null, fit_computed_at: null, first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now,
  }
  console.log(`  ${job.employment_type} · ${job.season_relevance} · tier ${job.location_tier ?? '-'} · ${job.min_qualifications.length} min / ${job.preferred_qualifications.length} preferred · ${extraction.status}`)

  // 3. Research → fit → evidence map, through the same orchestrator, no DB.
  const intel = await runJobIntelligence({
    userId, jobId: job.id, ctx, run, noDb: true,
    context: { job, company: null, mission, bank: mem.bank, existing: { fit: null, evidenceMap: null, research: { summary: null, facts: [] }, warmPaths: [], latestSnapshot: null }, errors: [] },
    onProgress: (stage, detail) => console.log(`[${stage}] ${detail}`),
  })
  for (const e of intel.errors) console.log(`  error: ${e}`)
  if (intel.research) {
    const r = intel.research
    console.log(`  research: ${r.claims.filter((c) => c.type === 'FACT').length} facts / ${r.claims.length} claims · ${groundedPoints(r).length} grounded points · ${r.company_type}`)
    console.log(`  ${r.summary}`)
  }
  if (intel.fit) {
    console.log(`  fit: ${intel.fit.evaluation.overall} (${intel.fit.evaluation.band}) · ${intel.fit.judgment.eligibility}`)
    for (const c of intel.fit.judgment.components) console.log(`    ${c.dimension.padEnd(22)} ${c.score.toFixed(2)}  ${c.explanation.slice(0, 100)}`)
  }
  if (intel.evidenceMap) {
    console.log(`  evidence map: ${intel.evidenceMap.top_experience_ids.length} top experiences · ${intel.evidenceMap.fact_ids.length} facts · gaps: ${intel.evidenceMap.gaps.join(' | ') || '-'}`)
    console.log(`  why I fit: ${intel.evidenceMap.why_i_fit}`)
    console.log(`  do not claim: ${intel.evidenceMap.do_not_claim.join(' | ') || '-'}`)
  }

  // 4. Tailoring + verification.
  console.log('[tailor] proposing and verifying')
  const tailorJob = tailorJobFromOpportunity(job)
  const tailored = await runTailoringPipeline({
    bank: mem.bank, job: tailorJob, ctx, jobTerms: jobTermsFor(tailorJob),
    evidenceMap: intel.evidenceMap ?? { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [] },
    onStep: (s) => console.log(`  ${s.stage}: ${s.detail}`),
  })
  for (const r of tailored.runs) await run.trace(r)
  if (tailored.error) console.log(`  error: ${tailored.error}`)
  const withIds = tailored.changes.map((c, i) => ({ ...c, id: `c${i + 1}` }))
  const reviewed = await applyReviewDecisions(withIds, safeToApprove(withIds))
  const changes = reviewed.changes.map((c, i) => ({ ...c, id: withIds[i].id }))
  const supported = changes.filter((c) => c.verification_result === 'SUPPORTED').length
  const autoRejected = changes.filter((c) => c.review_status === 'auto_rejected').length
  console.log(`\nCHANGES: ${changes.length} proposed · ${supported} supported · ${autoRejected} auto-rejected · ${changes.filter((c) => c.review_status === 'approved').length} approved as safe · distance ${tailored.distance.distance}`)
  if (tailored.no_change_reason) console.log(`  no change: ${tailored.no_change_reason}`)
  console.log(`  ${tailored.summary}`)
  for (const c of changes) {
    console.log(`\n  [${c.id}] ${c.change_type} L${c.edit_level} → ${c.verification_result} / ${c.review_status}  (${c.job_requirement})`)
    if (c.original_text) console.log(`    - ${stripMarkdown(c.original_text)}`)
    if (c.proposed_text && c.proposed_text !== c.original_text) console.log(`    + ${stripMarkdown(c.proposed_text)}`)
    if (c.verification_notes) console.log(`    ${c.verification_notes.slice(0, 200)}`)
    for (const cl of c.verification_clauses ?? []) console.log(`      ${cl.verdict.padEnd(11)} "${cl.clause}" [${cl.fact_ids.join(', ') || 'uncited'}]${cl.note ? ` — ${cl.note}` : ''}`)
  }
  for (const r of tailored.rejected) console.log(`  tailor-rejected: ${r.reason}`)

  // 5. Documents.
  console.log('\n[documents] résumé')
  const docs = await generateResumeDocuments({ bank: mem.bank, masterBuffer: fs.readFileSync(resumePath), changes, company: jd.company, output: { kind: 'dir', dir: out } })
  console.log(`  ${docs.docxPath ?? '-'}\n  ${docs.pdfPath ?? '(no PDF)'}\n  QA ${docs.qa.ok ? 'ok' : 'FAILED'} · pages ${docs.qa.page_count ?? '-'} · shrink ${docs.shrink_attempts} · dropped ${docs.droppedByShrink.join(', ') || '-'}`)
  for (const c of docs.qa.checks.filter((x) => !x.pass)) console.log(`    ${c.blocking ? 'FAIL' : 'warn'} ${c.name}: ${c.detail}`)
  for (const w of docs.warnings) console.log(`    warn: ${w}`)

  // 6. Cover letter.
  console.log('\n[letter] writing')
  const contact = contactFromParagraphMap(mem.bank.masterDocument?.paragraph_map ?? [])
  const name = mem.model.name ?? 'Zuyu Liu'
  const research = intel.research
  const letter = await generateCoverLetter({
    bank: mem.bank, job, ctx, run, output: { kind: 'dir', dir: out }, persist: null,
    // The gate's company pool: name + grounded points + FACT claims. The
    // summary and INFERENCE claims are shown to the writer but are not citable.
    research: {
      points: research ? groundedPoints(research).map((p) => ({ id: p.id, text: p.text })) : [],
      summary: research?.summary ?? '',
      factClaims: research ? research.claims.filter((c) => c.type === 'FACT').map((c) => c.claim) : [],
      domain: null,
    },
    evidenceMap: intel.evidenceMap ?? { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
    user: { name, email: contact.email ?? '', phone: contact.phone ?? '', linkedin: contact.linkedin },
    onStep: (s) => console.log(`  attempt ${s.attempt}: ${s.detail}`),
  })
  for (const e of letter.errors) console.log(`  error: ${e}`)
  const g = letter.letter.grounding
  if (letter.onePageRetried) console.log(`  one-page retry: first draft ${letter.onePageRetryFrom} words rendered past one page`)
  console.log(`  ${letter.letter.wordCount ?? '-'} words · ${letter.letter.attempts} attempt(s) · grounding ${g ? (g.ok ? 'ok' : `${g.blocking.length} BLOCKING`) : '-'} · ${g?.warnings.length ?? 0} warning(s) · ${letter.flagged ? 'FLAGGED' : 'clean'}`)
  for (const f of g?.blocking ?? []) console.log(`    blocking ${f.kind}: "${f.span}" — ${f.reason}`)
  for (const f of g?.warnings ?? []) console.log(`    warn ${f.kind}: "${f.span}" — ${f.reason}`)
  if (letter.letter.fullText) console.log(`\n${letter.letter.fullText.split('\n').map((l) => `  ${l}`).join('\n')}`)
  if (letter.documents) {
    console.log(`\n  ${letter.documents.docxPath ?? '-'}\n  ${letter.documents.pdfPath ?? '(no PDF)'}\n  QA ${letter.documents.qa.ok ? 'ok' : 'FAILED'} · pages ${letter.documents.qa.page_count ?? '-'}`)
    for (const c of letter.documents.qa.checks.filter((x) => !x.pass)) console.log(`    ${c.blocking ? 'FAIL' : 'warn'} ${c.name}: ${c.detail}`)
  }

  console.log(`\nTOTAL: ${money(run.costUsd() + mem.costUsd)} across ${run.agentCalls()} agent calls · ${Math.round((Date.now() - started) / 1000)}s`)
  shutdownPdfRenderers()
  process.exitCode = docs.qa.ok || docs.qa.checks.every((c) => c.pass || !c.blocking || /^pdf_/.test(c.name)) ? 0 : 1
}

async function main(): Promise<void> {
  const jobId = opt('job')
  if (jobId) await dbMode(jobId)
  else await noDbMode()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
