// Offline tests for the cover-letter hardening the first live run exposed:
// the citable company pool (FACT claims and grounded points only — never the
// summary, never an INFERENCE), the one-page length band, and the package
// layer's one-page retry.
//
// No network, no keys. The retry check renders through Word/LibreOffice when
// one is installed and reports 'skipped' otherwise — the page count is the
// render's to give, and a stub would only test the stub.
//
//   npx tsx scripts/test-career-letter.ts

import os from 'os'
import fs from 'fs'
import path from 'path'
import { buildFixtureBank, CTX } from './test-career-tailor'
import { DEFAULT_LENGTH, MAX_SLACK, validateCoverLetterOutput, type CoverLetterInput, type CoverLetterOutput } from '../lib/agents/cover-letter-writer'
import { coverLetterWriterPrompt } from '../lib/agents/cover-letter-writer/prompt'
import { companyPoolFor, runCoverLetterPipeline } from '../lib/career/letter/pipeline'
import { generateCoverLetter, ONE_PAGE_RETRY_LENGTH, ONE_PAGE_REVISION_NOTE, reuseCoverLetter, spilledPastOnePage } from '../lib/career/package/letter'
import { documentText, readDocx } from '../lib/career/documents/docx-read'
import { selectPdfRenderer, shutdownPdfRenderers } from '../lib/career/documents/pdf'
import type { AgentResult } from '../lib/agents/runtime/types'
import type { DocumentQaReport, ResumeDocument } from '../lib/career/types'
import { foreignProperNouns, pickInternship } from '../evals/career/cover-letter'
import { issuesAreFactual, plantFabrications } from '../evals/career/factuality'
import { alternateFromFacts } from '../evals/career/tailoring'
import type { RawJobPosting } from '../lib/career/sources/types'

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function stub(output: CoverLetterOutput): AgentResult<CoverLetterOutput> {
  return {
    output, status: 'succeeded', error: null, evidence: [],
    trace: {
      agent_id: 'cover_letter_writer', prompt_version: 'stub', model: 'stub', model_role: 'writing', provider_id: 'anthropic',
      tools_called: [], web_searches: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0, steps: 1,
    },
  }
}

const words = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')

