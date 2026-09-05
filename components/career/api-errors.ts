// Turning whatever a server answered into a sentence a founder can act on.
//
// The failure the browser sees is often not the failure that happened. A
// function killed at its ceiling arrives as Vercel's text page "An error
// occurred with your deployment — FUNCTION_INVOCATION_TIMEOUT"; a crashed
// function as a 502 HTML page; a dropped connection as `TypeError: Failed to
// fetch`. Parsed blindly as JSON they become "Unexpected token '<'" — a
// sentence about the parser, not about the cause.
//
// This module is PURE so it can be tested offline against every body shape:
// a JSON error contract, an empty body, a text page, an HTML page, no body at
// all. It never returns the parser's complaint as the root cause.

export type ApiErrorCode =
  | 'CONFIGURATION'
  | 'AUTHENTICATION'
  | 'SCHEMA_MIGRATION'
  | 'DISPATCH'
  | 'CLAIM'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_ERROR'
  | 'DATABASE'
  | 'RUN_DEADLINE'
  | 'PLATFORM_KILL'
  | 'CANCELLED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'INTERNAL'
  | 'NETWORK'
  | 'GATEWAY'

export interface DescribedFailure {
  message: string
  code: ApiErrorCode | null
  retryable: boolean
  remedy: string | null
  /** The parsed JSON body when there was one. */
  body: Record<string, unknown> | null
  migrationMissing: boolean
  /** Vercel's request id, when the platform answered — the only handle for a request already gone from the logs. */
  vercelId: string | null
}

export interface FailureInput {
  status: number
  bodyText: string | null
  contentType?: string | null
  /** The `x-vercel-error` header, when present. */
  vercelError?: string | null
  vercelId?: string | null
  /** Thrown by fetch itself: no response at all. */
  networkError?: string | null
}

const KNOWN_CODES = new Set<string>([
  'CONFIGURATION', 'AUTHENTICATION', 'SCHEMA_MIGRATION', 'DISPATCH', 'CLAIM', 'PROVIDER_RATE_LIMIT', 'PROVIDER_TIMEOUT', 'PROVIDER_INVALID_RESPONSE',
  'PROVIDER_ERROR', 'DATABASE', 'RUN_DEADLINE', 'PLATFORM_KILL', 'CANCELLED', 'NOT_FOUND', 'CONFLICT', 'VALIDATION', 'INTERNAL', 'NETWORK', 'GATEWAY',
])

/** Parse a body as JSON if it is one; never throw. */
export function parseJsonBody(text: string | null | undefined): Record<string, unknown> | null {
  if (!text || !text.trim()) return null
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return null
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function vercelCodeFromText(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(/\b(FUNCTION_INVOCATION_TIMEOUT|FUNCTION_INVOCATION_FAILED|FUNCTION_PAYLOAD_TOO_LARGE|FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE|NO_RESPONSE_FROM_FUNCTION|DEPLOYMENT_NOT_FOUND|DEPLOYMENT_PAUSED|EDGE_FUNCTION_INVOCATION_TIMEOUT|BODY_NOT_A_STRING_FROM_FUNCTION|MIDDLEWARE_INVOCATION_TIMEOUT|DNS_HOSTNAME_NOT_FOUND|TOO_MANY_REQUESTS)\b/)
  return m ? m[1] : null
}

/** What a bare HTTP status means, in words, when the body said nothing usable. */
export function describeStatus(status: number, platformCode: string | null): { message: string; code: ApiErrorCode; retryable: boolean; remedy: string | null } {
  const tag = platformCode ? ` (${platformCode})` : ''
  switch (status) {
    case 0:
      return { message: 'The request never reached the server (no network, or the connection was dropped).', code: 'NETWORK', retryable: true, remedy: 'Check the connection and try again. A run already started keeps going on the server.' }
    case 401:
      return { message: 'You are signed out.', code: 'AUTHENTICATION', retryable: false, remedy: 'Sign in again; a run already started keeps going on the server.' }
    case 403:
      return { message: 'The server refused the request (403).', code: 'AUTHENTICATION', retryable: false, remedy: 'Sign in again.' }
    case 404:
      return { message: 'The server has no such run (404).', code: 'NOT_FOUND', retryable: false, remedy: null }
    case 409:
      return { message: 'The request conflicts with the run’s current state (409).', code: 'CONFLICT', retryable: false, remedy: null }
    case 429:
      return { message: 'The server is rate-limiting requests (429).', code: 'PROVIDER_RATE_LIMIT', retryable: true, remedy: 'Wait a moment and try again.' }
    case 500:
      return { message: `The server failed while handling the request (500${tag}).`, code: platformCode === 'FUNCTION_INVOCATION_FAILED' ? 'PLATFORM_KILL' : 'INTERNAL', retryable: true, remedy: platformCode === 'FUNCTION_INVOCATION_FAILED' ? 'The hosting platform ended the function. Check the deployment logs; a run already started is closed by the watchdog and can be continued.' : null }
    case 502:
      return { message: `The server could not be reached behind the gateway (502${tag}).`, code: 'GATEWAY', retryable: true, remedy: 'Usually a deploy in progress; try again in a moment.' }
    case 503:
      return { message: `The service is unavailable (503${tag}).`, code: 'CONFIGURATION', retryable: true, remedy: null }
    case 504:
      return { message: `The server did not answer in time (504${tag}).`, code: 'PROVIDER_TIMEOUT', retryable: true, remedy: 'The request outlived the server’s function ceiling. A run that was started is not lost: reload to pick it up; it keeps going on the server.' }
    default:
      return { message: `The server answered ${status}${tag}.`, code: status >= 500 ? 'INTERNAL' : 'VALIDATION', retryable: status >= 500, remedy: null }
  }
}

/**
 * The one description of a failed response. JSON contract first; then the
 * platform's own error code (header or body text); then the status.
 */
export function describeHttpFailure(input: FailureInput): DescribedFailure {
  const vercelId = input.vercelId ?? null
  if (input.networkError) {
    const s = describeStatus(0, null)
    return { ...s, body: null, migrationMissing: false, vercelId }
  }
  const body = parseJsonBody(input.bodyText)
  const migrationMissing = Boolean(body?.migrationMissing)
  if (body && typeof body.error === 'string' && body.error.trim()) {
    const code = typeof body.code === 'string' && KNOWN_CODES.has(body.code) ? (body.code as ApiErrorCode) : migrationMissing ? 'SCHEMA_MIGRATION' : null
    return {
      message: body.error,
      code,
      retryable: typeof body.retryable === 'boolean' ? body.retryable : false,
      remedy: typeof body.remedy === 'string' ? body.remedy : null,
      body,
      migrationMissing,
      vercelId,
    }
  }
  const platformCode = input.vercelError ?? vercelCodeFromText(input.bodyText)
  const s = describeStatus(input.status, platformCode)
  return { ...s, body, migrationMissing, vercelId, message: vercelId ? `${s.message} Request id ${vercelId}.` : s.message }
}
