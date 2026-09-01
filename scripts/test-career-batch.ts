// Offline tests for batch package generation.
//
// The subject is the scheduler, not the packages: does the pool stay bounded,
// does one job's failure leave the other four alone, and do the counts a
// progress UI shows agree with the items it will eventually render. Every one
// of those is a promise made to someone spending ~$0.50 a job and watching.
//
// No network, no keys, no database — `generateCompletePackage` is injected.
//
//   npx tsx scripts/test-career-batch.ts

import {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_JOBS,
  runPackageBatch,
  summarizeBatch,
  type BatchItem,
  type BatchItemState,
} from '../lib/career/package/batch'
import type { AutoPackageResult } from '../lib/career/package/auto'

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

type Generate = NonNullable<NonNullable<Parameters<typeof runPackageBatch>[0]['deps']>['generate']>

function autoResult(over: Partial<AutoPackageResult> = {}): AutoPackageResult {
  return {
    packageId: 'pkg-1',
    outcome: 'ready_to_apply',
    status: 'ready_to_apply',
    stage: null,
    version: 1,
    applicationId: null,
    attention: [],
    resume: { proposed: 0, applied: 0, rejected: 0, summary: '', noChangeReason: null },
    letter: null,
    documents: { resumeDocx: 'r.docx', resumePdf: null, coverDocx: null, coverPdf: null },
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    costUsd: 0.5,
    elapsedMs: 1000,
    warnings: [],
    errors: [],
    migrationMissing: false,
    ...over,
  }
}

