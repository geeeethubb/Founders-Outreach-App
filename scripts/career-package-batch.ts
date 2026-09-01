// Several jobs → several application packages, from the command line.
//
//   npx tsx scripts/career-package-batch.ts --jobs <id,id,id> [--user <id>] [--concurrency N] [--pdf]
//
// Each job runs the full one-click path — generate → approve every safe change
// → documents → finalize — a couple at a time. One job failing prints its
// error and the rest keep going, so a batch always ends with a table saying
// what you actually have.
//
// DOCX only unless --pdf: rendering costs ~106 s of Word per document and the
// DOCX is what you submit. Nothing here submits anything; it produces files.

import { defaultProfiles } from './lib/cli-user'
import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_JOBS, runPackageBatch, type BatchItemState } from '../lib/career/package/batch'

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function money(n: number): string {
  return `$${n.toFixed(4)}`
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

/** Enough of a uuid to recognize a row by, in a line that has to stay narrow. */
function short(jobId: string): string {
  return jobId.length > 12 ? `${jobId.slice(0, 8)}…` : jobId
}

const LABEL: Record<BatchItemState, string> = {
  queued: 'queued',
  generating: 'generating',
  ready: 'READY TO APPLY',
  needs_attention: 'needs attention',
  failed: 'FAILED',
}

async function main(): Promise<void> {
  const jobIds = (opt('jobs') ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!jobIds.length) throw new Error('pass --jobs <id,id,id>')

  let userId = opt('user')
  if (!userId) {
    const { data } = await defaultProfiles()
    userId = (data?.[0] as { id: string } | undefined)?.id
  }
  if (!userId) throw new Error('no user — pass --user <id>')

  const concurrency = opt('concurrency') ? Number(opt('concurrency')) : DEFAULT_BATCH_CONCURRENCY
  const renderPdf = process.argv.includes('--pdf')

  console.log(`\nPACKAGE BATCH — ${jobIds.length} job(s) → user ${userId}`)
  console.log(`  ${concurrency} at a time · ${renderPdf ? 'DOCX + PDF' : 'DOCX only'} · cap ${MAX_BATCH_JOBS}\n`)

  // The snapshot alone would print the same counts twice whenever two jobs
  // change between emissions, so the previous state per job is what decides
  // whether a line is worth printing. Seeded as queued so the opening paint —
  // every job queued, which the header already said — prints nothing.
  const lastState = new Map<string, BatchItemState>(jobIds.map((id) => [id, 'queued']))
  const batch = await runPackageBatch({
    userId,
    jobIds,
    concurrency,
    renderPdf,
    onUpdate: (snapshot, items) => {
      const changed = items.filter((i) => lastState.get(i.jobId) !== i.state)
      for (const i of changed) lastState.set(i.jobId, i.state)
      if (!changed.length) return
      for (const i of changed) {
        const done = i.state === 'ready' || i.state === 'needs_attention' || i.state === 'failed'
        const tail = done ? ` · ${money(i.costUsd)} · ${secs(i.elapsedMs)}${i.error ? ` · ${i.error}` : ''}` : ''
        console.log(`  ${short(i.jobId)}  ${LABEL[i.state]}${tail}`)
      }
      console.log(
        `    ${snapshot.ready} ready · ${snapshot.needsAttention} needs attention · ${snapshot.failed} failed · ` +
          `${snapshot.generating} generating · ${snapshot.queued} queued · ${money(snapshot.costUsd)}`
      )
    },
  })

  if (batch.duplicatesDropped) console.log(`\n  (${batch.duplicatesDropped} duplicate job id(s) collapsed)`)

  console.log('\nRESULT')
  console.log(`  ${'job'.padEnd(38)}${'state'.padEnd(17)}${'cost'.padEnd(10)}${'time'.padEnd(8)}package`)
  for (const i of batch.items) {
    console.log(`  ${i.jobId.padEnd(38)}${LABEL[i.state].padEnd(17)}${money(i.costUsd).padEnd(10)}${secs(i.elapsedMs).padEnd(8)}${i.packageId ?? '-'}`)
  }

  for (const i of batch.items) {
    if (i.state === 'ready') continue
    console.log(`\n  ${short(i.jobId)} — ${LABEL[i.state]}`)
    if (i.error) console.log(`    ${i.error}`)
    for (const a of i.attention) {
      console.log(`    [${a.code}] ${a.what}`)
      console.log(`      why: ${a.why}`)
      console.log(`      do:  ${a.action}`)
    }
  }

  const s = batch.snapshot
  console.log(
    `\nTOTAL: ${money(s.costUsd)} · ${secs(batch.elapsedMs)} · ` +
      `${s.ready}/${s.total} ready to apply, ${s.needsAttention} need attention, ${s.failed} failed`
  )

  // Needing attention is a real answer — the pipeline caught something and said
  // what. Only a job that threw means the run itself did not do its job.
  process.exitCode = s.failed > 0 ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
