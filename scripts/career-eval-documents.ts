// The DOCUMENT QA EVAL. Generates a résumé (three bullet-length variants)
// and a cover letter for each of ten deliberately awkward company names,
// renders them through whatever PDF renderer exists, runs document QA, and
// prints a table. Exit code is non-zero on any failure — the target is 100%.
//
//   npx tsx scripts/career-eval-documents.ts
//
// Requires ./Zuyu_Resume.docx (untracked). Without a PDF renderer the PDF
// checks are reported as unavailable and the suite still runs the DOCX half.
// Outputs land under .career-out/eval/documents/ (gitignored).

import fs from 'fs'
import path from 'path'
import { selectPdfRenderer, shutdownPdfRenderers } from '../lib/career/documents/pdf'
import { BULLET_VARIANTS, COMPANY_NAMES, loadMaster, runCoverCase, runResumeCase, type CoverCaseResult, type ResumeCaseResult } from '../evals/career/documents'

const MASTER = path.resolve('Zuyu_Resume.docx')
const OUT = path.resolve('.career-out', 'eval', 'documents')

function pad(s: string | number, n: number): string {
  const t = String(s)
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length)
}

function stats(ms: number[]): string {
  if (!ms.length) return 'n/a'
  const sorted = [...ms].sort((a, b) => a - b)
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length
  return `n=${ms.length} mean=${Math.round(mean)}ms median=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted[sorted.length - 1]}ms`
}

async function main(): Promise<void> {
  if (!fs.existsSync(MASTER)) {
    console.error(`master résumé not found at ${MASTER}`)
    process.exit(2)
  }
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const master = await loadMaster(MASTER)
  const renderer = await selectPdfRenderer()
  console.log(`renderer: ${renderer?.id ?? 'none (PDF checks unavailable)'}`)
  console.log(`master: ${master.paragraphCount} paragraphs, fonts ${master.fonts.join(',')}, sizes ${master.sizes.join(',')}\n`)

  const resumes: ResumeCaseResult[] = []
  const covers: CoverCaseResult[] = []
  const t0 = Date.now()
  for (const company of COMPANY_NAMES) {
    for (const variant of BULLET_VARIANTS) {
      const r = await runResumeCase(master, company, variant, OUT, renderer)
      resumes.push(r)
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${pad(company, 34)} ${pad(variant, 7)} pages=${r.pageCount ?? '-'} shrink=${r.shrinkAttempts} render=${r.renderMs.map((m) => `${m}ms`).join('/') || '-'}  ${r.filename}`)
      for (const f of r.failedChecks) console.log(`       ${f}`)
    }
    const c = await runCoverCase(company, OUT, renderer)
    covers.push(c)
    console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${pad(company, 34)} ${pad('cover', 7)} pages=${c.pageCount ?? '-'}          render=${c.renderMs !== null ? `${c.renderMs}ms` : '-'}  ${c.filename}`)
    for (const f of c.failedChecks) console.log(`       ${f}`)
  }
  const wall = Date.now() - t0

  const resumeOk = resumes.filter((r) => r.ok).length
  const coverOk = covers.filter((c) => c.ok).length
  const allRenders = [...resumes.flatMap((r) => r.renderMs), ...covers.map((c) => c.renderMs).filter((m): m is number => m !== null)]
  const overflowed = resumes.filter((r) => r.shrinkAttempts > 0)

  console.log('\n── summary ──')
  console.log(`résumés      ${resumeOk}/${resumes.length} ok`)
  console.log(`cover letters ${coverOk}/${covers.length} ok`)
  console.log(`one page      ${resumes.filter((r) => r.pageCount === 1).length}/${resumes.length} résumés, ${covers.filter((c) => c.pageCount === 1).length}/${covers.length} letters`)
  console.log(`shrink loop   ${overflowed.length} résumé(s) needed shrinking: ${overflowed.map((r) => `${r.variant}@${r.company.slice(0, 12)}×${r.shrinkAttempts}`).join(', ') || 'none'}`)
  console.log(`render latency ${stats(allRenders)} (first render includes Word warm-up)`)
  console.log(`wall          ${Math.round(wall / 1000)}s for ${resumes.length + covers.length} documents`)

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ renderer: renderer?.id ?? null, resumes, covers, wallMs: wall }, null, 2))

  shutdownPdfRenderers()
  if (resumeOk !== resumes.length || coverOk !== covers.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  shutdownPdfRenderers()
  process.exit(1)
})
