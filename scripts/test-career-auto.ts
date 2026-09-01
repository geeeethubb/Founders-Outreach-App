// Offline tests for one-click package generation.
//
// The subject is `assessPackage` — the pure function that decides whether a
// person's work is finished. It is worth this much testing because it replaced
// four human clicks: if it says READY TO APPLY when something is wrong, nobody
// is standing between that and a submitted application.
//
// No network, no keys, no database.
//
//   npx tsx scripts/test-career-auto.ts

import {
  applyUrlFor,
  assessPackage,
  resumeChangeSummary,
  type PackageAssessmentInput,
} from '../lib/career/package/auto'
import type { DocumentQaCheck, DocumentQaReport } from '../lib/career/types'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL ${name} — ${detail}`)
  }
}

function qa(checks: Partial<DocumentQaCheck>[]): DocumentQaReport {
  const full = checks.map((c) => ({ name: c.name ?? 'x', pass: c.pass ?? true, detail: c.detail ?? '', blocking: c.blocking ?? true }))
  return {
    ok: full.every((c) => c.pass || !c.blocking),
    document: 'resume',
    checks: full,
    warnings: [],
    docx_path: 'p.docx',
    pdf_path: null,
    page_count: null,
    expected_pages: 1,
    renderer: null,
  }
}

/** A package where everything went right. Each test breaks exactly one thing. */
function healthy(over: Partial<PackageAssessmentInput> = {}): PackageAssessmentInput {
  return {
    hardError: null,
    resumeDocxPath: 'career-docs/u/p/v1/Resume.docx',
    resumeQa: qa([{ name: 'docx_valid' }, { name: 'content_match' }, { name: 'pdf_present', pass: false, blocking: false, detail: 'not requested' }]),
    letter: { blockingGrounding: 0, qa: qa([{ name: 'docx_valid' }]) },
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    ...over,
  }
}

function main(): void {
  console.log('assessPackage: the happy path is genuinely ready')
  {
    const r = assessPackage(healthy())
    check('a clean package is READY TO APPLY', r.ready && r.attention.length === 0, JSON.stringify(r.attention))
    // A skipped PDF is a non-blocking check. If it counted, every DOCX-only
    // package — the default — would demand attention forever.
    check('a non-blocking failed check does not demand attention', r.ready)
  }

  console.log('\nassessPackage: what a rejected résumé change does NOT do')
  {
    // There is no input for it, and that is the point: the verifier refusing a
    // rewrite leaves the original bullet in place. Nothing for a human to decide.
    const r = assessPackage(healthy())
    check('rejected changes are not an assessment input at all', r.ready && !('rejected' in (healthy() as object)))
  }

  console.log('\nassessPackage: each failure is named, once, with an action')
  {
    const r = assessPackage(healthy({ hardError: 'tailoring stage threw' }))
    check('a hard error is generation_failed', !r.ready && r.attention[0].code === 'generation_failed')
    check('the hard error carries the cause', r.attention[0].why.includes('tailoring stage threw'))
    check('a failed run reports nothing downstream', r.attention.length === 1, `${r.attention.length} items`)
  }
  {
    const r = assessPackage(healthy({ resumeDocxPath: null }))
    check('no résumé DOCX needs attention', !r.ready && r.attention.some((a) => a.code === 'resume_missing'))
    // A missing document cannot also have failed its QA — reporting both would
    // be two lines for one problem.
    check('a missing résumé does not also report a QA failure', !r.attention.some((a) => a.code === 'resume_qa_failed'))
  }
  {
    const bad = qa([{ name: 'docx_valid', pass: false, detail: 'unclosed <w:p>' }])
    const r = assessPackage(healthy({ resumeQa: bad }))
    check('a blocking QA failure needs attention', !r.ready && r.attention.some((a) => a.code === 'resume_qa_failed'))
    check('the QA failure names the check and the detail',
      r.attention.some((a) => a.what.includes('docx_valid') && a.why.includes('unclosed')), JSON.stringify(r.attention))
  }
  {
    const r = assessPackage(healthy({ letter: { blockingGrounding: 2, qa: qa([{ name: 'docx_valid' }]) } }))
    check('an ungrounded letter claim needs attention', !r.ready && r.attention.some((a) => a.code === 'letter_unsupported_claim'))
    check('it counts the claims', r.attention.some((a) => a.what.includes('2 claims')), JSON.stringify(r.attention))
    check('the résumé is not blamed for the letter', !r.attention.some((a) => a.code.startsWith('resume')))
  }
  {
    const r = assessPackage(healthy({ letter: { blockingGrounding: 1, qa: qa([{ name: 'docx_valid' }]) } }))
    check('one claim is singular', r.attention.some((a) => a.what.includes('1 claim the evidence')), JSON.stringify(r.attention.map((a) => a.what)))
  }
  {
    const r = assessPackage(healthy({ applyUrl: null }))
    check('no apply URL needs attention', !r.ready && r.attention.some((a) => a.code === 'no_apply_url'))
  }
  {
    const r = assessPackage(healthy({ letter: null }))
    check('a package with no letter is still ready', r.ready, JSON.stringify(r.attention))
  }
  {
    const r = assessPackage(healthy({ resumeDocxPath: null, applyUrl: null, letter: { blockingGrounding: 1, qa: null } }))
    check('several problems are all reported, not just the first', r.attention.length === 3, `${r.attention.length}`)
    const codes = r.attention.map((a) => a.code)
    check('and each appears once', new Set(codes).size === codes.length, codes.join(','))
  }

  // ─── The gates an adversarial review found missing ───
  console.log('\nassessPackage: a change only a human may approve is never silently dropped')
  {
    const r = assessPackage(healthy({ pendingChanges: 1 }))
    check('a pending change needs attention', !r.ready && r.attention.some((a) => a.code === 'change_needs_your_yes'))
    check('and it says the document omits it', r.attention.some((a) => /omits it/.test(a.action)), JSON.stringify(r.attention.map((a) => a.action)))
    check('zero pending changes is silent', assessPackage(healthy({ pendingChanges: 0 })).ready)
    check('undefined pending is silent too', assessPackage(healthy()).ready)
  }

  console.log('\nassessPackage: a letter whose record is missing is unverified, not absent')
  {
    const r = assessPackage(healthy({ letter: null, letterRowMissing: true }))
    check('a missing letter row needs attention', !r.ready && r.attention.some((a) => a.code === 'letter_row_missing'))
    check('no letter and no missing row is still ready', assessPackage(healthy({ letter: null })).ready)
  }

  console.log('\nresumeChangeSummary: every proposal is accounted for')
  check('a pending change is named, not dropped',
    resumeChangeSummary({ proposed: 5, applied: 4, rejected: 0, pending: 1 }) === '4 of 5 proposed changes applied; 1 awaiting your decision.',
    resumeChangeSummary({ proposed: 5, applied: 4, rejected: 0, pending: 1 }))
  check('rejected and pending both appear',
    /omitted.*awaiting your decision/.test(resumeChangeSummary({ proposed: 6, applied: 4, rejected: 1, pending: 1 })),
    resumeChangeSummary({ proposed: 6, applied: 4, rejected: 1, pending: 1 }))

  console.log('\nassessPackage: every item is actionable')
  {
    const all = [
      assessPackage(healthy({ hardError: 'the résumé document stage threw ENOENT' })),
      assessPackage(healthy({ resumeDocxPath: null })),
      assessPackage(healthy({ resumeQa: qa([{ name: 'content_match', pass: false }]) })),
      assessPackage(healthy({ letter: { blockingGrounding: 1, qa: qa([{ name: 'docx_valid', pass: false }]) } })),
      assessPackage(healthy({ applyUrl: null })),
    ].flatMap((r) => r.attention)
    check('nothing is reported without what/why/action',
      all.every((a) => a.what.length > 10 && a.why.length > 5 && a.action.length > 10), `${all.length} items`)
    check('no action is "review 7 stages"', all.every((a) => !/review \d+ stage/i.test(a.action)))
  }

  console.log('\napplyUrlFor: the link a person actually opens')
  check('apply_url wins', applyUrlFor({ apply_url: 'https://a', canonical_url: 'https://c' } as never) === 'https://a')
  check('canonical_url is the fallback', applyUrlFor({ apply_url: null, canonical_url: 'https://c' } as never) === 'https://c')
  check('a blank string is not a URL', applyUrlFor({ apply_url: '   ', canonical_url: 'https://c' } as never) === 'https://c')
  check('neither is null', applyUrlFor({ apply_url: null, canonical_url: '' } as never) === null)

  console.log('\nresumeChangeSummary: the sentence the founder asked for')
  check('4 of 5 with one omitted',
    resumeChangeSummary({ proposed: 5, applied: 4, rejected: 1 }) === '4 of 5 proposed changes applied; 1 unsupported change omitted, original wording kept.',
    resumeChangeSummary({ proposed: 5, applied: 4, rejected: 1 }))
  check('all applied has no omission clause', resumeChangeSummary({ proposed: 4, applied: 4, rejected: 0 }) === '4 of 4 proposed changes applied.')
  check('nothing proposed says so plainly', /master résumé is used as written/.test(resumeChangeSummary({ proposed: 0, applied: 0, rejected: 0 })))
  check('one change is singular', resumeChangeSummary({ proposed: 1, applied: 1, rejected: 0 }) === '1 of 1 proposed change applied.')

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

main()
