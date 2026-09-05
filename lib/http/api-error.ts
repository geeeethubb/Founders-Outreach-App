// The one way an API route answers with a failure.
//
// Every scouting route speaks lib/runs/errors.ts: a sentence in `error` (what
// every existing client reads), a stable `code`, whether trying again could
// help, and — when known — what to do about it. The HTTP status follows the
// code, so two routes cannot disagree about what a CONFLICT is.

import { NextResponse } from 'next/server'
import { classifyError, defaultRemedy, httpStatusFor, scoutError, toErrorBody, type ScoutError, type ScoutErrorCode } from '@/lib/runs/errors'

export function jsonError(err: ScoutError, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ...toErrorBody(err), ...extra }, { status: httpStatusFor(err.code) })
}

export function apiError(code: ScoutErrorCode, message: string, extra: Partial<Omit<ScoutError, 'code' | 'message'>> & { body?: Record<string, unknown> } = {}): NextResponse {
  const { body, ...rest } = extra
  return jsonError(scoutError(code, message, { remedy: defaultRemedy(code), ...rest }), body ?? {})
}

/** A thrown value, classified. For a route's outer catch. */
export function thrownError(e: unknown, fallback: ScoutErrorCode = 'INTERNAL'): NextResponse {
  const code = classifyError(e, fallback)
  const message = e instanceof Error ? e.message : String(e)
  return jsonError(scoutError(code, message.slice(0, 500), { remedy: defaultRemedy(code) }))
}

export const unauthorized = () => apiError('AUTHENTICATION', 'Unauthorized')
