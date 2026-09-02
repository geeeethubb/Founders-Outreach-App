// Giving a fire-and-forget request a real chance to finish.
//
// The scout dispatch is a POST this deployment makes to itself, started inside
// the request that enqueues the run. On a serverless platform that request's
// function is frozen the instant its response is written, so an outbound POST
// that has not yet been flushed and answered dies with the sandbox. That is one
// of the ways a run ends up queued with nothing having picked it up.
//
// `waitUntil` is the platform's answer: hand it a promise and the function stays
// alive until that promise settles, without the client waiting for it.
//
// WHAT IS AVAILABLE HERE. Next 14.2.35 exports neither `after` nor
// `unstable_after` from `next/server` (checked, not assumed), and
// `@vercel/functions` is not a dependency. Vercel exposes the same capability
// through a global symbol, which is exactly what that package reads internally.
// Using it directly costs no new dependency and no new infrastructure.
//
// IT IS AN OPTIMISATION, NOT A GUARANTEE. The symbol is a platform internal: it
// can disappear, and off-Vercel there is nothing behind it. So this never
// changes behaviour when absent — the promise floats exactly as it did before —
// and the queue watchdog remains the thing that makes the invariant true. If
// `waitUntil` works the run starts faster; if it does not, the watchdog notices
// within 60 seconds. Neither depends on the other.

type WaitUntil = (promise: Promise<unknown>) => void

interface VercelRequestContext {
  get?: () => { waitUntil?: WaitUntil } | undefined
}

/**
 * The platform's `waitUntil`, or null when there is not one.
 *
 * Resolved per call rather than cached: the context is per-request, and a cached
 * reference from an earlier invocation would extend the wrong function.
 */
export function platformWaitUntil(): WaitUntil | null {
  try {
    const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as VercelRequestContext | undefined
    const waitUntil = ctx?.get?.()?.waitUntil
    return typeof waitUntil === 'function' ? waitUntil : null
  } catch {
    // A platform that throws on the symbol is a platform that does not have it.
    return null
  }
}

export interface BackgroundResult {
  /** True when the platform accepted responsibility for the promise. */
  extended: boolean
}

/**
 * Keep the function alive for `promise` if the platform allows it.
 *
 * Rejections are swallowed on purpose: this is work whose failure is already
 * handled elsewhere — the dispatch records its own outcome, and an unhandled
 * rejection here would crash a request that has already succeeded.
 */
export function runInBackground(promise: Promise<unknown>): BackgroundResult {
  const settled = promise.catch(() => undefined)
  const waitUntil = platformWaitUntil()
  if (!waitUntil) return { extended: false }
  try {
    waitUntil(settled)
    return { extended: true }
  } catch {
    return { extended: false }
  }
}
