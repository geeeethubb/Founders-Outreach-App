// Tests for the document engine: DOCX patching on the real master, cover
// letter build, PDF rendering, QA, filenames and the one-page fix loop.
//
// Offline wherever possible. The master résumé (./Zuyu_Resume.docx, untracked)
// is required for the patch tests; PDF steps run only when a renderer exists
// and print "skipped" otherwise, so the deterministic half runs anywhere.
//   npx tsx scripts/test-career-documents.ts

import fs from 'fs'
import path from 'path'
import { applyResumePatch, extractBulletTexts, parseMarkdownSegments, renderMarkdownRuns, deriveBoldRPr, type BulletEdit } from '../lib/career/documents/docx'
import { readDocx, fontsUsed, fontSizesUsed, sectPrOf, parseRuns, documentText } from '../lib/career/documents/docx-read'
import { buildResumeModel } from '../lib/career/documents/resume-model'
import { buildCoverLetterDocx } from '../lib/career/documents/cover-letter-docx'
import { renderDocxToPdf, selectPdfRenderer, shutdownPdfRenderers, sweepRenderScratch } from '../lib/career/documents/pdf'
import { pdfInfo } from '../lib/career/documents/pdf-text'
import { qaResumeDocument, qaCoverLetterDocument, normalizeText, xmlLooksWellFormed } from '../lib/career/documents/qa'
import { sanitizeCompanyForFilename, resumeFilenames, coverLetterFilenames } from '../lib/career/documents/filenames'
import { fitToOnePage, shrinkStrategies, type ShrinkableChange } from '../lib/career/documents/fit-page'
import { tmpRoot } from '../lib/career/documents/tmp'

let passed = 0
let failed = 0
let skipped = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(name: string, why: string): void {
  skipped++
  console.log(`  skipped ${name} (${why})`)
}

const MASTER = path.resolve('Zuyu_Resume.docx')
const OUT = path.resolve('.career-out', 'test')
fs.mkdirSync(OUT, { recursive: true })

const PNG = 'procter-and-gamble-tabler-station__quality-assurance-intern'
const IBC = 'illinois-business-consulting__project-manager-prev-senior-consultant'

