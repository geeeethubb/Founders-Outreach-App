// Build or refresh the searchable index over the existing contact database.
//
//   npm run index:network              incremental — only what changed
//   npm run index:network -- --force   re-classify everything (taxonomy change)
//   npm run index:network -- --limit 60   cap classifications, for a first look
//   npm run index:network -- --dry     build in memory, write nothing
//
// Cost: one cheap batched model call per ~15 unclassified contacts, once.
// Everything already classified and unchanged is free.

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null
}
const flag = (name: string) => process.argv.includes(`--${name}`)

async function main() {
  const { buildContactIndex, buildIndexRows } = await import('../lib/network/indexer')
  const { createServiceClient } = await import('../lib/supabase/server')

  const supabase = createServiceClient()
  const { data: profiles, error } = await supabase.from('profiles').select('id, email').limit(5)
  if (error || !profiles?.length) {
    console.error('Could not read profiles:', error?.message ?? 'none found')
    process.exit(1)
  }

  const userId = arg('user') ?? profiles[0].id
  console.log(`Indexing network for ${profiles.find((p) => p.id === userId)?.email ?? userId}\n`)

  const opts = {
    userId,
    force: flag('force'),
    maxClassify: arg('limit') ? Number(arg('limit')) : undefined,
    onProgress: (m: string) => console.log(`  ${m}`),
  }

  const started = Date.now()
  const result = flag('dry') ? await buildIndexRows(opts) : await buildContactIndex(opts)

  console.log('\n─── Result ───')
  console.log(`  contacts seen      ${result.contactsSeen}`)
  console.log(`  rows written       ${result.rowsWritten}${flag('dry') ? ' (dry run)' : ''}`)
  console.log(`  newly classified   ${result.classified}`)
  console.log(`  unchanged, skipped ${result.skippedUnchanged}`)
  console.log(`  model calls        ${result.modelCalls}`)
  console.log(`  cost               $${result.costUsd.toFixed(4)}`)
  console.log(`  elapsed            ${Math.round((Date.now() - started) / 1000)}s`)

  if (result.errors.length) {
    console.log('\n─── Issues ───')
    for (const e of result.errors.slice(0, 12)) console.log(`  · ${e}`)
  }

  if (result.migrationMissing) {
    console.error(
      '\n⛔ migration 013_network_and_reference.sql has not been applied.\n' +
        '   Run it in the Supabase SQL editor, then re-run this command.\n' +
        '   Nothing was persisted; internal-first scouting will find an empty index.'
    )
    process.exit(2)
  }

  console.log('\nDone. The scout can now search this network before spending on discovery.')
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
