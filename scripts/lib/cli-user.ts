// Which profile a CLI acts on when `--user` is not given.
//
// The scripts used to take `profiles … limit(1)` — the first row in whatever
// order Postgres returned it. With two profiles on the founder's database that
// silently ran a job scout (money, and rows) under the wrong account. Now:
//
//   1. CAREER_USER_ID in the environment (.env.local)
//   2. the only profile, when exactly one exists
//   3. otherwise nothing — and the profiles are listed so the caller can pass
//      `--user <id>` or set CAREER_USER_ID.
//
// The return shape matches what the scripts destructure from the old query so
// each keeps its own "no profiles row exists" handling.

import { createServiceClient } from '../../lib/supabase/server'

export async function defaultProfiles(): Promise<{ data: { id: string }[] }> {
  const fromEnv = (process.env.CAREER_USER_ID ?? '').trim()
  if (fromEnv) return { data: [{ id: fromEnv }] }

  const { data, error } = await createServiceClient().from('profiles').select('id, email').order('created_at', { ascending: true })
  if (error) {
    console.error(`could not list profiles: ${error.message}`)
    return { data: [] }
  }
  const rows = (data ?? []) as { id: string; email: string | null }[]
  if (rows.length === 1) return { data: [{ id: rows[0].id }] }
  if (rows.length === 0) return { data: [] }

  console.error(`${rows.length} profiles exist — pass --user <id> or set CAREER_USER_ID in .env.local:`)
  for (const r of rows) console.error(`  ${r.id}  ${r.email ?? ''}`)
  return { data: [] }
}
