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

/**
 * The override, but only when it can be trusted. A RELATIVE `CAREER_TMP_DIR`
 * would resolve against the process working directory — which is precisely the
 * failure this module exists to prevent (`.career-out/tmp` was relative, and
 * that is why document generation died in the web runtime). A relative value is
 * therefore ignored rather than honoured half-way.
 */
export function tmpOverride(env: NodeJS.ProcessEnv = process.env): { dir: string | null; ignored: string | null } {
  const raw = (env.CAREER_TMP_DIR ?? '').trim()
  if (!raw) return { dir: null, ignored: null }
  if (!path.isAbsolute(raw)) return { dir: null, ignored: raw }
  return { dir: path.resolve(raw), ignored: null }
}

/** Absolute root for temporary work. An absolute `CAREER_TMP_DIR` wins; otherwise the OS temp directory. */
export function tmpRoot(): string {
  const root = tmpOverride().dir ?? path.join(os.tmpdir(), TMP_NAMESPACE)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * Is `resolved` the root, or inside it?
 *
 * Case-insensitive on Windows, where `C:\Users\…\AppData\Local\Temp` and
 * `c:\users\…\appdata\local\temp` name the same directory. This comparison is
 * a safety backstop — `assertDurablePath` is the only thing standing between
 * scratch and `application_packages` — and a backstop that recognises just one
 * spelling of a path is not a backstop.
 */
function within(root: string, resolved: string): boolean {
  const [a, b] = process.platform === 'win32' ? [root.toLowerCase(), resolved.toLowerCase()] : [root, resolved]
  return b === a || b.startsWith(a + path.sep)
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
    if (!within(root, resolved)) {
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
  const override = tmpOverride().dir
  if (override) roots.push(override)
  return roots.some((root) => within(root, resolved))
}
