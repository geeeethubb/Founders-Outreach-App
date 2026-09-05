// The one error shape every scouting surface speaks.
//
// A founder who sees "Scouting failed" has been told nothing; one who sees
// "Unexpected token '<'" has been told something false — that is the browser
// failing to parse Vercel's HTML 504 page, not the cause of anything. Every
// failure that reaches a run row, an API response or a screen carries a STABLE
// CODE, a sentence, whether trying again could help, and — when we know it —
// what to do about it.
//
// The HTTP shape is flat and backwards compatible: `error` is still the
// sentence every existing client reads, and the rest sits beside it.
//
//   { error: string, code, retryable, stage?, provider?, runId?, remedy?, migrationMissing? }
//
// Pure. No I/O, no framework import — the API routes wrap it in a Response.

export const SCOUT_ERROR_CODES = [
  /** Missing or contradictory deployment configuration. Nothing paid was started. */
  'CONFIGURATION',
  /** No session, or the wrong one. */
  'AUTHENTICATION',
  /** The database predates a migration the feature needs. Nothing paid was started. */
  'SCHEMA_MIGRATION',
  /** The worker could not be reached, or refused the request. */
  'DISPATCH',
  /** The run was already claimed, already finished, or the token was wrong. */
  'CLAIM',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_INVALID_RESPONSE',
  /** A provider answered with a definite error that is not a rate limit or a timeout. */
  'PROVIDER_ERROR',
  'DATABASE',
  /** The run's own clock ran out. What was found is kept. */
  'RUN_DEADLINE',
  /** The platform ended the worker well before its planned deadline — a lower function ceiling than assumed, or an out-of-memory kill. */
  'PLATFORM_KILL',
  'CANCELLED',
  'NOT_FOUND',
  /** A run is already active, or the request contradicts the run's state. */
  'CONFLICT',
  'VALIDATION',
  'INTERNAL',
] as const

export type ScoutErrorCode = (typeof SCOUT_ERROR_CODES)[number]

export interface ScoutError {
  code: ScoutErrorCode
  message: string
  retryable: boolean
  stage?: string | null
  provider?: 'anthropic' | 'apollo' | 'supabase' | 'vercel' | 'ats' | 'web' | string | null
  runId?: string | null
  remedy?: string | null
  /** Set when the code is SCHEMA_MIGRATION, for the existing `migrationMissing` clients. */
  migrationMissing?: boolean
  /** Upstream HTTP status, when a provider or the worker answered with one. */
  httpStatus?: number | null
  attempt?: number | null
}

export function isScoutErrorCode(v: unknown): v is ScoutErrorCode {
  return typeof v === 'string' && (SCOUT_ERROR_CODES as readonly string[]).includes(v)
}

/** Which HTTP status an error code answers with. One table, so routes cannot disagree. */
export function httpStatusFor(code: ScoutErrorCode): number {
  switch (code) {
    case 'AUTHENTICATION':
      return 401
    case 'NOT_FOUND':
      return 404
    case 'CONFLICT':
    case 'SCHEMA_MIGRATION':
    case 'CLAIM':
      return 409
    case 'VALIDATION':
      return 400
    case 'PROVIDER_RATE_LIMIT':
      return 429
    case 'CONFIGURATION':
    case 'DISPATCH':
      return 503
    case 'PROVIDER_TIMEOUT':
    case 'RUN_DEADLINE':
    case 'PLATFORM_KILL':
      return 504
    case 'CANCELLED':
      return 409
    default:
      return 500
  }
}

/** Retryable by default only for the transient classes. */
export function defaultRetryable(code: ScoutErrorCode): boolean {
  return code === 'PROVIDER_RATE_LIMIT' || code === 'PROVIDER_TIMEOUT' || code === 'DISPATCH' || code === 'DATABASE' || code === 'RUN_DEADLINE'
}

export function scoutError(code: ScoutErrorCode, message: string, extra: Partial<Omit<ScoutError, 'code' | 'message'>> = {}): ScoutError {
  return {
    code,
    message,
    retryable: extra.retryable ?? defaultRetryable(code),
    stage: extra.stage ?? null,
    provider: extra.provider ?? null,
    runId: extra.runId ?? null,
    remedy: extra.remedy ?? null,
    ...(code === 'SCHEMA_MIGRATION' || extra.migrationMissing ? { migrationMissing: true } : {}),
    httpStatus: extra.httpStatus ?? null,
    attempt: extra.attempt ?? null,
  }
}

/** The flat JSON body an API route answers with. `error` stays the sentence. */
export function toErrorBody(e: ScoutError): Record<string, unknown> {
  return {
    error: e.message,
    code: e.code,
    retryable: e.retryable,
    ...(e.stage ? { stage: e.stage } : {}),
    ...(e.provider ? { provider: e.provider } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.remedy ? { remedy: e.remedy } : {}),
    ...(e.migrationMissing ? { migrationMissing: true } : {}),
    ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}),
  }
}

