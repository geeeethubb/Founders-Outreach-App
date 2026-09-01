// Offline tests for the best-opportunities queue.
//
// The subject is `bestOpportunities` — the pure function that decides which
// postings the founder is shown as "do these next", and which ones quietly
// leave the screen. Both halves are worth this much testing: a ranking that
// lets freshness outvote a fit evaluation sends someone to write a package for
// the wrong job, and an exclusion that is not counted is how a queue that has
// silently broken looks exactly like a queue with nothing to do.
//
// Every row is hand-built and the clock is passed in, so nothing here depends
// on the date, a database, a key or a model.
//
//   npx tsx scripts/test-career-queue.ts

import {
  QUEUE_TERMS,
  ageOf,
  alreadyApplied,
  bestOpportunities,
  fitValueOf,
  freshnessBonus,
  queueHeadline,
  type QueueJob,
} from '../lib/career/jobs/queue'
import { fitBand } from '../lib/career/fit/dimensions'
import { relevanceContext, type InboxRelevance } from '../lib/career/jobs/inbox-relevance'
import type { CareerMissionPreferences } from '../lib/career/types'

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

const NOW = new Date('2026-09-01T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

let seq = 0
/** An open, undismissed, unapplied, unscored posting seen yesterday. Each test breaks one thing. */
function job(over: Partial<QueueJob> = {}): QueueJob {
  seq++
  return {
    id: `j${seq}`,
    title: 'Process Engineering Intern',
    company_name: 'Acme',
    verification_status: 'VERIFIED_OPEN',
    disposition: 'new',
    fit_overall: null,
    posted_at: null,
    first_seen_at: daysAgo(1),
    ...over,
  }
}

const ids = (r: { jobs: { id: string }[] }) => r.jobs.map((j) => j.id).join(',')
const rel = (score: number): InboxRelevance => ({ score, band: score >= 0.62 ? 'strong' : score >= 0.4 ? 'possible' : 'off', reasons: [] })

function main(): void {
  console.log('nothing in, nothing out')
  {
    const r = bestOpportunities([], { now: NOW })
    check('an empty queue returns an empty list', r.jobs.length === 0)
    check('and zeroed counts rather than undefined', r.excluded.closed === 0 && r.excluded.dismissed === 0 && r.excluded.applied === 0 && r.excluded.lowFit === 0)
    check('an empty queue still produces a headline', queueHeadline(r) === '0 to do', queueHeadline(r))
    // No options at all: the founder's first call must not throw on a missing clock.
    check('no options at all is safe', bestOpportunities([]).jobs.length === 0)
  }

  console.log('\nwhat leaves the queue, and whether it says so')
  {
    const rows = [
      job({ id: 'open', fit_overall: 0.8 }),
      job({ id: 'closed', verification_status: 'CLOSED', fit_overall: 0.9 }),
      job({ id: 'stale', verification_status: 'STALE', fit_overall: 0.9 }),
      job({ id: 'errored', verification_status: 'ERROR', fit_overall: 0.9 }),
      job({ id: 'dismissed', disposition: 'dismissed', fit_overall: 0.9 }),
      job({ id: 'applied', application_state: 'APPLIED', fit_overall: 0.9 }),
      job({ id: 'offered', applications: [{ state: 'OFFER' }], fit_overall: 0.9 }),
      job({ id: 'weak', fit_overall: 0.2 }),
    ]
    const r = bestOpportunities(rows, { now: NOW })
    check('only the actionable posting survives', ids(r) === 'open', ids(r))
    check('closed, stale and errored all count as closed', r.excluded.closed === 3, String(r.excluded.closed))
    check('a dismissed posting is counted, not vanished', r.excluded.dismissed === 1)
    check('applied is counted from either shape of the row', r.excluded.applied === 2, String(r.excluded.applied))
    check('a scored-and-rejected posting is counted as low fit', r.excluded.lowFit === 1)
    // The invariant the headline stands on: every input row is in exactly one place.
    const total = r.jobs.length + r.excluded.closed + r.excluded.dismissed + r.excluded.applied + r.excluded.lowFit
    check('the buckets partition the input', total === rows.length, `${total} of ${rows.length}`)
    check('the headline names every removal', queueHeadline(r) === '1 to do — 2 applied, 1 dismissed, 3 closed, 1 below fit', queueHeadline(r))
  }
  {
    // Two reasons to remove one row must still be one increment, or the counts
    // stop adding up and the sentence starts lying.
    const r = bestOpportunities([job({ disposition: 'dismissed', verification_status: 'CLOSED' })], { now: NOW })
    const total = r.excluded.closed + r.excluded.dismissed + r.excluded.applied + r.excluded.lowFit
    check('a doubly-excluded posting is counted once', total === 1, `closed ${r.excluded.closed}, dismissed ${r.excluded.dismissed}`)
    check('and by the decision closest to the founder', r.excluded.dismissed === 1)
  }

  console.log('\nwhere the application already is')
  {
    check('APPLIED is applied', alreadyApplied('APPLIED'))
    check('and so is everything past it', ['OA', 'INTERVIEW', 'FINAL_ROUND', 'OFFER', 'REJECTED', 'WITHDRAWN', 'CLOSED'].every(alreadyApplied))
    // The whole point of one-click generation is that a finished package is
    // waiting for someone. Hiding it would be the queue undoing that work.
    check('a package waiting to be sent is NOT applied', !['DISCOVERED', 'SAVED', 'RESEARCHED', 'PREPARING', 'READY_FOR_REVIEW', 'READY_TO_APPLY'].some(alreadyApplied))
    check('no application at all is not applied', !alreadyApplied(null))
    check('an unknown state is not applied', !alreadyApplied('SOMETHING_ELSE'))
    const r = bestOpportunities([job({ id: 'ready', application_state: 'READY_TO_APPLY', fit_overall: 0.7 })], { now: NOW })
    check('and it stays at the top of the queue', ids(r) === 'ready' && r.excluded.applied === 0)
  }

  console.log('\nfit leads; freshness only breaks a near-tie')
  {
    const r = bestOpportunities(
      [job({ id: 'stale', fit_overall: 0.8, first_seen_at: daysAgo(60) }), job({ id: 'fresh', fit_overall: 0.8, first_seen_at: daysAgo(0) })],
      { now: NOW }
    )
    check('at equal fit the fresher posting leads', ids(r) === 'fresh,stale', ids(r))
    check('and the bonus it won is bounded', r.jobs[0].ranking.freshness === QUEUE_TERMS.freshnessMax)
    check('a month-old posting earns nothing for freshness', r.jobs[1].ranking.freshness === 0)
  }
  {
    const r = bestOpportunities(
      [job({ id: 'fresh70', fit_overall: 0.7, first_seen_at: daysAgo(0) }), job({ id: 'stale90', fit_overall: 0.9, first_seen_at: daysAgo(90) })],
      { now: NOW }
    )
    check('freshness alone cannot beat a much better fit', ids(r) === 'stale90,fresh70', ids(r))
  }
  {
    // A whole band of fit is 0.13 wide at its narrowest. Freshness is capped at
    // less than half of that, so it can reorder inside a band and never across one.
    const r = bestOpportunities(
      [job({ id: 'good_fresh', fit_overall: 0.62, first_seen_at: daysAgo(0) }), job({ id: 'strong_stale', fit_overall: 0.75, first_seen_at: daysAgo(120) })],
      { now: NOW }
    )
    check('a STRONG stale posting outranks a GOOD fresh one', ids(r) === 'strong_stale,good_fresh', ids(r))
    check('the cap is under the narrowest band', QUEUE_TERMS.freshnessMax < 0.75 - 0.62)
    check('bands are read from fitBand, not restated here', fitBand(0.75) === 'STRONG' && fitBand(0.62) === 'GOOD')
  }
  {
    check('freshness decays linearly across the window', Math.abs(freshnessBonus(15) - QUEUE_TERMS.freshnessMax / 2) < 1e-9, String(freshnessBonus(15)))
    check('and stops at zero rather than going negative', freshnessBonus(400) === 0)
    check('an unknown age earns nothing — unknown is not fresh', freshnessBonus(null) === 0)
  }

  console.log('\nan unscored posting is unknown, not bad')
  {
    const r = bestOpportunities([job({ id: 'unscored' })], { now: NOW })
    check('it appears in the queue at all', ids(r) === 'unscored')
    check('it is marked as unscored, not as a 49% job', r.jobs[0].ranking.scored === false && r.jobs[0].ranking.band === null)
    check('and it says so in plain words', r.jobs[0].ranking.reasons.some((x) => /no fit evaluation yet/.test(x)), r.jobs[0].ranking.reasons.join(' · '))
  }
  {
    // The hard guarantee, at its worst case: the highest prior an unscored row
    // can reach (max relevance + max freshness) against the lowest GOOD fit.
    const ceiling = QUEUE_TERMS.unscoredFloor + QUEUE_TERMS.unscoredRelevanceSpan + QUEUE_TERMS.freshnessMax
    check('the unscored prior can never reach the GOOD floor', ceiling < 0.62, ceiling.toFixed(3))
    const r = bestOpportunities(
      [
        job({ id: 'unscored_perfect', relevance: rel(1), first_seen_at: daysAgo(0) }),
        job({ id: 'good_stale', fit_overall: 0.62, first_seen_at: daysAgo(365) }),
      ],
      { now: NOW }
    )
    check('so a genuinely good scored job always leads it', ids(r) === 'good_stale,unscored_perfect', ids(r))
  }
  {
    // …and the other direction: a posting the evaluator read and liked less than
    // an unknown one does not get to sit above it just for having been read.
    const r = bestOpportunities([job({ id: 'scored50', fit_overall: 0.5, first_seen_at: daysAgo(60) }), job({ id: 'unscored' })], { now: NOW })
    check('an unknown outranks a barely-passing evaluation', ids(r) === 'unscored,scored50', ids(r))
  }
  {
    const r = bestOpportunities([job({ id: 'unscored' })], { now: NOW, minFit: 0.95 })
    check('raising the fit bar never excludes an unscored posting', ids(r) === 'unscored' && r.excluded.lowFit === 0)
  }
  {
    const r = bestOpportunities(
      [job({ id: 'off', relevance: rel(0.2) }), job({ id: 'strong', relevance: rel(0.9) }), job({ id: 'possible', relevance: rel(0.5) })],
      { now: NOW }
    )
    check('unscored postings sort by direction relevance', ids(r) === 'strong,possible,off', ids(r))
  }
  {
    const ctx = relevanceContext({
      season: 'summer_2027',
      preferences: {
        geo_tiers: [], company_types: [], role_families: [], industries: [], optimize_for: [], work_modes: [],
        direction: 'chemical engineering, process development',
      } as CareerMissionPreferences,
      hard_constraints: [],
    })
    const r = bestOpportunities(
      [job({ id: 'chem', title: 'Chemical Engineering Intern' }), job({ id: 'ml', title: 'Machine Learning Research Intern' })],
      { now: NOW, relevanceContext: ctx }
    )
    check('a context scores rows that carry no relevance', r.jobs.every((j) => j.ranking.relevance !== null))
    check('and the on-direction unknown leads', ids(r) === 'chem,ml', ids(r))
  }

  console.log('\nthe fit bar')
  {
    const rows = [job({ id: 'at', fit_overall: QUEUE_TERMS.minFit }), job({ id: 'under', fit_overall: QUEUE_TERMS.minFit - 0.01 })]
    const r = bestOpportunities(rows, { now: NOW })
    check('the bar is inclusive at the MAYBE floor', ids(r) === 'at', ids(r))
    check('and one point under is counted, not dropped', r.excluded.lowFit === 1)
    check('the default bar is fitBand’s own line', fitBand(QUEUE_TERMS.minFit) === 'MAYBE' && fitBand(QUEUE_TERMS.minFit - 0.01) === 'WEAK')
    const raised = bestOpportunities(rows, { now: NOW, minFit: 0.9 })
    check('the caller can raise it', raised.jobs.length === 0 && raised.excluded.lowFit === 2)
  }

  console.log('\nno clock, no freshness — and no crash')
  {
    const rows = [job({ id: 'fresh', fit_overall: 0.7, first_seen_at: daysAgo(0) }), job({ id: 'stale', fit_overall: 0.8, first_seen_at: daysAgo(200) })]
    const r = bestOpportunities(rows)
    check('without a clock the ranking is fit alone', ids(r) === 'stale,fresh', ids(r))
    check('no age is claimed', r.jobs.every((j) => j.ranking.ageDays === null && j.ranking.ageBasis === null))
    check('and no freshness is applied', r.jobs.every((j) => j.ranking.freshness === 0))
    check('a garbage clock degrades the same way', bestOpportunities(rows, { now: 'not a date' }).jobs[0].ranking.ageDays === null)
  }

  console.log('\nhow old is it, and by which date')
  {
    const posted = ageOf(job({ posted_at: daysAgo(3), first_seen_at: daysAgo(1) }), NOW.getTime())
    check('the board’s own date wins when there is one', posted.basis === 'posted' && Math.round(posted.days ?? -1) === 3)
    const seen = ageOf(job({ posted_at: null, first_seen_at: daysAgo(5) }), NOW.getTime())
    check('otherwise first_seen_at — a board with no date is not infinitely old', seen.basis === 'first seen' && Math.round(seen.days ?? -1) === 5)
    const none = ageOf(job({ posted_at: null, first_seen_at: null }), NOW.getTime())
    check('with neither date the age is unknown, not zero', none.days === null && none.basis === null)
    const bad = ageOf(job({ posted_at: 'yesterday-ish', first_seen_at: daysAgo(2) }), NOW.getTime())
    check('an unparseable date falls through to the next one', bad.basis === 'first seen')
    const future = ageOf(job({ posted_at: new Date(NOW.getTime() + 86_400_000).toISOString() }), NOW.getTime())
    check('a future-dated posting clamps to zero days', future.days === 0)
    check('so it cannot earn more than the cap', freshnessBonus(future.days) === QUEUE_TERMS.freshnessMax)
  }

  console.log('\nreading a row the way Postgres hands it over')
  {
    check('a numeric arrives as a string and still ranks', fitValueOf('0.81') === 0.81)
    check('null stays unscored', fitValueOf(null) === null && fitValueOf(undefined) === null)
    check('nonsense is unscored, never zero', fitValueOf('n/a') === null)
    check('and it is clamped to 0-1', fitValueOf(1.4) === 1 && fitValueOf(-0.2) === 0)
    const r = bestOpportunities([job({ id: 'str', fit_overall: '0.81' })], { now: NOW })
    check('a string fit is a real evaluation', r.jobs[0].ranking.scored && r.jobs[0].ranking.band === 'STRONG')
  }

  console.log('\nhow sure we have to be that it is open')
  {
    const rows = [job({ id: 'verified', verification_status: 'VERIFIED_OPEN' }), job({ id: 'likely', verification_status: 'LIKELY_OPEN' }), job({ id: 'unverified', verification_status: 'UNVERIFIED' })]
    check('the default keeps everything not known closed', bestOpportunities(rows, { now: NOW }).jobs.length === 3)
    check('likely narrows to two', bestOpportunities(rows, { now: NOW, freshness: 'likely' }).jobs.length === 2)
    const strict = bestOpportunities(rows, { now: NOW, freshness: 'verified' })
    check('verified narrows to one', ids(strict) === 'verified', ids(strict))
    check('and says what it removed', strict.excluded.closed === 2, String(strict.excluded.closed))
    const missing = bestOpportunities([job({ id: 'x', verification_status: null })], { now: NOW })
    check('a row with no status is treated as unverified, not as closed', ids(missing) === 'x')
  }

  console.log('\neligibility is a flag, not a rank input')
  {
    const r = bestOpportunities(
      [job({ id: 'unqualified', fit_overall: 0.8, fit_eligibility: 'NOT_QUALIFIED' }), job({ id: 'qualified', fit_overall: 0.7, fit_eligibility: 'QUALIFIED' })],
      { now: NOW }
    )
    check('a NOT_QUALIFIED posting is shown, not hidden', r.jobs.length === 2)
    check('and not demoted for it', ids(r) === 'unqualified,qualified', ids(r))
    check('but it is labelled', r.jobs[0].ranking.reasons.some((x) => /not qualified/i.test(x)), r.jobs[0].ranking.reasons.join(' · '))
  }

  console.log('\nsame input, same answer')
  {
    const rows = [job({ id: 'a', fit_overall: 0.7 }), job({ id: 'b', fit_overall: 0.7 }), job({ id: 'c', fit_overall: 0.7 })]
    const first = bestOpportunities(rows, { now: NOW })
    const second = bestOpportunities(rows, { now: NOW })
    check('ties keep the order they arrived in', ids(first) === 'a,b,c', ids(first))
    check('and the ranking is reproducible', ids(first) === ids(second))
    check('ranks are 1-based and contiguous', first.jobs.every((j, i) => j.ranking.rank === i + 1))
    check('the input array is untouched', rows.length === 3 && rows[0].id === 'a')
    check('and so are the input rows', !('ranking' in (rows[0] as object)))
    check('the returned rows carry their original columns', first.jobs[0].title === 'Process Engineering Intern' && first.jobs[0].company_name === 'Acme')
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

main()
