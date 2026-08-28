// Deterministic checks for the application package layer. OFFLINE — no keys.
//
//   npx tsx scripts/test-career-package.ts
//
// Exercises the real master résumé (./Zuyu_Resume.docx, untracked) through
// the memory bank, the change → paragraph bridge, the review rules with a
// stubbed verifier, the package view shaping, and a real DOCX build. When a
// PDF renderer is installed the page count is asserted too; without one the
// PDF checks are reported as unavailable and the DOCX half still runs.
// Outputs land under .career-out/test/package (gitignored).

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { shrinkStrategies } from '../lib/career/documents/fit-page'
import { selectPdfRenderer, shutdownPdfRenderers } from '../lib/career/documents/pdf'
import { stripMarkdown } from '../lib/career/documents/docx-read'
import { buildMemoryBank } from '../lib/career/evidence/memory-bank'
import { fitJobInputFrom, letterPointsFromFacts, researchFromStored } from '../lib/career/intelligence/load'
import { evidenceVersion, researchIsFresh } from '../lib/career/intelligence/orchestrator'
import { evidenceMapRow } from '../lib/career/intelligence/persist'
import { letterResearchFor } from '../lib/career/package/orchestrator'
import { contactFromParagraphMap, letterJobSummary, splitLetterText } from '../lib/career/package/letter'
import { buildDocumentPatch, droppedByShrink, generateResumeDocuments, type ChangeWithId } from '../lib/career/package/resume'
import { safeToApprove } from '../lib/career/package/review'
import { downloadUrl, shapePackageView } from '../lib/career/package/view'
import { applyReviewDecisions, verifyEditedText, type TailorDeps } from '../lib/career/tailor/pipeline'
import type { AgentResult, ToolContext } from '../lib/agents/runtime/types'
import type { ResumeFactVerifierOutput } from '../lib/agents/resume-fact-verifier'
import type { ApplicationPackage, CoverLetter, EvidenceBank, JobFitEvaluation, JobOpportunity, ResumeBullet, ResumePatch, ResumePatchChange } from '../lib/career/types'

const MASTER = path.resolve('Zuyu_Resume.docx')
const OUT = path.resolve('.career-out', 'test', 'package')
const USER = 'test-user'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CTX: ToolContext = { user_id: USER, run_id: null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 3 } }

