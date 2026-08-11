// Reports whether migration 010 has been applied. Persistence degrades
// gracefully without it (see lib/scouting/persist.ts), so this is a diagnostic,
// not a gate.
import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const { createServiceClient } = await import('../lib/supabase/server')
  const supabase = createServiceClient()

  const { data: profiles, error: pErr } = await supabase.from('profiles').select('id, email').limit(3)
  console.log('profiles:', pErr ? `ERR ${pErr.message}` : JSON.stringify(profiles))

  for (const [label, q] of [
    ['companies table', supabase.from('companies').select('id').limit(1)],
    ['company_sources table', supabase.from('company_sources').select('id').limit(1)],
    ['contacts.apollo_id', supabase.from('contacts').select('apollo_id').limit(1)],
    ['contacts.company_id', supabase.from('contacts').select('company_id').limit(1)],
  ] as const) {
    const { error } = await q
    console.log(`${label}:`, error ? `MISSING — ${error.message.slice(0, 70)}` : 'EXISTS')
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