/**
 * What goes on the run row: `error` (the sentence), `error_code`, and a bounded
 * `error_detail` — never a token, never a key, never a prompt body.
 */
export function toRowError(e: ScoutError): { error: string; error_code: ScoutErrorCode; error_detail: Record<string, unknown> } {
  return {
    error: e.message.slice(0, 600),
    error_code: e.code,
    error_detail: {
      ...(e.stage ? { stage: e.stage } : {}),
      ...(e.provider ? { provider: e.provider } : {}),
      ...(e.remedy ? { remedy: e.remedy } : {}),
      ...(e.httpStatus ? { http_status: e.httpStatus } : {}),
      ...(e.attempt !== null && e.attempt !== undefined ? { attempt: e.attempt } : {}),
      retryable: e.retryable,
    },
  }
}

/**
 * Classify a thrown value or a provider error string into a code. Used at the
 * edges — a worker's catch, a provider client's failure branch — so an
 * "unknown internal failure" is the exception, not the default.
 */
export function classifyError(input: unknown, fallback: ScoutErrorCode = 'INTERNAL'): ScoutErrorCode {
  const message = (input instanceof Error ? input.message : typeof input === 'string' ? input : String(input ?? '')).toLowerCase()
  const status = typeof input === 'object' && input && 'status' in input ? Number((input as { status?: unknown }).status) : NaN
  if (/relation .* does not exist|column .* does not exist|schema cache|could not find the table|migration/.test(message)) return 'SCHEMA_MIGRATION'
  if (/api key is not set|is not set\b|not configured|missing .* env/.test(message)) return 'CONFIGURATION'
  if (/run deadline|deadline passed|deadline reached|exceeded its .* budget/.test(message)) return 'RUN_DEADLINE'
  if (/cancel/.test(message)) return 'CANCELLED'
  if (status === 429 || /rate limit|too many requests|429/.test(message)) return 'PROVIDER_RATE_LIMIT'
  if (status === 408 || /timed? ?out|timeout|aborterror|aborted/.test(message)) return 'PROVIDER_TIMEOUT'
  if (status === 401 || status === 403 || /unauthorized|forbidden/.test(message)) return 'AUTHENTICATION'
  if (/invalid json|not json|schema validation|no .* tool call|malformed/.test(message)) return 'PROVIDER_INVALID_RESPONSE'
  if (/postgrest|supabase|database|pgrst|duplicate key|violates/.test(message)) return 'DATABASE'
  if (/fetch failed|econnrefused|enotfound|econnreset|socket hang up|network/.test(message)) return 'PROVIDER_TIMEOUT'
  if (Number.isFinite(status) && status >= 500) return 'PROVIDER_ERROR'
  return fallback
}

/** A one-line remedy for the codes where one is always true. */
export function defaultRemedy(code: ScoutErrorCode): string | null {
  switch (code) {
    case 'SCHEMA_MIGRATION':
      return 'Apply the named migration in the Supabase SQL editor, then try again.'
    case 'PROVIDER_RATE_LIMIT':
      return 'The provider is rate-limiting this account. Wait a minute and run it again; the run kept what it had found.'
    case 'PROVIDER_TIMEOUT':
      return 'The provider was too slow to answer inside the run’s clock. Run it again; finished stages are not repeated.'
    case 'RUN_DEADLINE':
      return 'The run used its whole clock. Everything found is saved; continue the run to pick up where it stopped.'
    case 'DISPATCH':
      return 'The app could not reach its own worker. On Vercel, enable Protection Bypass for Automation (Settings → Deployment Protection) or set SCOUT_WORKER_BASE_URL to the production domain.'
    case 'PLATFORM_KILL':
      return 'The hosting platform ended the worker far earlier than the 300 s it is configured for. Check that Fluid compute is enabled and the plan allows a 300 s function; the run kept what it had found.'
    case 'AUTHENTICATION':
      return 'Sign in again.'
    default:
      return null
  }
}

/**
 * Did an agent or provider outcome fail because the RUN stopped it — its clock
 * or a cancel — rather than because of what the model did? Callers that treat
 * a failure as "this item is broken" must not do so for these: the item was
 * never really attempted and belongs to the next leg. The code is the
 * authority; the sentence match keeps a path that carries no code honest.
 */
export function isClockOutcome(r: { error?: string | null; errorCode?: string | null }): boolean {
  if (r.errorCode === 'RUN_DEADLINE' || r.errorCode === 'CANCELLED') return true
  return /run deadline|not started|deadline passed|ran out the run's clock|run cancelled/i.test(r.error ?? '')
}