let failures = 0
let count = 0
function check(name: string, ok: boolean, detail = '') {
  count++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function change(over: Partial<ChangeWithId> & { experience_id: string }): ChangeWithId {
  return {
    bullet_id: null, change_type: 'reword', edit_level: 2, original_text: null, proposed_text: null, source_bullet_id: null, position: 0,
    reason: 'test', job_requirement: 'test', evidence_fact_ids: [], confidence: 0.8, verification_result: 'SUPPORTED', verification_notes: null,
    verification_clauses: null, precheck_findings: null, review_status: 'approved', final_text: null, ...over,
  }
}

function stubVerifier(overall: 'SUPPORTED' | 'UNSUPPORTED'): TailorDeps['verifier'] {
  return async (input) => {
    const output: ResumeFactVerifierOutput = {
      clauses: [{ clause: input.proposed_text, verdict: overall, fact_ids: [], note: overall === 'SUPPORTED' ? '' : 'stub says no' }],
      overall, notes: 'stub', dropped_fact_ids: 0,
    }
    const r: AgentResult<ResumeFactVerifierOutput> = {
      output, status: 'succeeded', error: null, evidence: [],
      trace: { agent_id: 'resume_fact_verifier', prompt_version: 'stub', model: 'stub', model_role: 'reasoning', provider_id: 'stub', tools_called: [], web_searches: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0, steps: 1 },
    }
    return r
  }
}

function bulletsOf(bank: EvidenceBank, expId: string): ResumeBullet[] {
  return bank.bullets.filter((b) => b.experience_id === expId && b.is_on_master).sort((a, b) => a.display_order - b.display_order)
}

async function main(): Promise<void> {
  if (!fs.existsSync(MASTER)) {
    console.error(`master résumé not found at ${MASTER}`)
    process.exit(2)
  }
  const docx = fs.readFileSync(MASTER)
  fs.rmSync(OUT, { recursive: true, force: true })

  // ─── (d) memory bank ───
  console.log('memory bank (skipAgent)')
  const { bank, model } = await buildMemoryBank({ userId: USER, docx, filename: 'Zuyu_Resume.docx', skipAgent: true })
  const modelBullets = model.experiences.flatMap((e) => e.bulletParagraphIndexes)
  check('experiences derived', bank.experiences.length >= model.experiences.length, `${bank.experiences.length}`)
  check('every id is a uuid', [...bank.experiences, ...bank.bullets].every((r) => UUID.test(r.id)))
  check('bullet count matches the model', bank.bullets.length === modelBullets.length, `${bank.bullets.length} vs ${modelBullets.length}`)
  check('bullet paragraph indexes match the model', bank.bullets.every((b) => modelBullets.includes(b.paragraph_index as number)))
  check('every bullet belongs to a known experience', bank.bullets.every((b) => bank.experiences.some((e) => e.id === b.experience_id)))
  const map = bank.masterDocument?.paragraph_map ?? []
  check('paragraph map stamps every bullet id', bank.bullets.every((b) => map.some((e) => e.bullet_id === b.id && e.index === b.paragraph_index)))
  check('master sha256 is the file hash', bank.masterDocument?.sha256 === crypto.createHash('sha256').update(docx).digest('hex'))
  check('bullet text matches the map text', bank.bullets.every((b) => map.find((e) => e.index === b.paragraph_index)?.text === b.text))
  check('evidenceVersion is stable', evidenceVersion(bank) === evidenceVersion(bank) && evidenceVersion(bank).length === 16)

  // ─── (a) document patch ───
  console.log('buildDocumentPatch')
  const exp = bank.experiences.find((e) => bulletsOf(bank, e.id).length >= 2)
  if (!exp) throw new Error('no experience with two bullets')
  const [b0, b1] = bulletsOf(bank, exp.id)
  const last = bulletsOf(bank, exp.id).slice(-1)[0]
  const key = map.find((e) => e.bullet_id === b0.id)?.experience_key as string

  const reword = change({ id: 'c-reword', bullet_id: b0.id, experience_id: exp.id, original_text: b0.text, proposed_text: `${b0.text} extra`, final_text: `${b0.text} extra` })
  let r = buildDocumentPatch(bank, [reword])
  check('reword → replace at the bullet paragraph index', r.patch.bullets[0]?.action === 'replace' && r.patch.bullets[0].paragraphIndex === b0.paragraph_index, JSON.stringify(r.patch.bullets[0]))
  check('reword carries the experience key from the map', r.patch.bullets[0]?.experienceKey === key)
  check('reword uses final_text', r.patch.bullets[0]?.text === `${b0.text} extra`)
  check('no bulletOrder when order is unchanged', r.patch.bulletOrder === undefined)

  const added = change({ id: 'c-new', change_type: 'new', edit_level: 4, experience_id: exp.id, proposed_text: 'New bullet', final_text: 'New bullet', position: 9 })
  r = buildDocumentPatch(bank, [added])
  check('new → insert after the experience\'s last bullet', r.patch.bullets[0]?.action === 'insert' && r.patch.bullets[0].afterParagraphIndex === last.paragraph_index, JSON.stringify(r.patch.bullets[0]))
  check('insert order is the proposed position', r.patch.bullets[0]?.order === 9)

  const swap0 = change({ id: 'r0', change_type: 'reorder', edit_level: 1, bullet_id: b0.id, experience_id: exp.id, position: 1, final_text: b0.text })
  const swap1 = change({ id: 'r1', change_type: 'reorder', edit_level: 1, bullet_id: b1.id, experience_id: exp.id, position: 0, final_text: b1.text })
  r = buildDocumentPatch(bank, [swap0, swap1])
  const order = r.patch.bulletOrder?.[key] ?? []
  check('reorder → bulletOrder swaps the first two originals', order[0] === b1.paragraph_index && order[1] === b0.paragraph_index, JSON.stringify(order))
  check('reorder emits no bullet edits', r.patch.bullets.length === 0)

  const removed = change({ id: 'c-rm', change_type: 'remove', edit_level: 1, bullet_id: b1.id, experience_id: exp.id })
  r = buildDocumentPatch(bank, [removed])
  check('remove → remove at the bullet paragraph index', r.patch.bullets[0]?.action === 'remove' && r.patch.bullets[0].paragraphIndex === b1.paragraph_index)

  r = buildDocumentPatch(bank, [{ ...reword, review_status: 'pending' }, { ...added, review_status: 'rejected' }, { ...removed, review_status: 'auto_rejected' }])
  check('pending / rejected / auto_rejected changes are NOT applied', r.patch.bullets.length === 0 && r.applied.length === 0)
  check('pending applies when onlyApproved is off (preview)', buildDocumentPatch(bank, [{ ...reword, review_status: 'pending' }], { onlyApproved: false }).patch.bullets.length === 1)
  r = buildDocumentPatch(bank, [change({ id: 'c-bad', bullet_id: 'nope', experience_id: exp.id, final_text: 'x' })])
  check('unknown bullet id is reported, not thrown', r.skipped.length === 1 && r.skipped[0].change_id === 'c-bad', r.skipped[0]?.reason)
  check('keep (restored by shrink) is a no-op', buildDocumentPatch(bank, [{ ...reword, change_type: 'keep', edit_level: 0 }]).patch.bullets.length === 0)

  // shrink accounting: a shorter original gets restored, a Level-4 addition gets dropped
  const set = [reword, added]
  const strategies = shrinkStrategies(set)
  const restoredSet = strategies.find((s) => s.some((c) => c.change_type === 'keep'))
  const droppedSet = strategies.find((s) => s.length < set.length)
  check('shrink: restored reword is reported as dropped', restoredSet !== undefined && droppedByShrink(set, restoredSet).includes('c-reword'), JSON.stringify(restoredSet && droppedByShrink(set, restoredSet)))
  check('shrink: dropped L4 addition is reported as dropped', droppedSet !== undefined && droppedByShrink(set, droppedSet).includes('c-new'), JSON.stringify(droppedSet && droppedByShrink(set, droppedSet)))
  check('shrink: unchanged set reports nothing dropped', droppedByShrink(set, set).length === 0)

  // ─── (c) review ───
  console.log('review')
  const pending = (over: Partial<ChangeWithId>) => change({ ...reword, review_status: 'pending', ...over } as Partial<ChangeWithId> & { experience_id: string })
  const rows: ChangeWithId[] = [
    pending({ id: 's1' }),
    pending({ id: 's2', verification_result: 'UNSUPPORTED', review_status: 'auto_rejected' }),
    pending({ id: 's3', verification_result: 'UNCERTAIN' }),
    pending({ id: 's4', change_type: 'new', edit_level: 4, bullet_id: null }),
    pending({ id: 's5', review_status: 'approved' }),
    pending({ id: 's6', change_type: 'reorder', edit_level: 1 }),
  ]
  const safe = safeToApprove(rows).map((d) => d.id)
  check('approveAllSafe approves pending SUPPORTED ≤ L3', safe.includes('s1') && safe.includes('s6'), safe.join(','))
  check('approveAllSafe skips UNSUPPORTED / UNCERTAIN', !safe.includes('s2') && !safe.includes('s3'))
  check('approveAllSafe skips Level 4', !safe.includes('s4'))
  check('approveAllSafe skips already-decided changes', !safe.includes('s5'))
  const applied = await applyReviewDecisions(rows, safeToApprove(rows))
  check('applyReviewDecisions marks them approved', applied.changes.filter((c) => c.review_status === 'approved').length === 3 && applied.refused.length === 0)

  const editText = stripMarkdown(b0.text).replace(/\band\b/, 'plus')
  const verify = (verifier: TailorDeps['verifier']) => (c: ChangeWithId, text: string) => verifyEditedText(bank, c, text, CTX, { deps: { verifier } })
  const edited = await applyReviewDecisions([pending({ id: 'e1' })], [{ id: 'e1', action: 'edit', text: editText }], { verifyEdit: verify(stubVerifier('SUPPORTED')) })
  check('edit → verified SUPPORTED → edited with the new text', edited.changes[0].review_status === 'edited' && edited.changes[0].final_text === editText, `${edited.changes[0].review_status}: ${edited.changes[0].verification_notes}`)
  const refusedEdit = await applyReviewDecisions([pending({ id: 'e2' })], [{ id: 'e2', action: 'edit', text: editText }], { verifyEdit: verify(stubVerifier('UNSUPPORTED')) })
  check('edit → UNSUPPORTED → auto_rejected, original kept', refusedEdit.changes[0].review_status === 'auto_rejected' && refusedEdit.changes[0].final_text === b0.text)
  const noApprove = await applyReviewDecisions([pending({ id: 'e3', verification_result: 'UNSUPPORTED' })], [{ id: 'e3', action: 'approve' }])
  check('approving an UNSUPPORTED change is refused', noApprove.refused.length === 1)

  // ─── (b) package view ───
  console.log('packageView shaping')
  const now = new Date().toISOString()
  const job = { id: 'job-1', user_id: USER, company_name: 'Acme Robotics, Inc.', title: 'Process Engineering Intern', location_raw: 'Austin, TX', canonical_url: 'https://x', apply_url: null, verification_status: 'VERIFIED_OPEN', deadline: null, employment_type: 'internship', season_relevance: 'summer_2027', work_mode: 'onsite', description_text: 'x'.repeat(5000), min_qualifications: [], preferred_qualifications: [], skills: [], responsibilities: [] } as unknown as JobOpportunity
  const pkg = { id: 'pkg-1', user_id: USER, job_id: 'job-1', application_id: 'app-1', version: 2, status: 'ready_for_review', stage: 'documents', run_id: null, resume_patch_id: 'patch-1', cover_letter_id: 'cl-1', resume_docx_path: `local:${USER}/packages/pkg-1/v2/Zuyu_Liu_Acme_Robotics_Resume.docx`, resume_pdf_path: null, cover_docx_path: null, cover_pdf_path: null, resume_filename: 'Zuyu_Liu_Acme_Robotics_Resume.docx', cover_filename: null, qa: { resume: { ok: true }, cover_letter: null }, company_research_snapshot: { summary: 'They build robots.', why_interesting_for_intern: [{ point: 'grounded point', grounded: true }, { point: 'ungrounded', grounded: false }], uncertainties: ['size'] }, fit_snapshot: null, evidence_map_snapshot: null, warm_paths_snapshot: null, job_snapshot_id: null, cost_usd: '0.1234', error: null, approved_at: null, created_at: now, updated_at: now } as unknown as ApplicationPackage
  const fit = { id: 'fit-1', user_id: USER, job_id: 'job-1', mission_id: null, components: [{ dimension: 'role_fit', score: 0.8, explanation: 'good', evidence: [] }], weights_used: {}, overall: '0.7100', feedback_adjustment: '0', eligibility: 'QUALIFIED', eligibility_reasoning: 'yes', explanation: 'fits', uncertainties: [], red_flags: [], missing_qualifications: [], confidence: 0.8, prompt_version: '1.0.0', agent_run_id: null, computed_at: now } as unknown as JobFitEvaluation
  const patchRow = { id: 'patch-1', user_id: USER, job_id: 'job-1', package_id: 'pkg-1', base_resume_document_id: null, status: 'reviewed', no_change_reason: null, summary: 'two tweaks', edit_distance: '0.0500', tailor_version: '1', verifier_version: '1', agent_run_id: null, created_at: now, updated_at: now } as unknown as ResumePatch
  const changeRow = { id: 'ch-1', patch_id: 'patch-1', bullet_id: b0.id, experience_id: exp.id, change_type: 'reword', edit_level: 2, original_text: b0.text, proposed_text: 'p', source_bullet_id: null, position: 0, reason: 'r', job_requirement: 'j', evidence_fact_ids: ['missing-fact'], confidence: '0.80', verification_result: 'SUPPORTED', verification_notes: null, verification_clauses: null, precheck_findings: null, review_status: 'approved', final_text: 'p', created_at: now, updated_at: now } as unknown as ResumePatchChange
  const letter = { id: 'cl-1', user_id: USER, job_id: 'job-1', package_id: 'pkg-1', version: 1, greeting: 'Dear Team,', paragraphs: ['a', 'b', 'c'], closing: 'Sincerely,', full_text: 'x', edited_text: null, word_count: 3, claims: [], grounding: { ok: true, blocking: [], warnings: [] }, review_status: 'pending', prompt_version: '1', agent_run_id: null, created_at: now, updated_at: now } as unknown as CoverLetter
  const view = shapePackageView({
    pkg, job, bank, fit, evidenceMap: { id: 'em', user_id: USER, job_id: 'job-1', why_i_fit: 'because', top_experience_ids: [exp.id], fact_ids: [], metric_ids: [], skill_ids: [], story_ids: [], gaps: ['g'], best_differentiator: 'd', emphasize: [], do_not_claim: ['x'], prompt_version: '1', agent_run_id: null, created_at: now },
    research: { summary: 'They build robots.', facts: [{ id: 'rf-1', claim: 'Founded 2019', type: 'FACT', source_url: 'https://acme.example' }], snapshot: pkg.company_research_snapshot },
    warmPaths: [], patch: { patch: patchRow, changes: [changeRow] }, letter, application: { id: 'app-1', state: 'READY_FOR_REVIEW', locked: false } as never,
  }) as Record<string, any>
  check('view: package basics', view.package.id === 'pkg-1' && view.package.version === 2 && view.cost_usd === 0.1234 && view.status === 'ready_for_review')
  check('view: fit overall is a number with a band and labels', view.fit.overall === 0.71 && view.fit.band === 'GOOD' && view.fit.components[0].label === 'Role fit')
  check('view: research grounded points only', view.company_research.grounded_points.length === 1 && view.company_research.facts[0].source_url === 'https://acme.example')
  check('view: evidence map resolves experience labels', view.evidence_map.top_experiences[0].label.includes(exp.organization))
  check('view: change carries experience label and unresolved evidence is labelled', view.resume.changes[0].experience_label.includes(exp.title) && /not in the approved bank/.test(view.resume.changes[0].evidence[0].statement))
  check('view: edit_distance and confidence are numbers', view.resume.patch.edit_distance === 0.05 && view.resume.changes[0].confidence === 0.8)
  check('view: documents carry download urls, absent ones are null', view.documents.resume_docx.download_url === downloadUrl(pkg.resume_docx_path) && view.documents.resume_pdf === null)
  check('view: download url encodes the path', (downloadUrl('local:u/a b.docx') as string).includes('local%3Au%2Fa%20b.docx'))
  check('view: cover letter and application shaped', view.cover_letter.paragraphs.length === 3 && view.application.state === 'READY_FOR_REVIEW')

  // ─── helpers ───
  console.log('helpers')
  check('fitJobInputFrom trims the description to 3000', fitJobInputFrom(job).description_excerpt.length === 3000)
  const split = splitLetterText('Dear Hiring Manager,\n\nPara one.\n\nPara two.\n\nSincerely,\n\nZuyu Liu', 'Zuyu Liu')
  check('splitLetterText recovers greeting / paragraphs / closing', split.greeting === 'Dear Hiring Manager,' && split.paragraphs.length === 2 && split.closing === 'Sincerely,', JSON.stringify(split))
  const contact = contactFromParagraphMap([{ index: 1, kind: 'contact', text: 'zuyu@example.com | (217) 555-0100 | linkedin.com/in/zuyu-liu' }])
  check('contactFromParagraphMap parses email, phone, linkedin', contact.email === 'zuyu@example.com' && contact.phone === '(217) 555-0100' && contact.linkedin === 'linkedin.com/in/zuyu-liu', JSON.stringify(contact))
  check('letterJobSummary prefers responsibilities', letterJobSummary({ title: 't', company_name: 'c', location_raw: null, description_text: 'desc', responsibilities: ['a', 'b'] }) === 'a; b')
  check('researchIsFresh: recent + same version', researchIsFresh({ researched_at: new Date().toISOString(), research_version: '1.0.0' }))
  check('researchIsFresh: stale after 30 days', !researchIsFresh({ researched_at: new Date(Date.now() - 31 * 86_400_000).toISOString(), research_version: '1.0.0' }))
  check('researchIsFresh: version mismatch', !researchIsFresh({ researched_at: new Date().toISOString(), research_version: '0.9.0' }))
  const facts = [{ id: 'f1', claim: 'FACT one', type: 'FACT' as const, source_url: 'https://a', source_title: null, confidence: 0.9, relevance: null, created_at: now }, { id: 'f2', claim: 'guess', type: 'INFERENCE' as const, source_url: null, source_title: null, confidence: 0.5, relevance: null, created_at: now }]
  check('letterPointsFromFacts keeps sourced FACTs only', letterPointsFromFacts(facts).length === 1 && letterPointsFromFacts(facts)[0].id === 'f1')
  const stored = researchFromStored('sum', null, facts)
  check('researchFromStored rebuilds claims and grounded points', stored?.claims.length === 2 && stored.why_interesting_for_intern.length === 1 && stored.why_interesting_for_intern[0].grounded)
  check('researchFromStored is null with nothing stored', researchFromStored(null, null, []) === null)

  // ─── persistence shapes (column sets pinned; the DB is the only other thing that checks them) ───
  console.log('persistence shapes')
  const mapRow = evidenceMapRow({ userId: USER, jobId: 'job-1', promptVersion: '1.0.0', agentRunId: null, match: { why_i_fit: 'w', top_experience_ids: [], fact_ids: [], metric_ids: [], skill_ids: [], story_ids: [], gaps: [], best_differentiator: 'd', emphasize: [], do_not_claim: [], no_gaps_reason: 'none', ungrounded_ids: 2 } })
  const MAP_COLUMNS = ['user_id', 'job_id', 'why_i_fit', 'top_experience_ids', 'fact_ids', 'metric_ids', 'skill_ids', 'story_ids', 'gaps', 'best_differentiator', 'emphasize', 'do_not_claim', 'prompt_version', 'agent_run_id']
  check('job_evidence_maps row carries only real columns', Object.keys(mapRow).every((k) => MAP_COLUMNS.includes(k)), Object.keys(mapRow).filter((k) => !MAP_COLUMNS.includes(k)).join(','))
  const snapPkg = { company_research_snapshot: { summary: 'snap summary', why_interesting_for_intern: [{ point: 'grounded point', claim_refs: [0], grounded: true }, { point: 'loose', claim_refs: [], grounded: false }], claims: [{ claim: 'c', type: 'FACT', source_url: 'https://a', source_title: null, confidence: 1, relevance: null }] } } as unknown as ApplicationPackage
  const noFacts = letterResearchFor({ existing: { research: { summary: null, facts: [] } } } as never, snapPkg)
  check('letterResearchFor falls back to the snapshot grounded points', noFacts.points.length === 1 && noFacts.points[0].text === 'grounded point' && noFacts.summary === 'snap summary', JSON.stringify(noFacts))
  const withFacts = letterResearchFor({ existing: { research: { summary: 'sum', facts } } } as never, snapPkg)
  check('letterResearchFor prefers stored facts by row id', withFacts.points.length === 1 && withFacts.points[0].id === 'f1' && withFacts.summary === 'sum')

  // ─── (e) documents ───
  console.log('generateResumeDocuments (dir mode)')
  const renderer = await selectPdfRenderer()
  console.log(`  renderer: ${renderer?.id ?? 'none (PDF checks unavailable)'}`)
  const other = bank.experiences.find((e) => e.id !== exp.id && bulletsOf(bank, e.id).length >= 1)
  const ob = other ? bulletsOf(bank, other.id)[0] : b1
  const twoBullets: ChangeWithId[] = [
    change({ id: 'd1', bullet_id: b0.id, experience_id: exp.id, original_text: b0.text, proposed_text: `${b0.text} Also verified.`, final_text: `${b0.text} Also verified.` }),
    change({ id: 'd2', bullet_id: ob.id, experience_id: ob.experience_id as string, original_text: ob.text, proposed_text: ob.text.replace(/\.$/, '') + ' (tailored).', final_text: ob.text.replace(/\.$/, '') + ' (tailored).' }),
    change({ id: 'd3', bullet_id: b1.id, experience_id: exp.id, original_text: b1.text, proposed_text: `${b1.text} pending`, final_text: `${b1.text} pending`, review_status: 'pending' }),
  ]
  const docs = await generateResumeDocuments({ bank, masterBuffer: docx, changes: twoBullets, company: 'Acme Robotics, Inc.', output: { kind: 'dir', dir: OUT } })
  check('docx produced', docs.docxPath !== null && fs.existsSync(docs.docxPath as string), docs.error ?? docs.docxPath ?? '')
  check('filename follows the pattern', docs.filenames.docx === 'Zuyu_Liu_Acme_Robotics_Resume.docx')
  const failing = docs.qa.checks.filter((c) => !c.pass && c.blocking && !/^pdf_/.test(c.name))
  check('non-PDF QA checks pass', failing.length === 0, failing.map((c) => `${c.name}: ${c.detail}`).join(' | '))
  check('content_match sees both approved bullets', docs.qa.checks.find((c) => c.name === 'content_match')?.pass === true, docs.qa.checks.find((c) => c.name === 'content_match')?.detail)
  const { extractBulletTexts } = await import('../lib/career/documents/docx')
  const produced = await extractBulletTexts(fs.readFileSync(docs.docxPath as string))
  check('pending change did not reach the document', !produced.some((p) => /pending$/.test(p.text)))
  check('approved change is in the document', produced.some((p) => /Also verified\./.test(p.text)))
  if (renderer) {
    check('pdf produced and one page', docs.pdfPath !== null && docs.qa.page_count === 1, `pages=${docs.qa.page_count} shrink=${docs.shrink_attempts}`)
    check('QA ok with a renderer', docs.qa.ok, docs.qa.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join(' | '))
  } else {
    check('no renderer → warning surfaced, docx still produced', docs.warnings.some((w) => /no PDF renderer/.test(w)) && docs.pdfPath === null)
  }

  console.log(`\n${count} checks, ${failures} failed`)
  console.log(failures === 0 ? 'all package checks passed' : `${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => shutdownPdfRenderers())
