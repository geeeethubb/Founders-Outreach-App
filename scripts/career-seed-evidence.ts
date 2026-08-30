// Seeds the Evidence Bank from the master résumé DOCX.
//
//   npx tsx scripts/career-seed-evidence.ts                      propose, persist pending
//   npx tsx scripts/career-seed-evidence.ts --approve            persist approved
//   npx tsx scripts/career-seed-evidence.ts --dry                propose, persist nothing
//   npx tsx scripts/career-seed-evidence.ts --reset --approve    wipe this user's bank first
//   npx tsx scripts/career-seed-evidence.ts --include-profile    also import profiles free text
//   npx tsx scripts/career-seed-evidence.ts --user <id> --file path/to.docx
//
// Exit 2 when migration 014 has not been applied (--dry never touches the
// database). The importer's cache key is the input hash, so a re-run over an
// unchanged résumé costs nothing.
//
// Exit codes are set via process.exitCode, never process.exit(): on Node 24 an
// exit while a Supabase socket is still closing trips a libuv assertion and
// the process dies 127 instead of the code it meant to return.

import { defaultProfiles } from './lib/cli-user'
import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function opt(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const { migrationApplied, seedEvidenceFromDocx, summarizeSeed } = await import('../lib/career/evidence/seed')

  const dry = flag('dry')
  if (!dry) {
    const gate = await migrationApplied()
    if (!gate.applied) {
      console.error('migration 014_career_os.sql has not been applied — apply it in the Supabase SQL editor, then re-run.')
      console.error(`  (${gate.error})`)
      process.exitCode = 2
      return
    }
  }

  let userId = opt('user')
  if (!userId && dry) userId = 'dry-run'
  if (!userId) {
    const supabase = createServiceClient()
    const { data: profiles } = await defaultProfiles()
    if (!profiles?.length) {
      console.error('no profiles row exists to own the bank')
      process.exitCode = 1
      return
    }
    userId = profiles[0].id as string
  }

  const file = opt('file') ?? path.join(process.cwd(), 'Zuyu_Resume.docx')
  if (!fs.existsSync(file)) {
    console.error(`résumé not found: ${file}`)
    process.exitCode = 1
    return
  }
  const buffer = fs.readFileSync(file)

  console.log(`\nEVIDENCE SEED — ${path.basename(file)} → user ${userId}${dry ? ' (dry run)' : ''}\n`)
  const started = Date.now()
  const result = await seedEvidenceFromDocx(userId, buffer, {
    approve: flag('approve'),
    includeProfile: flag('include-profile'),
    reset: flag('reset'),
    dry,
    filename: path.basename(file),
    onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
  })

  if (result.migrationMissing) {
    console.error('\nmigration 014_career_os.sql has not been applied')
    process.exitCode = 2
    return
  }

  if (dry && result.proposal) {
    const p = result.proposal
    console.log('\nPROPOSAL')
    for (const e of p.experiences) {
      const facts = p.facts.filter((f) => f.experience_key === e.key)
      const metrics = p.metrics.filter((m) => m.experience_key === e.key)
      console.log(`\n  ${e.title} — ${e.organization} [${e.kind}]${e.summary ? `\n    ${e.summary}` : ''}`)
      for (const f of facts) console.log(`    · (${f.category}) ${f.statement}   ${f.source_location}`)
      for (const m of metrics) console.log(`    # ${m.value}${m.unit ? ` ${m.unit}` : ''}${m.context ? ` — ${m.context}` : ''}`)
    }
    console.log(`\n  skills: ${p.skills.map((s) => `${s.name} (${s.category})`).join(', ') || 'none'}`)
    console.log(`  deliverables: ${p.deliverables.length}`)
  }

  console.log('\nRESULT')
  for (const line of summarizeSeed(result)) console.log(`  ${line}`)
  if (result.errors.length) {
    console.log('\nERRORS')
    for (const e of result.errors) console.log(`  - ${e}`)
  }
  console.log(`\n  ${((Date.now() - started) / 1000).toFixed(1)}s · run ${result.runId ?? '(none)'}\n`)
  process.exitCode = result.ok ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
