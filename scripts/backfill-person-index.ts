// One-time backfill: rebuild the per-person enrichment index from the existing
// batch-keyed `people_bulk_match` cache.
//
// Phase 3 cached enrichment responses per BATCH of ten. That made the cache
// worthless the moment the pipeline changed which people it selected — the same
// person in a different batch was a miss, and Apollo lead credits are finite.
// This walks every cached batch and writes each person out individually, so
// ~700 already-purchased records become reusable regardless of batching.
//
//   npm run backfill:person-index

import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const { personCacheKey } = await import('../lib/providers/apollo/people')
  const { cacheSet, cacheGet } = await import('../lib/providers/cache')

  const cacheRoot = process.env.PROVIDER_CACHE_DIR || path.join(process.cwd(), '.provider-cache')
  const batchDir = path.join(cacheRoot, 'people_bulk_match')

  if (!fs.existsSync(batchDir)) {
    process.stdout.write('No people_bulk_match cache found — nothing to backfill.\n')
    return
  }

  const files = fs.readdirSync(batchDir).filter((f) => f.endsWith('.json'))
  let batches = 0
  let written = 0
  let alreadyPresent = 0
  let skipped = 0

  for (const file of files) {
    let payload: { data?: { matches?: ({ id?: string; name?: string } | null)[] } }
    try {
      payload = JSON.parse(fs.readFileSync(path.join(batchDir, file), 'utf8'))
    } catch {
      skipped++
      continue
    }

    batches++
    for (const match of payload.data?.matches ?? []) {
      if (!match?.id || !match.name) continue
      const key = personCacheKey(match.id)
      if (cacheGet(key)) {
        alreadyPresent++
        continue
      }
      cacheSet(key, match)
      written++
    }
  }

  process.stdout.write(
    `Backfilled ${written} people from ${batches} cached batches ` +
      `(${alreadyPresent} already indexed, ${skipped} unreadable files).\n`
  )
}

main().catch((e) => {
  process.stderr.write(`backfill failed: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
