// Offline checks for the applicant-name resolver and the letter name repair.
//
//   npx tsx scripts/test-career-identity.ts
//
// No network, no keys. The bug: profiles.name is the email local-part for
// anyone the signup trigger named, and the first live cover letter opened and
// signed "zuyu.alex06". Every rule that stops that is asserted here.

import { buildFixtureBank } from './test-career-tailor'
import { buildSyntheticBank } from './lib/synthetic-evidence-bank'
import { APPLICANT_FALLBACK, isEmailLikeName, looksLikePersonName, nameFromBank, nameFromResume, printableName, resolveApplicantName } from '../lib/career/identity'
import { resolveSenderFrom } from '../lib/outreach/sender'
import { assembleLetter } from '../lib/career/letter/pipeline'
import { emailNameTokensIn, profileNameTokens, repairLetterText, replaceNameTokens } from '../lib/career/package/repair'
import type { CoverLetter, EvidenceBank, ResumeDocument } from '../lib/career/types'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function withMaster(bank: EvidenceBank, nameLine: string | null): EvidenceBank {
  const master: ResumeDocument = {
    id: 'doc-1', user_id: 'u', label: 'master', is_master: true, filename: 'r.docx', storage_path: null, sha256: 'x', byte_size: 1, page_count: 1, uploaded_at: 'now',
    paragraph_map: [
      ...(nameLine === null ? [] : [{ index: 0, kind: 'name' as const, text: nameLine }]),
      { index: 1, kind: 'contact' as const, text: 'zuyu.alex06@gmail.com | (217) 555-0100' },
    ],
  }
  return { ...bank, masterDocument: master }
}

function emptyBank(): EvidenceBank {
  return { experiences: [], facts: [], metrics: [], deliverables: [], skills: [], stories: [], preferences: [], bullets: [], organizations: [], sources: [], factSources: [], projects: [], masterDocument: null }
}

const saved = process.env.OUTREACH_SENDER_NAME
delete process.env.OUTREACH_SENDER_NAME

console.log('looksLikePersonName / isEmailLikeName')
check('email local-part is not a person name', !looksLikePersonName('zuyu.alex06'))
check('real name is', looksLikePersonName('Zuyu Liu') && looksLikePersonName('Mary-Jane O’Neil Smith'))
check('digits / @ rejected', !looksLikePersonName('Zuyu Liu2') && !looksLikePersonName('a@b c'))
check('isEmailLikeName: local-part with a dot', isEmailLikeName('zuyu.alex06'))
check('isEmailLikeName: digits only suffix', isEmailLikeName('jdoe42'))
check('isEmailLikeName: underscore form', isEmailLikeName('first_last'))
check('isEmailLikeName: a full address', isEmailLikeName('zuyu.alex06@gmail.com'))
check('isEmailLikeName: a real name is not', !isEmailLikeName('Zuyu Liu'))
check('isEmailLikeName: a plain single word is not', !isEmailLikeName('zuyu'))
check('isEmailLikeName: empty is not', !isEmailLikeName('') && !isEmailLikeName(null))

console.log('resolveApplicantName order')
const bank = buildFixtureBank()
// The synthetic bank carries the education fact "Zuyu Liu is a Chemical Engineering student at …"; the tailor fixture does not.
const eduBank = buildSyntheticBank()
check('profile name wins when it looks like a name', resolveApplicantName({ profileName: 'Ada Lovelace', bank: withMaster(bank, 'Zuyu Liu') }).source === 'profile')
const r1 = resolveApplicantName({ profileName: 'zuyu.alex06', bank: withMaster(bank, 'Zuyu Liu') })
check('email local-part falls through to the résumé name line', r1.name === 'Zuyu Liu' && r1.source === 'resume', JSON.stringify(r1))
check('résumé name line with bold markers is cleaned', nameFromResume(withMaster(emptyBank(), '**Zuyu Liu**')) === 'Zuyu Liu')
check('résumé name line that is not a name is ignored', nameFromResume(withMaster(emptyBank(), 'RESUME 2026')) === null)
const r2 = resolveApplicantName({ profileName: 'zuyu.alex06', bank: withMaster(eduBank, null) })
check('no résumé line → bank education fact', r2.name === 'Zuyu Liu' && r2.source === 'bank', JSON.stringify(r2))
check('nameFromBank reads the education fact', nameFromBank(eduBank) === 'Zuyu Liu')
check('nameFromBank: none without such a fact', nameFromBank(bank) === null)
const r3 = resolveApplicantName({ profileName: 'zuyu.alex06', bank: emptyBank(), env: 'Env Person' })
check('empty bank → env', r3.name === 'Env Person' && r3.source === 'env', JSON.stringify(r3))
check('env that is an email name is rejected', resolveApplicantName({ profileName: null, bank: emptyBank(), env: 'env.user1' }).source === 'fallback')
const r4 = resolveApplicantName({ profileName: 'zuyu.alex06', bank: emptyBank(), env: null })
check(`'${APPLICANT_FALLBACK}' is last, never the local-part`, r4.name === APPLICANT_FALLBACK && r4.source === 'fallback', JSON.stringify(r4))
check('the result never carries @ or a digit', [r1, r2, r3, r4].every((r) => !/[@\d]/.test(r.name)))
check('printableName passes a real name through', printableName('Zuyu Liu') === 'Zuyu Liu')
check('printableName resolves an email name against the bank', printableName('zuyu.alex06', withMaster(emptyBank(), 'Zuyu Liu')) === 'Zuyu Liu')
check('printableName with nothing to resolve from is the fallback', printableName('zuyu.alex06') === APPLICANT_FALLBACK)

