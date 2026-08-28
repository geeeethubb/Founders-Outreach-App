// One fetch wrapper for every Career OS page.
//
// Every route answers JSON with `{ error, migrationMissing? }` on failure, and
// nothing DB-backed can run until migration 014 is applied — so a page that
// does not handle that shape crashes on the founder's first visit. This turns
// any response, including a non-JSON 500, into a value the UI can render.

export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: string | null
  migrationMissing: boolean
  /** The parsed body even on failure — 422/409 answers carry qa, findings, views. */
  body: Record<string, unknown> | null
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  const { json, ...rest } = init ?? {}
  const opts: RequestInit = { ...rest }
  if (json !== undefined) {
    opts.method = opts.method ?? 'POST'
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }
    opts.body = JSON.stringify(json)
  }
  try {
    const res = await fetch(url, opts)
    let body: Record<string, unknown> | null = null
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      body = null
    }
    const migrationMissing = Boolean(body?.migrationMissing)
    if (!res.ok) {
      const error = typeof body?.error === 'string' ? (body.error as string) : `Request failed (${res.status})`
      return { ok: false, status: res.status, data: null, error, migrationMissing, body }
    }
    return { ok: true, status: res.status, data: body as T, error: null, migrationMissing, body }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : 'Network error', migrationMissing: false, body: null }
  }
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
