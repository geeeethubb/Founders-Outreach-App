// One fetch wrapper for every page that talks to the API.
//
// Every route answers JSON with `{ error, code?, retryable?, remedy?,
// migrationMissing? }` on failure — the contract in lib/runs/errors.ts. But
// not every answer comes from a route: a function killed at its ceiling
// arrives as Vercel's text page, a crash as an HTML 502, a dropped connection
// as a thrown TypeError. This turns any of them into a value the UI can
// render, and never shows the parser's complaint as the cause
// (components/career/api-errors.ts).

import { describeHttpFailure, type ApiErrorCode } from './api-errors'

export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: string | null
  /** The stable cause, when the server (or the platform) said one. */
  code: ApiErrorCode | null
  retryable: boolean
  remedy: string | null
  migrationMissing: boolean
  /** The parsed body even on failure — 422/409 answers carry qa, findings, views. */
  body: Record<string, unknown> | null
  /** Vercel's request id when the platform answered — quote it when asking why. */
  vercelId: string | null
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {}
  const opts: RequestInit = { ...rest }
  if (json !== undefined) {
    opts.method = opts.method ?? 'POST'
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }
    opts.body = JSON.stringify(json)
  }
  let res: Response
  try {
    res = await fetch(url, opts)
  } catch (e) {
    const d = describeHttpFailure({ status: 0, bodyText: null, networkError: e instanceof Error ? e.message : 'Network error' })
    return { ok: false, status: 0, data: null, error: d.message, code: d.code, retryable: d.retryable, remedy: d.remedy, migrationMissing: false, body: null, vercelId: null }
  }
  // Read the body ONCE as text; JSON is decided afterwards. A non-JSON body is
  // still evidence (the platform's error code lives in it), never an exception.
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  const vercelId = res.headers.get('x-vercel-id')
  if (!res.ok) {
    const d = describeHttpFailure({ status: res.status, bodyText: text, contentType: res.headers.get('content-type'), vercelError: res.headers.get('x-vercel-error'), vercelId })
    return { ok: false, status: res.status, data: null, error: d.message, code: d.code, retryable: d.retryable, remedy: d.remedy, migrationMissing: d.migrationMissing, body: d.body, vercelId }
  }
  let body: Record<string, unknown> | null = null
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    body = null
  }
  return { ok: true, status: res.status, data: body as T, error: null, code: null, retryable: false, remedy: null, migrationMissing: Boolean(body?.migrationMissing), body, vercelId }
}

export function fmtUsd(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '$0.00'
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10)
}

export function pct(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—'
}

/** Days until an ISO date; negative when past. Null when unparseable. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.ceil((t - Date.now()) / 86_400_000)
}
