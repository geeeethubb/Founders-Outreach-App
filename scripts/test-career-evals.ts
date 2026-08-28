// Offline checks for the Career OS eval harness: every fixture loads and keeps
// its invariants, and every metric helper matches a hand-computed answer.
//
// No network, no keys. The judges in evals/career/judge.ts are NOT exercised
// here; they need ANTHROPIC_API_KEY and belong to the suites that use them.
//   npx tsx scripts/test-career-evals.ts

import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  precisionAtK, rankOrderViolations, duplicateRate, staleShownOpenRate, canonicalUrlAccuracy,
  classificationAccuracy, editDistance, meanEditDistance, formatTable, hostOf,
} from '../evals/career/metrics'
import { LETTER_DIMENSIONS } from '../evals/career/judge'

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
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol
const FIXTURES = resolve(__dirname, '../evals/career/fixtures')
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as T
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length

// ─── benchmark-companies.json ────────────────────────────────────────────────

interface Benchmark {
  companies: {
    name: string; domain: string; hq_metro: string; tier: number; company_type: string
    industry_tags: string[]; known_ats: string; known_board_identifier: string | null
    careers_url: string; expects_summer_internships: boolean; note: string
  }[]
}
const ATS = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'other', 'unknown'])
const KEYLESS = new Set(['greenhouse', 'lever', 'ashby'])
{
  const b = load<Benchmark>('benchmark-companies.json')
  const c = b.companies
  check('benchmark: 30 companies', c.length === 30, `got ${c.length}`)
  check('benchmark: names unique', uniqueIds(c.map((x) => x.name)))
  check('benchmark: domains unique', uniqueIds(c.map((x) => x.domain)))
  check('benchmark: tiers valid', c.every((x) => [1, 2, 3].includes(x.tier)))
  check('benchmark: ats enum valid', c.every((x) => ATS.has(x.known_ats)), c.filter((x) => !ATS.has(x.known_ats)).map((x) => x.name).join(','))
  check('benchmark: keyless boards carry an identifier', c.every((x) => !KEYLESS.has(x.known_ats) || !!x.known_board_identifier))
  check('benchmark: unknown/other carry no identifier', c.every((x) => !['unknown', 'other'].includes(x.known_ats) || x.known_board_identifier === null))
  check('benchmark: careers_url is https', c.every((x) => /^https:\/\//.test(x.careers_url)))
  check('benchmark: tags non-empty', c.every((x) => x.industry_tags.length > 0))
  check('benchmark: every entry has a note', c.every((x) => x.note.trim().length > 20))
  const keyless = c.filter((x) => KEYLESS.has(x.known_ats)).length
  check('benchmark: ≥12 confirmed keyless boards', keyless >= 12, `got ${keyless}`)
  const t12 = c.filter((x) => x.tier <= 2).length
  check('benchmark: tier 1-2 majority', t12 >= 20, `got ${t12}`)
  check('benchmark: no staffing agencies', c.every((x) => !/staffing|recruit|talent/i.test(x.name)))
}

// ─── jd-corpus.json ──────────────────────────────────────────────────────────

interface Corpus {
  jobs: {
    id: string; company: string; fictional: boolean; title: string; location_raw: string; jd_text: string
    expected: {
      employment_type: string; season_relevance: string; location_tier: number | null; role_family: string
      eligibility_for_user: string; fit_class: string; negative_reason: string | null
    }
  }[]
}
const EMPLOYMENT = new Set(['internship', 'co_op', 'full_time', 'part_time', 'contract', 'other', 'unknown'])
const SEASON = new Set(['summer_2027', 'other_season', 'unspecified', 'unknown'])
const ELIG = new Set(['QUALIFIED', 'STRETCH', 'NOT_QUALIFIED'])
const FIT = new Set(['strong', 'good', 'weak', 'negative'])
{
  const j = load<Corpus>('jd-corpus.json').jobs
  check('corpus: 24 entries', j.length === 24, `got ${j.length}`)
  check('corpus: ids unique', uniqueIds(j.map((x) => x.id)))
  check('corpus: all fictional', j.every((x) => x.fictional === true))
  check('corpus: employment enum', j.every((x) => EMPLOYMENT.has(x.expected.employment_type)))
  check('corpus: season enum', j.every((x) => SEASON.has(x.expected.season_relevance)))
  check('corpus: eligibility enum', j.every((x) => ELIG.has(x.expected.eligibility_for_user)))
  check('corpus: fit_class enum', j.every((x) => FIT.has(x.expected.fit_class)))
  check('corpus: location_tier valid', j.every((x) => x.expected.location_tier === null || [1, 2, 3].includes(x.expected.location_tier)))
  const strong = j.filter((x) => x.expected.fit_class === 'strong').length
  const good = j.filter((x) => x.expected.fit_class === 'good').length
  const neg = j.filter((x) => x.expected.fit_class === 'negative').length
  check('corpus: 8/6/10 split', strong === 8 && good === 6 && neg === 10, `${strong}/${good}/${neg}`)
  check('corpus: negatives have a reason', j.every((x) => x.expected.fit_class !== 'negative' || !!x.expected.negative_reason))
  check('corpus: positives have no reason', j.every((x) => x.expected.fit_class === 'negative' || x.expected.negative_reason === null))
  check('corpus: negatives are NOT_QUALIFIED', j.every((x) => x.expected.fit_class !== 'negative' || x.expected.eligibility_for_user === 'NOT_QUALIFIED'))
  check('corpus: strong are QUALIFIED', j.every((x) => x.expected.fit_class !== 'strong' || x.expected.eligibility_for_user === 'QUALIFIED'))
  const words = j.map((x) => x.jd_text.split(/\s+/).length)
  check('corpus: JDs 250–500 words', words.every((w) => w >= 250 && w <= 500), words.join(','))
  check('corpus: JDs have the six sections', j.every((x) => /Responsibilities/.test(x.jd_text) && /Minimum qualifications/.test(x.jd_text) && /Preferred qualifications/.test(x.jd_text) && /eligibility/i.test(x.jd_text)))
  check('corpus: tiers 1, 2, 3 and remote all present', [1, 2, 3, null].every((t) => j.some((x) => x.expected.location_tier === t)))
  check('corpus: one remote-US', j.filter((x) => /remote/i.test(x.location_raw)).length === 1)
  check('corpus: one non-US', j.filter((x) => /London/.test(x.location_raw)).length === 1)
  check('corpus: summer-2027 label on all non-season negatives', j.filter((x) => x.expected.season_relevance === 'other_season').length === 2)
}

// ─── factuality-attacks.json ─────────────────────────────────────────────────

interface Attacks { attacks: { id: string; attack: string; tempting_terms: string[]; jd_text: string; note: string }[] }
const ATTACKS = new Set([
  'invented_metric', 'invented_software', 'inflated_ownership', 'merged_project', 'title_change',
  'unsupported_skill', 'unsupported_business_result', 'keyword_injection',
])
{
  const a = load<Attacks>('factuality-attacks.json').attacks
  check('attacks: 8 entries', a.length === 8, `got ${a.length}`)
  check('attacks: ids unique', uniqueIds(a.map((x) => x.id)))
  check('attacks: enum valid', a.every((x) => ATTACKS.has(x.attack)))
  check('attacks: every class covered once', new Set(a.map((x) => x.attack)).size === 8)
  check('attacks: tempting_terms non-empty', a.every((x) => x.tempting_terms.length >= 3))
  check('attacks: tempting terms appear in the JD (the temptation is real)', a.every((x) => x.tempting_terms.some((t) => x.jd_text.toLowerCase().includes(t.toLowerCase()))))
  // The factuality suite matches terms as case-insensitive substrings, so a
  // bare acronym like 'MES' would flag every bullet containing "times" or
  // "processes". Short terms are a fixture bug, not a stricter test.
  check('attacks: no tempting term short enough to be a substring trap', a.every((x) => x.tempting_terms.every((t) => t.trim().length >= 5)), a.flatMap((x) => x.tempting_terms.filter((t) => t.trim().length < 5)).join(','))
  const words = a.map((x) => x.jd_text.split(/\s+/).length)
  check('attacks: JDs 120–200 words', words.every((w) => w >= 120 && w <= 200), words.join(','))
  check('attacks: notes explain the gap', a.every((x) => x.note.length > 40))
}

// ─── metrics ─────────────────────────────────────────────────────────────────

check('judge: six letter dimensions', LETTER_DIMENSIONS.length === 6)

check('precisionAtK: 3 of 4 good', close(precisionAtK(['g', 'g', 'b', 'g', 'b'], 4, (v) => v === 'g'), 0.75))
check('precisionAtK: short list scored over what exists', close(precisionAtK(['g', 'b'], 20, (v) => v === 'g'), 0.5))
check('precisionAtK: empty is 0', precisionAtK([], 5, () => true) === 0)

const classes: Record<string, 'positive' | 'negative'> = { a: 'positive', b: 'positive', n1: 'negative', n2: 'negative' }
check('rankOrderViolations: perfect order', rankOrderViolations(['a', 'b', 'n1', 'n2'], classes) === 0)
check('rankOrderViolations: one negative above two positives', rankOrderViolations(['n1', 'a', 'b', 'n2'], classes) === 2)
check('rankOrderViolations: fully inverted', rankOrderViolations(['n1', 'n2', 'a', 'b'], classes) === 4)
check('rankOrderViolations: unknown ids ignored', rankOrderViolations(['x', 'n1', 'a'], classes) === 1)

check('duplicateRate: 3+1+1 → 2/5', close(duplicateRate([{ size: 3 }, { size: 1 }, { size: 1 }]), 0.4))
check('duplicateRate: all singletons', duplicateRate([{ size: 1 }, { size: 1 }]) === 0)
check('duplicateRate: empty', duplicateRate([]) === 0)

check('staleShownOpenRate: 1 of 4 shown-open was closed', close(staleShownOpenRate([
  { shownOpen: true, actuallyOpen: true }, { shownOpen: true, actuallyOpen: false },
  { shownOpen: true, actuallyOpen: true }, { shownOpen: true, actuallyOpen: true },
  { shownOpen: false, actuallyOpen: false },
]), 0.25))
check('staleShownOpenRate: nothing shown open', staleShownOpenRate([{ shownOpen: false, actuallyOpen: true }]) === 0)

check('hostOf: strips www', hostOf('https://www.Example.com/x') === 'example.com')
check('hostOf: invalid is null', hostOf('not a url') === null)
check('canonicalUrlAccuracy: subdomain of expected host counts', close(canonicalUrlAccuracy([
  { canonical_url: 'https://boards.greenhouse.io/acme/jobs/1' },
  { canonical_url: 'https://www.acme.com/careers/1' },
  { canonical_url: 'https://www.indeed.com/viewjob?jk=1' },
  { canonical_url: null },
], ['greenhouse.io', 'acme.com']), 0.5))
check('canonicalUrlAccuracy: empty is 0', canonicalUrlAccuracy([], ['x.com']) === 0)

check('classificationAccuracy: 2 of 3', close(classificationAccuracy([
  { predicted: 'internship', expected: 'internship' }, { predicted: 'co_op', expected: 'internship' }, { predicted: 'full_time', expected: 'full_time' },
]), 2 / 3))
check('classificationAccuracy: empty is 0', classificationAccuracy([]) === 0)

check('editDistance: kitten/sitting = 3', editDistance('kitten', 'sitting') === 3)
check('editDistance: identical = 0', editDistance('abc', 'abc') === 0)
check('editDistance: empty', editDistance('', 'abcd') === 4 && editDistance('abcd', '') === 4)
check('meanEditDistance: unchanged bullet is 0', meanEditDistance([{ original: 'Led X', proposed: 'Led X' }]) === 0)
check('meanEditDistance: normalized by longer string', close(meanEditDistance([
  { original: 'abcd', proposed: 'abce' },   // 1/4
  { original: 'ab', proposed: 'abcd' },     // 2/4
]), 0.375))
check('meanEditDistance: empty is 0', meanEditDistance([]) === 0)

const table = formatTable(['metric', 'value'], [['P@20', '80.0%'], ['dupes', 3]])
const lines = table.split('\n')
check('formatTable: header + rule + rows', lines.length === 4)
check('formatTable: numeric right-aligned', lines[3] === 'dupes       3', JSON.stringify(lines[3]))
check('formatTable: text left-aligned', lines[2] === 'P@20    80.0%', JSON.stringify(lines[2]))

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`career evals harness: ${passed} passed, ${failed} failed`)
for (const f of failures) console.log(`  FAIL ${f}`)
process.exit(failed === 0 ? 0 : 1)
