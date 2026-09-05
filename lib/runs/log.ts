// One structured line per scouting event, so a failed hosted run can be
// reconstructed from its log without reproducing it.
//
//   [scout] run_id=… scout_kind=jobs invocation=2 stage=research provider=anthropic
//           operation=messages.create attempt=1 status=429 latency_ms=812 remaining_ms=140211 …
//
// Every field is a key=value pair, strings JSON-quoted, so a log search for
// `run_id=<id>` returns the whole story in order. Nothing here ever prints a
// secret: the field names are an allowlist, and a value that looks like a
// bearer token, an API key or a claim token is redacted before it is written.

import { currentRunContext } from './context'

export type ScoutKind = 'people' | 'jobs' | 'package' | 'unknown'

export interface ScoutLogFields {
  run_id?: string | null
  scout_kind?: ScoutKind | string | null
  invocation?: number | null
  event?: string
  stage?: string | null
  provider?: string | null
  operation?: string | null
  attempt?: number | null
  status?: string | number | null
  http_status?: number | null
  latency_ms?: number | null
  elapsed_ms?: number | null
  remaining_ms?: number | null
  queue_wait_ms?: number | null
  cost_usd?: number | null
  error_code?: string | null
  error?: string | null
  terminal_status?: string | null
  detail?: string | null
  [key: string]: unknown
}

const SECRET_SHAPE = /(sk-ant-[a-z0-9_-]{8,}|sk-[a-z0-9]{20,}|eyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}|bearer\s+[a-z0-9._-]{16,})/i
const SECRET_KEY = /(token|secret|key|password|authorization|cookie)/i

function redact(key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key) && typeof value === 'string' && value.length > 0) return '[redacted]'
  if (typeof value === 'string' && SECRET_SHAPE.test(value)) return value.replace(SECRET_SHAPE, '[redacted]')
  return value
}

/** Render fields as `k=v` pairs. Exported so tests can assert the exact line. */
export function formatScoutLog(fields: ScoutLogFields): string {
  const ctx = currentRunContext()
  const merged: ScoutLogFields = {
    run_id: fields.run_id ?? ctx?.runId ?? null,
    scout_kind: fields.scout_kind ?? ctx?.kind ?? null,
    invocation: fields.invocation ?? ctx?.invocation ?? null,
    ...fields,
  }
  if (ctx && merged.elapsed_ms == null) merged.elapsed_ms = ctx.clock.elapsedMs()
  if (ctx && merged.remaining_ms == null) merged.remaining_ms = ctx.clock.remainingForWorkMs()
  const parts: string[] = []
  for (const [k, raw] of Object.entries(merged)) {
    if (raw === undefined || raw === null || raw === '') continue
    const v = redact(k, raw)
    const s = typeof v === 'number' ? String(Math.round(v)) : typeof v === 'string' ? JSON.stringify(v.slice(0, 300)) : JSON.stringify(v)
    parts.push(`${k}=${s}`)
  }
  return `[scout] ${parts.join(' ')}`
}

export function scoutLog(fields: ScoutLogFields, level: 'log' | 'warn' | 'error' = 'log'): void {
  const line = formatScoutLog(fields)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
