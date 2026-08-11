// Next's "this route must be dynamic" signal is an exception.
//
// During the build, Next tries to render each GET route handler statically. It
// finds out the route is dynamic by calling it and letting `cookies()` throw a
// DynamicServerError, which it then catches itself and uses to mark the route.
//
// A handler with a catch-all `try/catch` intercepts that throw first and turns
// control flow into a 500 response. Next sees a handler that "succeeded", the
// build reports DYNAMIC_SERVER_USAGE, and the deploy fails — locally as a
// warning, on Vercel as an error.
//
// Every route that reads cookies should also declare `export const dynamic =
// 'force-dynamic'`, which stops the static attempt happening at all. This guard
// is the second line: a catch block must re-throw the signal it was never meant
// to handle.

export function isDynamicUsage(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { digest?: unknown; message?: unknown }
  if (typeof e.digest === 'string' && e.digest.includes('DYNAMIC_SERVER_USAGE')) return true
  return typeof e.message === 'string' && e.message.includes('DYNAMIC_SERVER_USAGE')
}