function item(over: Partial<BatchItem> & { state: BatchItemState }): BatchItem {
  return { jobId: 'j', packageId: null, outcome: null, attention: [], costUsd: 0, elapsedMs: 0, error: null, ...over }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A fake generate that watches the pool: it holds each call open long enough
 * for the others to pile up behind it, and records the high-water mark. Without
 * the delay every call would resolve before the next started and a broken pool
 * would still look bounded.
 */
function poolWatcher(behaviour?: (jobId: string) => Promise<AutoPackageResult>) {
  const state = { inFlight: 0, maxInFlight: 0, calls: [] as { userId: string; jobId: string; renderPdf?: boolean }[] }
  const generate: Generate = async (params) => {
    state.calls.push({ userId: params.userId, jobId: params.jobId, renderPdf: params.renderPdf })
    state.inFlight++
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    try {
      await tick()
      return behaviour ? await behaviour(params.jobId) : autoResult({ packageId: `pkg-${params.jobId}` })
    } finally {
      state.inFlight--
    }
  }
  return { state, generate }
}

async function main(): Promise<void> {
  console.log('summarizeBatch: one place the counting happens')
  {
    const items = [
      item({ state: 'queued' }),
      item({ state: 'generating' }),
      item({ state: 'ready', costUsd: 0.5 }),
      item({ state: 'ready', costUsd: 0.25 }),
      item({ state: 'needs_attention', costUsd: 0.4 }),
      item({ state: 'failed' }),
    ]
    const s = summarizeBatch(items)
    check('every state is counted once', s.total === 6 && s.queued === 1 && s.generating === 1 && s.ready === 2 && s.needsAttention === 1 && s.failed === 1, JSON.stringify(s))
    check('the counts add up to the total', s.queued + s.generating + s.ready + s.needsAttention + s.failed === s.total)
    check('cost is the sum, rounded like the rest of the system', s.costUsd === 1.15, `${s.costUsd}`)
    check('an empty batch summarizes to zeros', summarizeBatch([]).total === 0 && summarizeBatch([]).costUsd === 0)
    // Pure: it must not be reading or mutating anything.
    const before = JSON.stringify(items)
    summarizeBatch(items)
    check('summarizing does not touch the items', JSON.stringify(items) === before)
  }

  console.log('\nbounded concurrency: the pool is actually bounded')
  {
    const { state, generate } = poolWatcher()
    const jobs = ['a', 'b', 'c', 'd', 'e', 'f']
    const r = await runPackageBatch({ userId: 'u', jobIds: jobs, concurrency: 2, deps: { generate } })
    check('never more than 2 packages in flight', state.maxInFlight <= 2, `max ${state.maxInFlight}`)
    // The other half of the promise: a pool that quietly ran serially would
    // pass the bound above and take six times as long.
    check('and both workers were genuinely used', state.maxInFlight === 2, `max ${state.maxInFlight}`)
    check('every job still ran', state.calls.length === 6 && r.items.length === 6)
    check('results keep the caller’s order', r.items.map((i) => i.jobId).join('') === 'abcdef', r.items.map((i) => i.jobId).join(''))
  }
  {
    const { state, generate } = poolWatcher()
    await runPackageBatch({ userId: 'u', jobIds: ['a', 'b', 'c'], concurrency: 1, deps: { generate } })
    check('concurrency 1 is strictly serial', state.maxInFlight === 1, `max ${state.maxInFlight}`)
  }
  {
    const { state, generate } = poolWatcher()
    const r = await runPackageBatch({ userId: 'u', jobIds: ['a', 'b'], concurrency: 10, deps: { generate } })
    check('asking for more workers than jobs starts only as many as there are jobs', state.maxInFlight === 2, `max ${state.maxInFlight}`)
    check('the reported concurrency is what was allowed', r.concurrency === 10, `${r.concurrency}`)
  }
  {
    const { state, generate } = poolWatcher()
    await runPackageBatch({ userId: 'u', jobIds: ['a', 'b', 'c', 'd'], deps: { generate } })
    check(`the default pool is ${DEFAULT_BATCH_CONCURRENCY}`, state.maxInFlight === DEFAULT_BATCH_CONCURRENCY, `max ${state.maxInFlight}`)
  }
  {
    // A 0 from a query string must not stall the batch forever.
    const { state, generate } = poolWatcher()
    const r = await runPackageBatch({ userId: 'u', jobIds: ['a', 'b'], concurrency: 0, deps: { generate } })
    check('concurrency 0 is clamped to 1, not to a stall', r.concurrency === 1 && state.calls.length === 2, `${r.concurrency}`)
    const nan = await runPackageBatch({ userId: 'u', jobIds: ['a'], concurrency: Number.NaN, deps: { generate } })
    check('NaN falls back to the default', nan.concurrency === DEFAULT_BATCH_CONCURRENCY, `${nan.concurrency}`)
  }

  console.log('\none job failing does not stop the batch')
  {
    const { state, generate } = poolWatcher(async (jobId) => {
      if (jobId === 'b') throw new Error('anthropic 529 overloaded')
      return autoResult({ packageId: `pkg-${jobId}` })
    })
    const r = await runPackageBatch({ userId: 'u', jobIds: ['a', 'b', 'c', 'd', 'e'], concurrency: 2, deps: { generate } })
    check('the batch resolved rather than rejecting', r.items.length === 5)
    check('the other four finished', r.snapshot.ready === 4, JSON.stringify(r.snapshot))
    check('the failure is one item, marked failed', r.snapshot.failed === 1)
    const failedItem = r.items.find((i) => i.state === 'failed')
    check('the thrown message is kept', failedItem?.error === 'anthropic 529 overloaded', failedItem?.error ?? 'none')
    check('a failed job is timed like any other', (failedItem?.elapsedMs ?? -1) >= 0)
    check('a failed job contributes no cost it cannot account for', failedItem?.costUsd === 0)
    check('every job was still attempted', state.calls.length === 5)
    check('the total only counts what succeeded', r.snapshot.costUsd === 2, `${r.snapshot.costUsd}`)
  }
  {
    // A non-Error throw (a string, a rejected fetch body) must still be readable.
    const generate: Generate = async () => {
      throw 'migration 014 not applied'
    }
    const r = await runPackageBatch({ userId: 'u', jobIds: ['a'], deps: { generate } })
    check('a non-Error throw is still reported as text', r.items[0].error === 'migration 014 not applied', r.items[0].error ?? 'none')
  }

  console.log('\noutcomes map to states, and attention survives')
  {
    const generate: Generate = async (params) =>
      params.jobId === 'needy'
        ? autoResult({
            outcome: 'needs_attention',
            packageId: 'pkg-needy',
            attention: [{ code: 'no_apply_url', what: 'no link', why: 'nowhere to submit', action: 'add the URL' }],
            costUsd: 0.3,
          })
        : autoResult({ packageId: 'pkg-fine' })
    const r = await runPackageBatch({ userId: 'u', jobIds: ['fine', 'needy'], deps: { generate } })
    check('ready_to_apply → ready', r.items[0].state === 'ready' && r.items[0].outcome === 'ready_to_apply')
    check('needs_attention → needs_attention', r.items[1].state === 'needs_attention')
    check('the attention list is carried through, not summarized away', r.items[1].attention[0]?.code === 'no_apply_url')
    check('needs_attention is not an error', r.items[1].error === null)
    check('a package id is kept even when the package needs attention', r.items[1].packageId === 'pkg-needy')
    check('cost is per item and summed', r.items[0].costUsd === 0.5 && r.snapshot.costUsd === 0.8, `${r.snapshot.costUsd}`)
  }

  console.log('\nduplicates are collapsed before anything is paid for')
  {
    const { state, generate } = poolWatcher()
    const r = await runPackageBatch({ userId: 'u', jobIds: ['a', 'b', 'a', '  a  ', 'b'], deps: { generate } })
    check('the same job is generated once', state.calls.length === 2, `${state.calls.length} calls`)
    check('only unique jobs become items', r.items.map((i) => i.jobId).join(',') === 'a,b')
    check('the drops are reported, not hidden', r.duplicatesDropped === 3, `${r.duplicatesDropped}`)
    const blank = await runPackageBatch({ userId: 'u', jobIds: ['', '   '], deps: { generate } })
    check('blank ids are not jobs', blank.items.length === 0 && state.calls.length === 2)
  }

  console.log('\nthe cap is a hard stop, and it counts unique jobs')
  {
    const tooMany = Array.from({ length: MAX_BATCH_JOBS + 1 }, (_, i) => `j${i}`)
    const { state, generate } = poolWatcher()
    let message = ''
    try {
      await runPackageBatch({ userId: 'u', jobIds: tooMany, deps: { generate } })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    check('over the cap throws', message.length > 0)
    check('the message says the count and the cap', message.includes(`${MAX_BATCH_JOBS + 1}`) && message.includes(`${MAX_BATCH_JOBS}`), message)
    check('the message says why it matters', /money|cost/i.test(message), message)
    check('nothing was generated before the throw', state.calls.length === 0)
  }
  {
    // Repeats above the cap that collapse under it are a UI mistake, not a bill.
    const { state, generate } = poolWatcher()
    const repeated = Array.from({ length: MAX_BATCH_JOBS + 10 }, (_, i) => `j${i % 3}`)
    const r = await runPackageBatch({ userId: 'u', jobIds: repeated, deps: { generate } })
    check('duplicates over the cap collapse instead of throwing', r.items.length === 3 && state.calls.length === 3, `${r.items.length}`)
  }
  {
    const { state, generate } = poolWatcher()
    const exact = Array.from({ length: MAX_BATCH_JOBS }, (_, i) => `j${i}`)
    const r = await runPackageBatch({ userId: 'u', jobIds: exact, concurrency: 5, deps: { generate } })
    check('exactly the cap is allowed', r.items.length === MAX_BATCH_JOBS && state.calls.length === MAX_BATCH_JOBS)
  }

  console.log('\nonUpdate: what a progress UI sees')
  {
    const { generate } = poolWatcher()
    const snapshots: ReturnType<typeof summarizeBatch>[] = []
    const seenLists: BatchItemState[][] = []
    const frames: BatchItem[][] = []
    const r = await runPackageBatch({
      userId: 'u',
      jobIds: ['a', 'b', 'c', 'd', 'e'],
      concurrency: 2,
      deps: { generate },
      onUpdate: (s, items) => {
        snapshots.push(s)
        seenLists.push(items.map((i) => i.state))
        frames.push([...items])
      },
    })
    check('onUpdate fired', snapshots.length > 0, `${snapshots.length} updates`)
    check('the first update is the whole queue, before any paid call', snapshots[0].queued === 5 && snapshots[0].generating === 0, JSON.stringify(snapshots[0]))
    check('there is an update for every state change plus the initial paint', snapshots.length === 11, `${snapshots.length}`)
    check('every snapshot is internally consistent',
      snapshots.every((s) => s.queued + s.generating + s.ready + s.needsAttention + s.failed === s.total && s.total === 5))
    // The founder's sentence: "5 jobs, 2 complete, 2 generating, 1 queued".
    check('a mid-run snapshot shows work finished, work running and work waiting',
      snapshots.some((s) => s.ready > 0 && s.generating > 0 && s.queued > 0),
      JSON.stringify(snapshots.map((s) => `${s.ready}/${s.generating}/${s.queued}`)))
    check('cost climbs as jobs finish', snapshots[snapshots.length - 1].costUsd > snapshots[0].costUsd)

    const last = snapshots[snapshots.length - 1]
    check('the final snapshot matches the returned snapshot', JSON.stringify(last) === JSON.stringify(r.snapshot), JSON.stringify(last))
    check('and the returned snapshot matches the returned items', JSON.stringify(r.snapshot) === JSON.stringify(summarizeBatch(r.items)))
    check('nothing is left queued or generating at the end', last.queued === 0 && last.generating === 0)
    check('the items are handed to the callback, not just the counts', seenLists[0].length === 5 && seenLists[0].every((s) => s === 'queued'))
    // Each update is its own frame. A UI that kept the first one and diffed
    // against the last must not find that both say the same thing.
    check('an update is a snapshot in time, not a live array', frames[0][0].state === 'queued' && frames[frames.length - 1][0].state === 'ready')
    check('and the frames are separate objects', frames[0][0] !== frames[frames.length - 1][0])
  }

  console.log('\nwhat is passed through to generation')
  {
    const { state, generate } = poolWatcher()
    await runPackageBatch({ userId: 'user-42', jobIds: ['a'], renderPdf: true, deps: { generate } })
    check('the user id reaches the package call', state.calls[0].userId === 'user-42')
    check('--pdf reaches the package call', state.calls[0].renderPdf === true)
    const plain = poolWatcher()
    await runPackageBatch({ userId: 'user-42', jobIds: ['a'], deps: { generate: plain.generate } })
    check('DOCX-only is the default', plain.state.calls[0].renderPdf === undefined, String(plain.state.calls[0].renderPdf))
  }
  {
    const { state, generate } = poolWatcher()
    const r = await runPackageBatch({ userId: 'u', jobIds: [], deps: { generate } })
    check('an empty batch generates nothing and returns zeros', state.calls.length === 0 && r.snapshot.total === 0)
    check('an empty batch still has a timing', r.elapsedMs >= 0)
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
