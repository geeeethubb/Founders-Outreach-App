// Verifies that migration 014_career_os.sql is applied: one cheap select per
// table, the storage bucket, and the two extended tables' new columns.
//
//   npx tsx scripts/verify-career-schema.ts
//
// Exit 2 when anything is missing, naming it — the same contract as
// scripts/verify-setup.ts and every other migration gate in this repo.

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

const TABLES = [
  'career_missions', 'evidence_experiences', 'evidence_facts', 'evidence_metrics', 'evidence_deliverables',
  'evidence_skills', 'evidence_stories', 'evidence_preferences', 'resume_documents', 'resume_bullets',
  'job_opportunities', 'job_sources', 'job_snapshots', 'job_fit_evaluations', 'job_evidence_maps',
  'warm_paths', 'job_feedback', 'applications', 'application_events', 'application_packages',
  'resume_patches', 'resume_patch_changes', 'cover_letters',
]

const EXTENDED: { table: string; columns: string }[] = [
  { table: 'companies', columns: 'careers_url, ats_type, ats_identifier, watch_status, watch_priority, research_summary, researched_at' },
  { table: 'scouting_runs', columns: 'kind, career_mission_id' },
]

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const supabase = createServiceClient()
  const missing: string[] = []

  for (const table of TABLES) {
    const { error } = await supabase.from(table).select('id', { count: 'exact', head: true })
    console.log(`  ${error ? 'MISSING' : 'ok     '} ${table}${error ? ` — ${error.message.slice(0, 80)}` : ''}`)
    if (error) missing.push(table)
  }
  for (const e of EXTENDED) {
    const { error } = await supabase.from(e.table).select(e.columns).limit(1)
    console.log(`  ${error ? 'MISSING' : 'ok     '} ${e.table} (+${e.columns.split(',').length} columns)${error ? ` — ${error.message.slice(0, 80)}` : ''}`)
    if (error) missing.push(`${e.table} columns`)
  }
  const { data: buckets, error: bErr } = await supabase.storage.listBuckets()
  const hasBucket = Boolean(buckets?.some((b) => b.id === 'career-docs'))
  console.log(`  ${hasBucket ? 'ok     ' : 'MISSING'} storage bucket career-docs${bErr ? ` — ${bErr.message}` : ''}`)
  if (!hasBucket) missing.push('storage bucket career-docs (documents will fall back to .career-out/)')

  if (missing.length) {
    console.log(`\nmigration 014 is incomplete: ${missing.join(', ')}`)
    process.exitCode = 2
    return
  }
  console.log('\nmigration 014 is applied: 23 tables, 2 extended tables, 1 bucket.')
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