console.log('outreach sender agrees')
const s1 = resolveSenderFrom({ name: 'zuyu.alex06', major: null }, withMaster(bank, 'Zuyu Liu'))
check('sender resolves through the same helper (résumé source)', s1.name === 'Zuyu Liu' && s1.nameSource === 'resume', JSON.stringify(s1))
check('sender keeps its literal as the last resort', resolveSenderFrom({ name: 'zuyu.alex06' }, emptyBank()).nameSource === 'fallback')

console.log('letter assembly')
const assembled = assembleLetter({ greeting: 'Dear Team,', paragraphs: ['p1'], closing: 'Sincerely,' }, 'zuyu.alex06')
check('assembleLetter never signs with an email name', !/zuyu\.alex06/.test(assembled) && assembled.endsWith(APPLICANT_FALLBACK), assembled)

console.log('repair: tokens and rewriting')
const tokens = profileNameTokens({ name: 'zuyu.alex06', email: 'zuyu.alex06@gmail.com' })
check('profile tokens: local-part once', tokens.length === 1 && tokens[0] === 'zuyu.alex06', tokens.join(','))
check('profile tokens: a real name contributes nothing', profileNameTokens({ name: 'Zuyu Liu', email: 'zuyu.alex06@gmail.com' }).join(',') === 'zuyu.alex06')
check('profile tokens: no email, no name → none', profileNameTokens({ name: null, email: null }).length === 0)
const rep = replaceNameTokens('Dear zuyu.alex06,\n\nSincerely,\n\nzuyu.alex06', ['zuyu.alex06'], 'Zuyu Liu')
check('replaceNameTokens rewrites every standalone occurrence', rep.replaced === 2 && rep.text === 'Dear Zuyu Liu,\n\nSincerely,\n\nZuyu Liu', rep.text)
const keep = replaceNameTokens('Reach me at zuyu.alex06@gmail.com.', ['zuyu.alex06'], 'Zuyu Liu')
check('the email address itself is left alone', keep.replaced === 0 && /zuyu\.alex06@gmail\.com/.test(keep.text), keep.text)
check('case-insensitive', replaceNameTokens('Zuyu.Alex06', ['zuyu.alex06'], 'Zuyu Liu').text === 'Zuyu Liu')

const now = new Date().toISOString()
const letter: CoverLetter = {
  id: 'cl-1', user_id: 'u', job_id: 'j', package_id: 'p', version: 1,
  greeting: 'Dear Kairos Power Hiring Team,', paragraphs: ['I am zuyu.alex06, a chemical engineering student.', 'Second paragraph.'], closing: 'Sincerely,',
  full_text: 'Dear Kairos Power Hiring Team,\n\nI am zuyu.alex06, a chemical engineering student.\n\nSecond paragraph.\n\nSincerely,\n\nzuyu.alex06',
  edited_text: null, word_count: 12, claims: [], grounding: { ok: true, blocking: [], warnings: [] }, review_status: 'approved', prompt_version: '1', agent_run_id: null, created_at: now, updated_at: now,
}
const fix = repairLetterText(letter, tokens, 'Zuyu Liu')
check('repairLetterText names the fields it changed', fix.fields.includes('full_text') && fix.fields.includes('paragraphs[0]') && !fix.fields.includes('greeting') && !fix.fields.includes('paragraphs[1]'), fix.fields.join(','))
check('repairLetterText patch carries corrected text and paragraphs', fix.patch.full_text?.endsWith('Zuyu Liu') === true && fix.patch.paragraphs?.[0] === 'I am Zuyu Liu, a chemical engineering student.' && fix.patch.paragraphs?.[1] === 'Second paragraph.')
check('repairLetterText leaves untouched columns out of the patch', !('greeting' in fix.patch) && !('closing' in fix.patch) && !('edited_text' in fix.patch))
check('a clean letter yields an empty repair', repairLetterText({ ...letter, paragraphs: ['clean'], full_text: 'Dear,\n\nclean\n\nSincerely,\n\nZuyu Liu' }, tokens, 'Zuyu Liu').fields.length === 0)
const stale = emailNameTokensIn({ full_text: 'Dear,\n\nbody\n\nSincerely,\n\nold.handle9', edited_text: null }, [])
check('an email-like signature line is detected without profile tokens', stale.length === 1 && stale[0] === 'old.handle9', stale.join(','))
check('a real signature line adds no token', emailNameTokensIn({ full_text: 'Dear,\n\nbody\n\nSincerely,\n\nZuyu Liu', edited_text: null }, ['zuyu.alex06']).join(',') === 'zuyu.alex06')

if (saved !== undefined) process.env.OUTREACH_SENDER_NAME = saved
console.log(failures === 0 ? '\nall identity checks passed' : `\n${failures} check(s) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
