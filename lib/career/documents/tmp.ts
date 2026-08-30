// Scratch space for document rendering.
//
// Three different things used to be spelled the same way, and one of them was
// wrong in production:
//
//   1. FINAL CLI OUTPUT      `.career-out/packages/…` — a local directory the
//                            founder asked for. Stays exactly where it is.
//   2. PERSISTENT WEB OUTPUT Supabase Storage via `documents/store.ts`. Durable.
//   3. TEMPORARY WORKSPACE   this file. Ephemeral, absolute, OS-owned.
//
// (3) used to be `path.join('.career-out', 'tmp')` — a RELATIVE path. On a
// server whose working directory is not the repo (any deployment, and a
// Next.js worker in general) `mkdir '.career-out/tmp/pkg-…'` fails with ENOENT,
// after research and tailoring have already been paid for. Temp work now lives
// under `os.tmpdir()`, is created with `mkdtemp` so two concurrent builds can
// never collide, and is always removed in a `finally`.
//
// `CAREER_TMP_DIR` overrides the root for tests and development.

import fs from 'fs'
import os from 'os'
import path from 'path'

/** Everything this app writes to temp lives under one directory, so a stray file is easy to find. */
export const TMP_NAMESPACE = 'founders-outreach'

/** Absolute root for temporary work. `CAREER_TMP_DIR` wins; otherwise the OS temp directory. */
export function tmpRoot(): string {
  const override = (process.env.CAREER_TMP_DIR ?? '').trim()
  const root = override ? path.resolve(override) : path.join(os.tmpdir(), TMP_NAMESPACE)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * A fresh, absolute, collision-proof scratch directory.
 * `prefix` only labels it for a human reading `ls` on a crashed machine.
 */
export function makeTempDir(prefix = 'doc'): string {
  const safe = prefix.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24) || 'doc'
  return fs.mkdtempSync(path.join(tmpRoot(), `${safe}-`))
}

/**
 * Remove a scratch directory. Never throws: a cleanup failure must not replace
 * the error that actually broke the build (a masked ENOENT is how this bug hid).
 * Returns the swallowed error so a caller can log it as a warning.
 */
export function removeTempDir(dir: string | null | undefined): Error | null {
  if (!dir) return null
  try {
    const root = tmpRoot()
    const resolved = path.resolve(dir)
    // Only ever delete inside our own namespace — a bad `dir` must not take a
    // real directory with it.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return new Error(`refusing to remove a path outside the temp root: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * Run `fn` with a scratch directory that is removed afterwards — on success, on
 * failure, and on a throw. The original error always survives; a cleanup
 * failure is reported through `onCleanupError`, never raised.
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
  onCleanupError?: (error: Error) => void
): Promise<T> {
  const dir = makeTempDir(prefix)
  try {
    return await fn(dir)
  } finally {
    const failure = removeTempDir(dir)
    if (failure && onCleanupError) {
      try {
        onCleanupError(failure)
      } catch {
        // A reporting callback must not break the caller either.
      }
    }
  }
}

/** True when `p` is inside the temp namespace — used to assert no stored document path points at scratch. */
export function isTempPath(p: string | null | undefined): boolean {
  if (!p) return false
  const value = p.replace(/^(?:local|supabase):/, '')
  if (!path.isAbsolute(value)) return false
  const resolved = path.resolve(value)
  const roots = [path.join(os.tmpdir(), TMP_NAMESPACE)]
  const override = (process.env.CAREER_TMP_DIR ?? '').trim()
  if (override) roots.push(path.resolve(override))
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
}