async function main() {
  const bank = buildFixtureBank()

  // ─── the citable company pool ───
  {
    const pool = companyPoolFor(
      { company: 'Northbank Specialty Materials' },
      {
        summary: 'Northbank competes with Mitsubishi Chemical and DIC/Sun Chemical in specialty resins.',
        points: [{ id: 'point:0', text: 'Northbank opened a resin line in Newark in 2025.' }],
        factClaims: ['Northbank was founded in 2011.'],
        domain: 'northbank.example',
      }
    )
    check('pool carries the company name', pool.includes('Northbank Specialty Materials'))
    check('pool carries the domain', pool.includes('northbank.example'))
    check('pool carries grounded points and FACT claims', pool.includes('Northbank opened a resin line in Newark in 2025.') && pool.includes('Northbank was founded in 2011.'))
    check('pool never carries the summary', !pool.some((l) => /Mitsubishi/.test(l)), pool.join(' | '))
  }

  // ─── an INFERENCE-only proper noun is blocked; a FACT-backed one passes ───
  {
    const filler = words(60)
    const letter = (first: string) => stub({
      greeting: 'Dear Northbank Hiring Team,', closing: 'Sincerely,', claims: [], wordCount: 250, dropped_claims: 0,
      paragraphs: [`${first} ${filler}`, filler, filler, filler],
    })
    const base = {
      bank,
      job: { title: 'Process Engineering Intern', company: 'Northbank Specialty Materials', location: null, summary: 'Own a yield project.' },
      evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: ['png_controlled_state'] },
      ctx: CTX,
      user: { name: 'Zuyu Liu' },
    }
    // The researcher's summary and an INFERENCE name a competitor; no FACT does.
    const research = {
      summary: 'Northbank competes with Mitsubishi Chemical in specialty resins.',
      points: [{ id: 'point:0', text: 'Northbank opened a resin line in Newark in 2025.' }],
      factClaims: ['Northbank opened a resin line in Newark in 2025.'],
      // What an INFERENCE would have said — deliberately NOT passed as a factClaim.
    }
    const writer = async () => letter("Northbank's rivalry with Mitsubishi Chemical is what drew me here.")
    const r = await runCoverLetterPipeline({ ...base, companyResearch: research, deps: { writer } })
    check('inference-only proper noun is a blocking entity finding', r.flagged && r.grounding?.blocking.some((f) => f.kind === 'entity' && /Mitsubishi/.test(f.span)) === true, JSON.stringify(r.grounding?.blocking))
    check('pool stats exclude the summary line', r.grounding?.stats.companyPoolLines === 3, String(r.grounding?.stats.companyPoolLines))

    const writer2 = async () => letter('Northbank opened a resin line in Newark in 2025, and that is where I want to learn.')
    const r2 = await runCoverLetterPipeline({ ...base, companyResearch: research, deps: { writer: writer2 } })
    check('FACT-backed company statement passes the gate', r2.grounding?.ok === true, JSON.stringify(r2.grounding?.blocking))

    // ─── the posting's own vocabulary is citable; the company pool is not widened by it ───
    // The eval's Zipline letter was blocked for "GD&T" — a skill the posting asked for.
    const writerPosting = async () => letter('I want to learn GD&T and fixture design on the Platform 2 line.')
    const postingJob = { ...base.job, summary: 'Apply GD&T to fixture design.', postingText: 'Requirements: GD&T; fixture design; Platform 2 tolerances of ~1 metre.' }
    const rPosting = await runCoverLetterPipeline({ ...base, job: postingJob, companyResearch: research, deps: { writer: writerPosting } })
    check('a term from the posting is not an unknown entity', rPosting.grounding?.ok === true, JSON.stringify(rPosting.grounding?.blocking))
    check('the posting does not enter the company pool', rPosting.grounding?.stats.companyPoolLines === 3, String(rPosting.grounding?.stats.companyPoolLines))
    const r4 = await runCoverLetterPipeline({ ...base, job: postingJob, companyResearch: research, deps: { writer } })
    check('an INFERENCE-only noun is still blocked with a posting pool', r4.flagged && r4.grounding?.blocking.some((f) => /Mitsubishi/.test(f.span)) === true)

    // ─── a validator rejection is retried once with its reason ───
    const seen: CoverLetterInput[] = []
    let calls = 0
    const flaky = async (input: CoverLetterInput): Promise<AgentResult<CoverLetterOutput>> => {
      seen.push(input)
      calls++
      if (calls === 1) return { ...stub(letter('x').output!), output: null, status: 'invalid_output', error: 'submitted output failed schema validation (331 words; the band is 200–290)' }
      return letter('Northbank opened a resin line in Newark in 2025, and that is where I want to learn.')
    }
    const r5 = await runCoverLetterPipeline({ ...base, companyResearch: research, deps: { writer: flaky } })
    check('validator rejection is retried once', calls === 2 && r5.fullText !== null && r5.error === null, `${calls} calls, error ${r5.error}`)
    check('the retry carries the rejection reason as a revision note', seen[1]?.revisionNotes?.some((n) => /331 words/.test(n)) === true, JSON.stringify(seen[1]?.revisionNotes))
    check('attempts count both drafts', r5.attempts === 2, String(r5.attempts))
    const stuck = async (): Promise<AgentResult<CoverLetterOutput>> => ({ ...stub(letter('x').output!), output: null, status: 'invalid_output', error: 'submitted output failed schema validation (no claim of kind "company")' })
    const r6 = await runCoverLetterPipeline({ ...base, companyResearch: research, deps: { writer: stuck } })
    check('a second rejection is surfaced, not retried again', r6.fullText === null && r6.attempts === 2 && /no claim of kind/.test(r6.error ?? ''), `${r6.attempts} attempts, ${r6.error}`)

    // ─── the validator records why it refused ───
    const reasons: string[] = []
    const input: CoverLetterInput = { job: base.job, companyResearch: { points: [], summary: '' }, evidence: { why_i_fit: null, facts: [], stories: [] }, user: { name: 'Zuyu Liu' }, narrative: '', length: DEFAULT_LENGTH }
    validateCoverLetterOutput({ greeting: 'Dear', closing: 'Sincerely,', claims: [], paragraphs: [words(200), words(200), words(200), words(200)] }, input, reasons)
    check('validator names the word count when it rejects for length', reasons.some((r) => /800 words/.test(r)), reasons.join(' | '))

    // The same proper noun, now on a FACT claim, is citable.
    const writer3 = async () => letter("Northbank's rivalry with Mitsubishi Chemical is what drew me here.")
    const r3 = await runCoverLetterPipeline({ ...base, companyResearch: { ...research, factClaims: [...research.factClaims, 'Northbank competes with Mitsubishi Chemical.'] }, deps: { writer: writer3 } })
    check('a FACT-claim proper noun is citable', r3.grounding?.ok === true, JSON.stringify(r3.grounding?.blocking))
  }

  // ─── initial revision notes reach the writer and survive the grounding retry ───
  {
    const seen: string[][] = []
    const filler = words(60)
    const writer = async (input: CoverLetterInput) => {
      seen.push(input.revisionNotes ?? [])
      const first = seen.length === 1 ? 'Your Project Helios is why I applied.' : 'Northbank opened a resin line in Newark in 2025.'
      return stub({ greeting: 'Dear Northbank Hiring Team,', closing: 'Sincerely,', claims: [], wordCount: 250, dropped_claims: 0, paragraphs: [`${first} ${filler}`, filler, filler, filler] })
    }
    await runCoverLetterPipeline({
      bank, ctx: CTX, user: { name: 'Zuyu Liu' }, deps: { writer }, revisionNotes: [ONE_PAGE_REVISION_NOTE],
      job: { title: 'Intern', company: 'Northbank Specialty Materials', location: null, summary: 's' },
      companyResearch: { summary: '', points: [{ id: 'point:0', text: 'Northbank opened a resin line in Newark in 2025.' }] },
      evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
    })
    check('initial revision note is passed to the first draft', seen[0]?.[0] === ONE_PAGE_REVISION_NOTE, JSON.stringify(seen[0]))
    check('grounding retry keeps the initial note and adds the findings', seen.length === 2 && seen[1][0] === ONE_PAGE_REVISION_NOTE && seen[1].length === 2, JSON.stringify(seen[1]))
  }

  // ─── the applicant's name: profiles.name is the email local-part; the letter must not be ───
  {
    const master: ResumeDocument = {
      id: 'doc-1', user_id: 'u', label: 'master', is_master: true, filename: 'r.docx', storage_path: null, sha256: 'x', byte_size: 1, page_count: 1, uploaded_at: 'now',
      paragraph_map: [{ index: 0, kind: 'name', text: 'Zuyu Liu' }, { index: 1, kind: 'contact', text: 'zuyu.alex06@gmail.com' }],
    }
    const named = { ...bank, masterDocument: master }
    const filler = words(60)
    // The writer mentions the applicant by real name in the body; the gate must treat it as a safe name.
    const writer = async () => stub({
      greeting: 'Dear Northbank Hiring Team,', closing: 'Sincerely,', claims: [], wordCount: 250, dropped_claims: 0,
      paragraphs: [`Zuyu Liu is the name on my résumé. Northbank opened a resin line in Newark in 2025. ${filler}`, filler, filler, filler],
    })
    const r = await runCoverLetterPipeline({
      bank: named, ctx: CTX, user: { name: 'zuyu.alex06' }, deps: { writer },
      job: { title: 'Intern', company: 'Northbank Specialty Materials', location: null, summary: 's' },
      companyResearch: { summary: '', points: [{ id: 'point:0', text: 'Northbank opened a resin line in Newark in 2025.' }] },
      evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
    })
    check('a profile local-part is resolved to the résumé name in the signature', r.fullText !== null && r.fullText.endsWith('Zuyu Liu') && !/zuyu\.alex06/.test(r.fullText), r.fullText?.slice(-40))
    check('the real name is a safe name for the gate', r.grounding?.ok === true, JSON.stringify(r.grounding?.blocking))
    const bare = await runCoverLetterPipeline({
      bank, ctx: CTX, user: { name: 'zuyu.alex06' }, deps: { writer },
      job: { title: 'Intern', company: 'Northbank Specialty Materials', location: null, summary: 's' },
      companyResearch: { summary: '', points: [{ id: 'point:0', text: 'Northbank opened a resin line in Newark in 2025.' }] },
      evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
    })
    check('with nothing to resolve from, the signature is the fallback, never the local-part', bare.fullText !== null && !/zuyu\.alex06/.test(bare.fullText) && bare.fullText.endsWith('Applicant'), bare.fullText?.slice(-40))
  }

  // ─── the one-page band ───
  {
    check('DEFAULT_LENGTH is the one-page band', DEFAULT_LENGTH.min === 200 && DEFAULT_LENGTH.max === 290)
    check('prompt version bumped for the band change', coverLetterWriterPrompt.version !== '1.0.0', coverLetterWriterPrompt.version)
    // The summary is not citable, so the writer must not see it (1.0.2).
    const built = coverLetterWriterPrompt.build({
      job: { title: 'Intern', company: 'Rondo', location: null, summary: 'Model a heat battery.' },
      companyResearch: { summary: 'Rondo commissioned a unit in Kern County.', points: [{ id: 'p1', text: 'Rondo stores heat in brick.' }] },
      evidence: { why_i_fit: null, facts: [], stories: [] }, user: { name: 'Zuyu Liu' }, narrative: 'n', length: DEFAULT_LENGTH,
    })
    const rendered = JSON.stringify(built)
    check('the researcher summary is not rendered into the writer prompt', !/Kern County/.test(rendered) && /Rondo stores heat in brick/.test(rendered))
    check('prompt version is 1.0.2 or later', coverLetterWriterPrompt.version >= '1.0.2', coverLetterWriterPrompt.version)
    const input: CoverLetterInput = {
      job: { title: 'Intern', company: 'Acme', location: null, summary: 's' },
      companyResearch: { points: [{ id: 'rf1', text: 'Acme opened a plant' }], summary: 'Acme' },
      evidence: { why_i_fit: null, facts: [], stories: [] },
      user: { name: 'Zuyu Liu' }, narrative: 'n', length: DEFAULT_LENGTH,
    }
    const claims = [{ claim_text: 'plant', kind: 'company', research_fact_id: 'rf1', evidence_fact_id: null }]
    const at = (n: number) => validateCoverLetterOutput({ greeting: '', closing: '', claims, paragraphs: [words(n - 60), words(20, 'x'), words(20, 'y'), words(20, 'z')] }, input)
    check('validate accepts max + slack', at(DEFAULT_LENGTH.max + MAX_SLACK) !== null)
    check('validate rejects max + slack + 1', at(DEFAULT_LENGTH.max + MAX_SLACK + 1) === null)
    check('validate rejects the 377-word live letter', at(377) === null)
    check('validate rejects below min - 20', at(DEFAULT_LENGTH.min - 21) === null)
  }

  // ─── spilledPastOnePage ───
  {
    const qa = (pass: boolean, pages: number | null): DocumentQaReport => ({
      ok: pass, document: 'cover_letter', docx_path: null, pdf_path: null, page_count: pages, expected_pages: 1, renderer: pages === null ? null : 'word-com', warnings: [],
      checks: [{ name: 'one_page', pass, detail: '', blocking: pages !== null }],
    })
    check('spilled: two rendered pages', spilledPastOnePage(qa(false, 2)))
    check('not spilled: one page', !spilledPastOnePage(qa(true, 1)))
    check('not spilled: no renderer (page count unknown is not a spill)', !spilledPastOnePage(qa(false, null)))
  }

  // ─── the package layer's one-page retry, rendered for real ───
  {
    const renderer = await selectPdfRenderer()
    if (!renderer) {
      console.log('  (one-page retry check skipped — no PDF renderer installed)')
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-letter-test-'))
      const lengths: { min: number; max: number }[] = []
      const notes: string[][] = []
      const writer = async (input: CoverLetterInput) => {
        lengths.push(input.length)
        notes.push(input.revisionNotes ?? [])
        // First draft: far past one page. Second: short.
        const long = lengths.length === 1
        const p = long ? words(140, 'long') : words(45, 'short')
        return stub({ greeting: 'Dear Acme Hiring Team,', closing: 'Sincerely,', claims: [], wordCount: long ? 560 : 180, dropped_claims: 0, paragraphs: [p, p, p, p] })
      }
      const r = await generateCoverLetter({
        bank, ctx: CTX, deps: { writer }, output: { kind: 'dir', dir }, persist: null,
        job: { title: 'Intern', company_name: 'Acme', location_raw: null, description_text: 'x', responsibilities: [] },
        research: { points: [], summary: '' },
        evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
        user: { name: 'Zuyu Liu', email: 'z@example.com', phone: '', linkedin: null },
      })
      check('retry ran after a two-page render', r.onePageRetried && r.onePageRetryFrom === 560, JSON.stringify({ retried: r.onePageRetried, from: r.onePageRetryFrom, pages: r.documents?.qa.page_count }))
      check('retry used the shorter band and the one-page note', lengths[1]?.max === ONE_PAGE_RETRY_LENGTH.max && notes[1]?.[0] === ONE_PAGE_REVISION_NOTE, JSON.stringify({ lengths, notes }))
      check('the shorter draft is the one kept and it is one page', r.letter.wordCount === 180 && r.documents?.qa.page_count === 1 && !r.flagged, JSON.stringify({ words: r.letter.wordCount, pages: r.documents?.qa.page_count, flagged: r.flagged }))
      check('attempts and runs are summed across the retry', r.letter.attempts === 2 && r.letter.runs.length === 2)

      // A letter that is still two pages after the retry stays, flagged.
      const stubborn = async () => stub({ greeting: 'Dear Acme Hiring Team,', closing: 'Sincerely,', claims: [], wordCount: 560, dropped_claims: 0, paragraphs: [words(140, 'a'), words(140, 'b'), words(140, 'c'), words(140, 'd')] })
      const r2 = await generateCoverLetter({
        bank, ctx: CTX, deps: { writer: stubborn }, output: { kind: 'dir', dir: path.join(dir, 'stubborn') }, persist: null,
        job: { title: 'Intern', company_name: 'Acme', location_raw: null, description_text: 'x', responsibilities: [] },
        research: { points: [], summary: '' },
        evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
        user: { name: 'Zuyu Liu', email: 'z@example.com', phone: '', linkedin: null },
      })
      check('a still-two-page letter is kept and flagged, never discarded', r2.onePageRetried && r2.flagged && r2.documents !== null && (r2.documents.qa.page_count ?? 0) > 1 && r2.letter.fullText !== null, JSON.stringify({ pages: r2.documents?.qa.page_count, flagged: r2.flagged }))

      // ─── the rendered header and signature carry the résumé's name, not the profile local-part ───
      const master: ResumeDocument = {
        id: 'doc-1', user_id: 'u', label: 'master', is_master: true, filename: 'r.docx', storage_path: null, sha256: 'x', byte_size: 1, page_count: 1, uploaded_at: 'now',
        paragraph_map: [{ index: 0, kind: 'name', text: 'Zuyu Liu' }],
      }
      const short = async () => stub({ greeting: 'Dear Acme Hiring Team,', closing: 'Sincerely,', claims: [], wordCount: 180, dropped_claims: 0, paragraphs: [words(45, 'a'), words(45, 'b'), words(45, 'c'), words(45, 'd')] })
      const r3 = await generateCoverLetter({
        bank: { ...bank, masterDocument: master }, ctx: CTX, deps: { writer: short }, output: { kind: 'dir', dir: path.join(dir, 'named') }, persist: null,
        job: { title: 'Intern', company_name: 'Acme', location_raw: null, description_text: 'x', responsibilities: [] },
        research: { points: [], summary: '' },
        evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
        user: { name: 'zuyu.alex06', email: 'zuyu.alex06@gmail.com', phone: '', linkedin: null },
      })
      const text = r3.documents?.docxPath ? documentText(await readDocx(fs.readFileSync(r3.documents.docxPath))) : ''
      check('letter text is signed with the résumé name', r3.letter.fullText?.endsWith('Zuyu Liu') === true, r3.letter.fullText?.slice(-30))
      check('rendered DOCX header and signature carry the real name', /Zuyu Liu/.test(text) && !/\bzuyu\.alex06\b(?!@)/.test(text), text.slice(0, 80))
      check('the email address itself still appears on the contact line', /zuyu\.alex06@gmail\.com/.test(text))

      // ─── reuse: a stored letter re-rendered under the right name, no writer ───
      const stored = { greeting: 'Dear Acme Hiring Team,', paragraphs: [words(45, 'a'), words(45, 'b')], closing: 'Sincerely,', full_text: 'x', edited_text: null, word_count: 90, claims: [], grounding: { ok: true, blocking: [], warnings: [] }, review_status: 'approved' as const, prompt_version: '1' }
      const reused = await reuseCoverLetter({ stored, user: { name: 'zuyu.alex06', email: 'z@example.com', phone: '', linkedin: null }, company: 'Acme', output: { kind: 'dir', dir: path.join(dir, 'reused') }, persist: null })
      const reusedText = reused.documents.docxPath ? documentText(await readDocx(fs.readFileSync(reused.documents.docxPath))) : ''
      check('reuseCoverLetter renders without a writer and never the local-part', reused.documents.docxPath !== null && !/zuyu\.alex06/.test(reusedText) && !/zuyu\.alex06/.test(reused.fullText), reused.fullText.slice(-30))
      check('reuseCoverLetter keeps the body verbatim', reused.fullText.includes(stored.paragraphs[0]) && !reused.flagged)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  shutdownPdfRenderers()
  console.log(`\n${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`  FAIL ${f}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
