// Database plumbing shared by the Career OS stores.
//
// Migrations here are applied by hand, so at any moment the live database may
// be one migration behind the code. Every write that touches a column a later
// migration added goes through `writeTolerant`: the full write is attempted,
// and if Postgres says the column does not exist the optional columns are
// stripped and it is retried. The row still lands, the caller is told what was
// dropped, and nothing throws (principle 9 — degrade, never halt).

import { createServiceClient } from '@/lib/supabase/server'

export type Db = ReturnType<typeof createServiceClient>

export function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache|could not find/i.test(message)
}

/** The shape every PostgREST call resolves to that we care about here. */
export interface WriteOutcome {
  error: { message: string } | null
}

export interface TolerantWrite {
  error: string | null
  migrationMissing: boolean
  /** Columns the database did not know about, dropped so the rest could land. */
  downgraded: string[]
}

/**
 * Run a write, and if it fails only because the database predates a migration,
 * run it again without the columns that migration added.
 */
export async function writeTolerant(
  patch: Record<string, unknown>,
  optional: string[],
  write: (p: Record<string, unknown>) => PromiseLike<WriteOutcome>
): Promise<TolerantWrite> {
  const first = await write(patch)
  if (!first.error) return { error: null, migrationMissing: false, downgraded: [] }
  if (!isMissingSchema(first.error.message)) return { error: first.error.message, migrationMissing: false, downgraded: [] }

  const present = optional.filter((c) => c in patch)
  if (present.length === 0) return { error: first.error.message, migrationMissing: true, downgraded: [] }

  const bare: Record<string, unknown> = { ...patch }
  for (const c of present) delete bare[c]
  if (Object.keys(bare).length === 0) return { error: null, migrationMissing: false, downgraded: present }
  const second = await write(bare)
  if (second.error) {
    return { error: second.error.message, migrationMissing: isMissingSchema(second.error.message), downgraded: present }
  }
  return { error: null, migrationMissing: false, downgraded: present }
}

export interface TolerantRead<T> {
  rows: T[]
  error: string | null
  migrationMissing: boolean
  /** false when the read fell back to the pre-migration column list. */
  full: boolean
}

/**
 * Read with the current column list, falling back to the older one when the
 * database has not caught up. `full: false` is how a caller knows a field it
 * asked for is simply not there yet.
 */
export async function readTolerant<T>(
  columns: string,
  fallbackColumns: string,
  read: (cols: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>
): Promise<TolerantRead<T>> {
  const first = await read(columns)
  if (!first.error) return { rows: (first.data ?? []) as T[], error: null, migrationMissing: false, full: true }
  if (!isMissingSchema(first.error.message)) return { rows: [], error: first.error.message, migrationMissing: false, full: true }

  const second = await read(fallbackColumns)
  if (second.error) {
    return { rows: [], error: second.error.message, migrationMissing: isMissingSchema(second.error.message), full: false }
  }
  return { rows: (second.data ?? []) as T[], error: null, migrationMissing: false, full: false }
}