async function main(): Promise<void> {
  // ── Pure helpers ───────────────────────────────────────────────────────────
  console.log('markdown runs')
  check('segments', JSON.stringify(parseMarkdownSegments('a **b** c')) === JSON.stringify([{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false }]))
  const base = '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="19"/></w:rPr>'
  check('bold rPr after rFonts', deriveBoldRPr(base) === '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:bCs/><w:sz w:val="19"/></w:rPr>')
  check('bold rPr no rFonts', deriveBoldRPr('<w:rPr><w:sz w:val="19"/></w:rPr>') === '<w:rPr><w:b/><w:bCs/><w:sz w:val="19"/></w:rPr>')
  check('bold rPr empty', deriveBoldRPr('') === '<w:rPr><w:b/><w:bCs/></w:rPr>')
  const runs = renderMarkdownRuns('x & **y<z**', base, deriveBoldRPr(base))
  check('runs escaped', runs.includes('x &amp; ') && runs.includes('y&lt;z'))
  check('runs count', parseRuns(`<w:p>${runs}</w:p>`).length === 2)
  check('runs bold', parseRuns(`<w:p>${runs}</w:p>`)[1].bold === true)

  console.log('filenames')
  const fnCases: [string, string][] = [
    ['Procter & Gamble', 'Procter_and_Gamble'],
    ['3M', '3M'],
    ['AT&T', 'AT_and_T'],
    ['Anduril Industries, Inc.', 'Anduril_Industries'],
    ['Nestlé', 'Nestle'],
    ["L'Oréal USA", 'LOreal_USA'],
    ['Schlumberger (SLB)', 'Schlumberger_SLB'],
    ['Foo Holdings Co., Ltd.', 'Foo_Holdings'],
    ['Acme/Beta LLC', 'Acme-Beta'],
    ['Rolls-Royce plc', 'Rolls-Royce'],
    ['', 'Company'],
    ['   ', 'Company'],
  ]
  for (const [inp, exp] of fnCases) check(`sanitize ${JSON.stringify(inp)}`, sanitizeCompanyForFilename(inp) === exp, `got ${sanitizeCompanyForFilename(inp)}`)
  const long = sanitizeCompanyForFilename('A'.repeat(50) + ' ' + 'B'.repeat(40) + ' Corp')
  check('long name capped', long.length <= 40 && !long.endsWith('_'), long)
  const ninety = sanitizeCompanyForFilename('A very long company name that goes on and on and on for testing purposes and more words LLC')
  check('90-char name capped at 40', ninety.length <= 40 && ninety.startsWith('A_very_long'), ninety)
  check('resume filenames', resumeFilenames('Procter & Gamble').docx === 'Zuyu_Liu_Procter_and_Gamble_Resume.docx' && resumeFilenames('Procter & Gamble').pdf === 'Zuyu_Liu_Procter_and_Gamble_Resume.pdf')
  check('cover filenames', coverLetterFilenames('3M').docx === 'Zuyu_Liu_3M_Cover_Letter.docx')

  console.log('normalize / well-formed')
  check('normalize quotes dashes', normalizeText('“a” – b­ c') === '"a" - b c')
  check('wellformed ok', xmlLooksWellFormed('<w:body><w:p><w:r><w:t>x</w:t></w:r></w:p><w:sectPr/></w:body>').ok)
  check('wellformed bad', !xmlLooksWellFormed('<w:body><w:p><w:r><w:t>x</w:t></w:p></w:body>').ok)

  console.log('shrink strategies')
  const changes: (ShrinkableChange & { key: string })[] = [
    { key: 'r1', change_type: 'reword', edit_level: 2, original_text: 'short', proposed_text: 'a much longer rewording of the bullet', confidence: 0.9 },
    { key: 'r2', change_type: 'reword', edit_level: 2, original_text: 'a long original text here', proposed_text: 'tight', confidence: 0.9 },
    { key: 'n1', change_type: 'new', edit_level: 4, original_text: null, proposed_text: 'new one', confidence: 0.8 },
    { key: 'n2', change_type: 'new', edit_level: 4, original_text: null, proposed_text: 'new two', confidence: 0.6 },
  ]
  const sets = shrinkStrategies(changes)
  check('attempt 0 unchanged', sets[0] === changes)
  check('attempt 1 restores shorter original only', sets[1].find((c) => c.key === 'r1')?.proposed_text === 'short' && sets[1].find((c) => c.key === 'r2')?.proposed_text === 'tight')
  check('attempt 2 drops lowest-confidence L4', !sets[2].some((c) => c.key === 'n2') && sets[2].some((c) => c.key === 'n1'))
  check('attempt 3 drops next L4', !sets[3].some((c) => c.key === 'n1'))
  check('attempt 4 restores remaining reword', sets[4].find((c) => c.key === 'r2')?.proposed_text === 'a long original text here')
  check('no further sets', sets.length === 5, `${sets.length}`)
  check('nothing to shrink → one set', shrinkStrategies([{ change_type: 'keep', edit_level: 0, original_text: 'a', proposed_text: 'a', confidence: 1 }]).length === 1)

  // ── Master-dependent ───────────────────────────────────────────────────────
  if (!fs.existsSync(MASTER)) {
    skip('all master-résumé tests', `${MASTER} not found`)
    return report()
  }
  const master = fs.readFileSync(MASTER)
  const masterFile = await readDocx(master)
  const masterModel = buildResumeModel(masterFile)
  const masterFonts = fontsUsed(masterFile.documentXml)
  const masterSizes = fontSizesUsed(masterFile.documentXml)
  const masterSect = sectPrOf(masterFile.documentXml)
  const masterParas = masterFile.body.paragraphs.length
  check('master has expected bullets', JSON.stringify(masterModel.experiences.find((e) => e.key === PNG)?.bulletParagraphIndexes) === '[6,7,8,9,10]')

  const renderer = await selectPdfRenderer()
  console.log(`renderer: ${renderer?.id ?? 'none'}`)

  // (a) replace bullet 6
  console.log('(a) replace bullet 6')
  const reworded = 'Piloted a **Controlled State system** on the Beauty Packing line at P&G’s largest global site, mapping a roadmap for further error reduction with $4M+ in projected savings.'
  const a = await applyResumePatch(master, { bullets: [{ paragraphIndex: 6, experienceKey: PNG, action: 'replace', text: reworded }] })
  check('a: no warnings', a.warnings.length === 0, a.warnings.join('; '))
  check('a: one applied', a.applied.length === 1 && a.applied[0].action === 'replace')
  const aFile = await readDocx(a.docx)
  check('a: paragraph count same', aFile.body.paragraphs.length === masterParas)
  for (let i = 0; i < masterParas; i++) {
    if (i === 6) continue
    if (aFile.body.paragraphs[i].xml !== masterFile.body.paragraphs[i].xml) {
      check(`a: paragraph ${i} byte-identical`, false)
      break
    }
  }
  check('a: gaps identical', JSON.stringify(aFile.body.gaps) === JSON.stringify(masterFile.body.gaps))
  const p6 = aFile.body.paragraphs[6]
  check('a: pPr kept', p6.pPr === masterFile.body.paragraphs[6].pPr)
  check('a: open tag kept', p6.xml.startsWith(masterFile.body.paragraphs[6].xml.match(/^<w:p[^>]*>/)![0]))
  const boldTexts = p6.runs.filter((r) => r.bold).map((r) => r.text)
  check('a: Controlled State bold', boldTexts.includes('Controlled State system'), boldTexts.join('|'))
  check('a: $4M+ re-bolded (unmarked, verbatim)', boldTexts.includes('$4M+ in projected savings'), boldTexts.join('|'))
  check('a: text round-trips', p6.text === reworded.replace(/\*\*/g, ''))
  check('a: sz 19 on all runs', p6.runs.every((r) => /<w:sz w:val="19"\/>/.test(r.rPr ?? '')))
  check('a: no ** leak', !p6.text.includes('**'))

  // A reword with NO markers keeps original spans that still appear verbatim.
  const plain = 'Built and piloted a Controlled State system for the Beauty Packing line, defining a roadmap with $4M+ in projected savings.'
  const a2 = await applyResumePatch(master, { bullets: [{ paragraphIndex: 6, experienceKey: PNG, action: 'replace', text: plain }] })
  const a2p = (await readDocx(a2.docx)).body.paragraphs[6]
  check('a2: both original spans re-bolded', a2p.runs.filter((r) => r.bold).map((r) => r.text).sort().join('|') === '$4M+ in projected savings|Controlled State system')

  // (b) insert after 9
  console.log('(b) insert after 9')
  const newText = 'Automated **daily line-clearance audits** with a lightweight script, cutting review time from hours to minutes.'
  const b = await applyResumePatch(master, { bullets: [{ paragraphIndex: null, experienceKey: PNG, action: 'insert', text: newText, afterParagraphIndex: 9 }] })
  const bFile = await readDocx(b.docx)
  check('b: paragraph count +1', bFile.body.paragraphs.length === masterParas + 1)
  const b10 = bFile.body.paragraphs[10]
  check('b: inserted at 10', b10.text === newText.replace(/\*\*/g, ''), b10.text)
  check('b: pPr cloned', b10.pPr === masterFile.body.paragraphs[9].pPr)
  check('b: numbered', b10.isBullet && b10.numId === masterFile.body.paragraphs[9].numId)
  const paraIds = Array.from(bFile.documentXml.matchAll(/w14:paraId="([^"]+)"/g)).map((m) => m[1])
  check('b: paraIds unique', new Set(paraIds).size === paraIds.length && paraIds.length === masterParas + 1)
  const newId = b10.xml.match(/w14:paraId="([0-9A-F]{8})"/)?.[1]
  check('b: paraId valid', !!newId && parseInt(newId, 16) < 0x80000000, newId)
  check('b: old bullet 10 now 11', bFile.body.paragraphs[11].xml === masterFile.body.paragraphs[10].xml)
  check('b: applied records new index', b.applied[0].newParagraphIndex === 10 && b.applied[0].paraId === newId)
  const bModel = buildResumeModel(bFile)
  check('b: model sees 6 P&G bullets', bModel.experiences.find((e) => e.key === PNG)?.bulletParagraphIndexes.length === 6)

  // insert first via org paragraph anchor
  const b2 = await applyResumePatch(master, { bullets: [{ paragraphIndex: null, experienceKey: PNG, action: 'insert', text: 'First bullet.', afterParagraphIndex: 5 }] })
  check('b2: insert first via org anchor', (await readDocx(b2.docx)).body.paragraphs[6].text === 'First bullet.')

  // (c) remove 10
  console.log('(c) remove bullet 10')
  const c = await applyResumePatch(master, { bullets: [{ paragraphIndex: 10, experienceKey: PNG, action: 'remove' }] })
  const cFile = await readDocx(c.docx)
  check('c: paragraph count -1', cFile.body.paragraphs.length === masterParas - 1)
  check('c: title 11 now at 10', cFile.body.paragraphs[10].xml === masterFile.body.paragraphs[11].xml)
  check('c: removed text gone', !documentText(cFile).includes('Ranked as #1'))

  // (d) reorder 13/14
  console.log('(d) reorder 13/14')
  const d = await applyResumePatch(master, { bullets: [], bulletOrder: { [IBC]: [14, 13] } })
  const dFile = await readDocx(d.docx)
  check('d: swapped', dFile.body.paragraphs[13].xml === masterFile.body.paragraphs[14].xml && dFile.body.paragraphs[14].xml === masterFile.body.paragraphs[13].xml)
  check('d: reorder recorded', d.applied.filter((x) => x.action === 'reorder').length === 2)
  check('d: rest identical', dFile.body.paragraphs.every((p, i) => i === 13 || i === 14 || p.xml === masterFile.body.paragraphs[i].xml))

  // (e) fingerprints
  console.log('(e) fonts / sizes / sectPr unchanged')
  for (const [label, buf] of [['a', a.docx], ['b', b.docx], ['c', c.docx], ['d', d.docx]] as const) {
    const f = await readDocx(buf)
    check(`e: ${label} fonts`, JSON.stringify(fontsUsed(f.documentXml)) === JSON.stringify(masterFonts))
    check(`e: ${label} sizes`, JSON.stringify(fontSizesUsed(f.documentXml)) === JSON.stringify(masterSizes))
    check(`e: ${label} sectPr`, sectPrOf(f.documentXml) === masterSect)
  }

  // warnings for bad edits
  const w = await applyResumePatch(master, {
    bullets: [
      { paragraphIndex: 4, experienceKey: PNG, action: 'replace', text: 'nope' },
      { paragraphIndex: 13, experienceKey: PNG, action: 'remove' },
      { paragraphIndex: null, experienceKey: 'unknown', action: 'insert', text: 'x' },
    ],
  })
  check('warnings for skipped edits', w.warnings.length === 3 && w.applied.length === 0, w.warnings.join('; '))
  check('nothing changed', (await readDocx(w.docx)).documentXml === masterFile.documentXml)

  // (f) render via Word
  console.log('(f) PDF render')
  const combined = await applyResumePatch(master, {
    bullets: [
      { paragraphIndex: 6, experienceKey: PNG, action: 'replace', text: reworded },
      { paragraphIndex: null, experienceKey: PNG, action: 'insert', text: newText, afterParagraphIndex: 9 },
      { paragraphIndex: 10, experienceKey: PNG, action: 'remove' },
    ],
    bulletOrder: { [IBC]: [14, 13] },
  })
  const names = resumeFilenames('Procter & Gamble')
  const docxPath = path.join(OUT, names.docx)
  fs.writeFileSync(docxPath, combined.docx)
  const expected = (await extractBulletTexts(combined.docx)).map((x) => x.text)
  let pdfPath: string | null = null
  if (renderer) {
    pdfPath = path.join(OUT, names.pdf)
    const r = await renderDocxToPdf(combined.docx, pdfPath)
    console.log(`  render: ok=${r.ok} pages=${r.pageCount} ${r.ms}ms`)
    check('f: render ok', r.ok, r.error)
    check('f: one page', r.pageCount === 1, `${r.pageCount}`)
    if (r.ok) {
      const info = await pdfInfo(pdfPath)
      check('f: pdfjs one page', info.pageCount === 1)
      check('f: pdf contains new bullet', normalizeText(info.pages.join(' ')).replace(/\s/g, '').includes('dailyline-clearanceaudits'))
      check('f: pdf fonts reported', info.fonts.length > 0, info.fontsNote)
      console.log(`  pdf fonts: ${info.fonts.join(', ')}`)
    }
  } else {
    skip('f: render', 'no PDF renderer')
  }
  const qa = await qaResumeDocument({
    docx: combined.docx, pdfPath, expectedBullets: expected, expectedPages: 1, allowedFonts: masterFonts, allowedFontSizes: masterSizes,
    masterSectPr: masterSect, masterParagraphCount: masterParas, filename: names.docx, company: 'Procter & Gamble', renderer: renderer?.id ?? null,
  })
  for (const c of qa.checks) if (!c.pass) console.log(`  qa ${c.name}: ${c.detail}`)
  check('f: resume QA ok', qa.ok, qa.checks.filter((c) => !c.pass).map((c) => c.name).join(','))
  check('f: QA has all check names', ['docx_valid', 'paragraph_count_sane', 'no_empty_bullets', 'fonts_unchanged', 'font_sizes_unchanged', 'sectpr_unchanged', 'no_placeholders', 'no_markdown_leak', 'pdf_present', 'content_match', 'filename_pattern'].every((n) => qa.checks.some((c) => c.name === n)))

  // (g) cover letter
  console.log('(g) cover letter')
  const paragraphs = [
    'I am applying for the Summer 2027 Process Engineering Internship at Procter & Gamble. Last summer at the Tabler Station site I built a Controlled State system for a Beauty Packing line, and I want to keep working on manufacturing problems where a quality decision has a dollar figure attached to it.',
    'The work that shaped me most was the annual quality risk assessment. Screening mis-pack and mis-code failure modes across lines taught me to argue from data rather than seniority, and the validation SOP I wrote is still in use. I learned that the durable improvements were the ones operators could run without me.',
    'Your posting asks for someone comfortable with both statistical process control and automation. My research group runs computational catalysis on a cluster, and I built an AI agent that drafts validation approvals, so the combination of rigor and tooling is where I already work.',
    'I would welcome the chance to discuss how that experience fits the team. Thank you for your time.',
  ]
  const cl = await buildCoverLetterDocx({
    name: 'Zuyu Liu', email: 'zuyu@example.com', phone: '555-000-0000', linkedin: 'linkedin.com/in/example', date: 'August 27, 2026',
    recipient: { company: 'Procter & Gamble', addressLines: ['Cincinnati, OH'] }, greeting: 'Dear Hiring Team,', paragraphs, closing: 'Sincerely,', signatureName: 'Zuyu Liu',
  })
  const clNames = coverLetterFilenames('Procter & Gamble')
  fs.writeFileSync(path.join(OUT, clNames.docx), cl)
  let clPdf: string | null = null
  if (renderer) {
    clPdf = path.join(OUT, clNames.pdf)
    const r = await renderDocxToPdf(cl, clPdf)
    console.log(`  render: ok=${r.ok} pages=${r.pageCount} ${r.ms}ms`)
    check('g: cover render ok', r.ok, r.error)
  }
  const clQa = await qaCoverLetterDocument({ docx: cl, pdfPath: clPdf, expectedParagraphs: paragraphs, company: 'Procter & Gamble', filename: clNames.docx, renderer: renderer?.id ?? null })
  for (const c of clQa.checks) if (!c.pass) console.log(`  qa ${c.name}: ${c.detail}`)
  check('g: cover QA ok', clQa.ok)
  check('g: font_is_times', clQa.checks.find((c) => c.name === 'font_is_times')?.pass === true)
  if (renderer) check('g: one_page', clQa.checks.find((c) => c.name === 'one_page')?.pass === true)
  else skip('g: one_page', 'no PDF renderer')

  // (i) planted leaks
  console.log('(i) planted leak / placeholder')
  const leak = await applyResumePatch(master, { bullets: [{ paragraphIndex: 7, experienceKey: PNG, action: 'replace', text: 'Led the **annual** risk review for [Company] with a stray ** marker.' }] })
  const leakQa = await qaResumeDocument({ docx: leak.docx, pdfPath: null, expectedBullets: [], expectedPages: 1, allowedFonts: masterFonts, filename: names.docx, company: 'Procter & Gamble', renderer: null })
  check('i: markdown leak detected', leakQa.checks.find((c) => c.name === 'no_markdown_leak')?.pass === false)
  check('i: placeholder detected', leakQa.checks.find((c) => c.name === 'no_placeholders')?.pass === false)
  check('i: pdf absence not blocking without renderer', leakQa.checks.find((c) => c.name === 'pdf_present')?.blocking === false)
  check('i: report not ok', !leakQa.ok)
  const badName = await qaResumeDocument({ docx: master, pdfPath: null, expectedBullets: [], expectedPages: 1, allowedFonts: masterFonts, filename: 'resume_final_v2.docx', company: '3M', renderer: null })
  check('i: bad filename detected', badName.checks.find((c) => c.name === 'filename_pattern')?.pass === false)

  // (j) fit-page loop
  console.log('(j) fit-to-one-page loop')
  if (!renderer) {
    skip('j: fit loop', 'no PDF renderer')
  } else {
    const longBullet = (n: number) =>
      `Extended addition ${n}: coordinated cross-functional reviews with operations, maintenance and quality leads to define acceptance criteria, then documented every decision in the site validation system so the next intern could pick the work up without a handover meeting.`
    const additions: (ShrinkableChange & { key: string })[] = Array.from({ length: 6 }, (_, i) => ({
      key: `n${i}`, change_type: 'new', edit_level: 4, original_text: null, proposed_text: longBullet(i + 1), confidence: 0.9 - i * 0.05,
    }))
    const strategies = shrinkStrategies(additions)
    const toPatch = (set: typeof additions): BulletEdit[] => set.map((c) => ({ paragraphIndex: null, experienceKey: PNG, action: 'insert' as const, text: c.proposed_text ?? '', afterParagraphIndex: 10 }))
    const pages: number[] = []
    const fit = await fitToOnePage({
      expectedPages: 1,
      maxAttempts: 8,
      render: async (attempt) => {
        const set = strategies[attempt]
        if (!set) return null
        return { docx: (await applyResumePatch(master, { bullets: toPatch(set) })).docx }
      },
      toPdf: async (docx, attempt) => {
        const p = path.join(OUT, `fit-attempt-${attempt}.pdf`)
        const r = await renderDocxToPdf(docx, p)
        if (r.pageCount !== null) pages.push(r.pageCount)
        console.log(`  attempt ${attempt}: ${set(strategies[attempt].length)} additions → ${r.pageCount} page(s) in ${r.ms}ms`)
        return { ok: r.ok, pageCount: r.pageCount, pdfPath: r.ok ? p : null, error: r.error, ms: r.ms }
      },
    })
    check('j: first attempt overflowed', pages[0] > 1, `${pages[0]}`)
    check('j: resolved to one page', fit.ok && fit.pageCount === 1, fit.error)
    check('j: shrink attempts recorded', fit.shrink_attempts >= 1 && fit.shrink_attempts === fit.attempts - 1, `${fit.shrink_attempts}`)
    if (fit.docx) {
      const finalQa = await qaResumeDocument({
        docx: fit.docx, pdfPath: fit.pdfPath, expectedBullets: (await extractBulletTexts(fit.docx)).map((x) => x.text), expectedPages: 1, allowedFonts: masterFonts,
        allowedFontSizes: masterSizes, masterSectPr: masterSect, filename: names.docx, company: 'Procter & Gamble', renderer: renderer.id,
      })
      finalQa.shrink_attempts = fit.shrink_attempts
      check('j: final QA ok', finalQa.ok, finalQa.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join('; '))
      check('j: report records shrink_attempts', finalQa.shrink_attempts === fit.shrink_attempts)
    }
  }

  // (k) renderer policy: "no renderer" and "the render failed" are different
  // things, and only one of them is a broken package (ADR-033).
  console.log('(k) renderer policy')
  const qaArgs = { docx: combined.docx, expectedBullets: [], expectedPages: 1, allowedFonts: masterFonts, allowedFontSizes: masterSizes, masterSectPr: masterSect, filename: names.docx, company: 'Procter & Gamble' }
  const noRendererQa = await qaResumeDocument({ ...qaArgs, pdfPath: null, renderer: null })
  const pdfCheck = noRendererQa.checks.find((c) => c.name === 'pdf_present')
  check('k: no renderer → pdf_present fails but does not block', pdfCheck?.pass === false && pdfCheck?.blocking === false, JSON.stringify(pdfCheck))
  check('k: no renderer → the report is still ok (DOCX-only package)', noRendererQa.ok, noRendererQa.checks.filter((c) => !c.pass && c.blocking).map((c) => c.name).join(','))
  check('k: no renderer → the reason is stated, not hidden', /no PDF renderer available/.test(pdfCheck?.detail ?? ''), pdfCheck?.detail)
  check('k: no renderer → the absence is surfaced as a warning', noRendererQa.warnings.some((w) => /^pdf_present/.test(w)), noRendererQa.warnings.join(' | '))
  check('k: no renderer → no PDF is invented', noRendererQa.pdf_path === null && noRendererQa.page_count === null && noRendererQa.renderer === null)

  const failedRenderQa = await qaResumeDocument({ ...qaArgs, pdfPath: null, renderer: 'word-com' })
  const failedCheck = failedRenderQa.checks.find((c) => c.name === 'pdf_present')
  check('k: a renderer that produced nothing DOES block', failedCheck?.pass === false && failedCheck?.blocking === true, JSON.stringify(failedCheck))
  check('k: a failed render makes the report not ok', !failedRenderQa.ok)

  const clNoRenderer = await qaCoverLetterDocument({ docx: cl, pdfPath: null, expectedParagraphs: paragraphs, company: 'Procter & Gamble', filename: clNames.docx, renderer: null })
  const onePage = clNoRenderer.checks.find((c) => c.name === 'one_page')
  check('k: cover letter without a renderer → one_page does not block', onePage?.pass === false && onePage?.blocking === false, JSON.stringify(onePage))
  check('k: cover letter without a renderer → the report is still ok', clNoRenderer.ok, clNoRenderer.checks.filter((c) => !c.pass && c.blocking).map((c) => c.name).join(','))
  const clFailedRender = await qaCoverLetterDocument({ docx: cl, pdfPath: null, expectedParagraphs: paragraphs, company: 'Procter & Gamble', filename: clNames.docx, renderer: 'word-com' })
  check('k: cover letter with a renderer but no PDF DOES block', clFailedRender.checks.find((c) => c.name === 'one_page')?.blocking === true && !clFailedRender.ok)

  // The scratch a buffer render needs is OS-owned. The old code dropped its
  // source DOCX under `.career-out/tmp` — a relative path that does not exist
  // in a deployed runtime, which is the ENOENT this workstream fixed.
  //
  // Two assertions, because the negative one alone is vacuous on a clean
  // machine: `.career-out/tmp` is CREATED for the duration (so a regression
  // could actually land there and be seen), and the temp root is SAMPLED while
  // the render is in flight, so the scratch is caught existing where it should.
  const oldScratch = path.resolve('.career-out', 'tmp')
  const createdOldScratch = !fs.existsSync(oldScratch)
  if (createdOldScratch) fs.mkdirSync(oldScratch, { recursive: true })
  const legacy = (): number => (fs.existsSync(oldScratch) ? fs.readdirSync(oldScratch).length : -1)
  const before = legacy()
  const root = tmpRoot()
  const renderDirs = (): Set<string> => new Set(fs.readdirSync(root).filter((f) => /^render-/.test(f)))
  if (renderer) {
    const probe = path.join(OUT, 'renderer-policy-probe.pdf')
    // Only THIS render's scratch is judged: the root is shared, and Word can
    // still be holding an earlier one open.
    const before = renderDirs()
    const fresh = new Set<string>()
    const watch = setInterval(() => {
      for (const d of renderDirs()) if (!before.has(d)) fresh.add(d)
    }, 10)
    let r: Awaited<ReturnType<typeof renderDocxToPdf>>
    try {
      r = await renderDocxToPdf(cl, probe)
    } finally {
      clearInterval(watch)
    }
    check('k: a buffer render still works', r.ok, r.error)
    check('k: the render scratch appears under the OS temp root', fresh.size > 0, `no new render-* directory was seen in ${root}`)
    // Word holds the source file for a moment after Close, so removal is
    // deferred and retried; give the retries their window rather than
    // asserting on the instant the promise resolved.
    const gone = async (): Promise<boolean> => {
      for (let i = 0; i < 30; i++) {
        const now = renderDirs()
        if (![...fresh].some((d) => now.has(d))) return true
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return false
    }
    check('k: and the scratch is removed again, never leaked', await gone(), [...fresh].join(', '))
    check('k: nothing is left deferred for the sweep at shutdown', sweepRenderScratch().length === 0)
  } else {
    skip('k: buffer render', 'no PDF renderer')
  }
  check('k: a buffer render writes nothing under .career-out/tmp', legacy() === before && before >= 0, `${before} → ${legacy()}`)
  if (createdOldScratch && fs.existsSync(oldScratch) && fs.readdirSync(oldScratch).length === 0) fs.rmdirSync(oldScratch)

  report()
}

function set(n: number): number {
  return n
}

function report(): void {
  shutdownPdfRenderers()
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failed) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  shutdownPdfRenderers()
  process.exit(1)
})
