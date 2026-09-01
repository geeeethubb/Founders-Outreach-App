// A cover-letter failure must never destroy a package whose résumé is complete.
//
// Live evidence: a five-job batch produced a Solid Power package whose résumé
// DOCX was built, stored and passing every QA check, and whose cover-letter
// writer then stopped without calling submit_result. The package was recorded
// `failed` and the usable résumé was unreachable. Most applications do not
// require a cover letter at all.
//
//   npx tsx scripts/test-career-status-letter.ts

import { missingArtifacts } from '../lib/career/package/status'
import { assessPackage } from '../lib/career/package/assessment'
import type { DocumentQaReport } from '../lib/career/types'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`) }
}

const okQa: DocumentQaReport = {
  ok: true, document: 'resume', checks: [{ name: 'docx_valid', pass: true, detail: '', blocking: true }],
  warnings: [], docx_path: 'r.docx', pdf_path: null, page_count: null, expected_pages: 1, renderer: null,
}

function main(): void {
  console.log('missingArtifacts: a letter that was never written is not "missing"')
  const complete = { resumeDocxPath: 'r.docx', resumeQaPresent: true, coverDocxPath: 'c.docx', coverQaPresent: true, coverLetterText: 'Dear…' }
  check('a complete package misses nothing', missingArtifacts(complete).length === 0)
  check('a letter that failed leaves nothing missing',
    missingArtifacts({ ...complete, coverDocxPath: null, coverQaPresent: false, coverLetterText: null, letterExpected: false }).length === 0,
    missingArtifacts({ ...complete, coverDocxPath: null, coverQaPresent: false, coverLetterText: null, letterExpected: false }).join(','))
  // The guard still guards: when a letter WAS produced, its parts are required.
  check('an expected letter with no DOCX is still missing it',
    missingArtifacts({ ...complete, coverDocxPath: null }).includes('cover letter DOCX'))
  check('letterExpected defaults to true', missingArtifacts({ ...complete, coverLetterText: null }).includes('cover letter text'))
  check('a missing résumé is still fatal regardless of the letter',
    missingArtifacts({ ...complete, resumeDocxPath: null, letterExpected: false }).includes('résumé DOCX'))

  console.log('\nassessPackage: a failed letter is attention, not a dead package')
  const base = { hardError: null, resumeDocxPath: 'r.docx', resumeQa: okQa, letter: null, applyUrl: 'https://a' }
  const r = assessPackage({ ...base, letterFailed: true })
  check('a failed letter needs attention', !r.ready && r.attention.some((a) => a.code === 'letter_failed'))
  check('and it says the résumé is unaffected', r.attention.some((a) => /r\u00e9sum\u00e9 is complete and unaffected/.test(a.why)), JSON.stringify(r.attention.map((a) => a.why)))
  check('it offers applying with the résumé alone', r.attention.some((a) => /apply with the r\u00e9sum\u00e9/.test(a.action)))
  check('no résumé problem is invented', !r.attention.some((a) => a.code.startsWith('resume')))
  check('without letterFailed the same package is ready', assessPackage(base).ready)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1 }
}

main()
