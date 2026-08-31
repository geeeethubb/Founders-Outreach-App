// The vocabulary every PDF renderer shares, plus the two process helpers.
//
// The one thing that matters here is `PdfRenderOutcome`. For a long time a
// render answered only `ok: false`, and every caller had to string-match
// `NO_RENDERER_ERROR` to tell "this machine has no Word" from "Word is
// installed and was too slow". They are completely different facts with
// completely different remedies — one is "install something", the other is
// "try again in a minute" — and a boolean cannot carry that difference.
// Telling a founder to install Microsoft Word on the machine where Microsoft
// Word is already running is the bug this type exists to make impossible.

import { spawn } from 'child_process'

/**
 * Why a render ended the way it did.
 *
 *   ok           a PDF exists at the requested path
 *   no_renderer  nothing on this machine can render a DOCX  → install one
 *   timeout      a renderer IS installed and did not finish in the budget → retry
 *   failed       a renderer IS installed and refused the document          → retry / investigate
 */
export type PdfRenderOutcome = 'ok' | 'no_renderer' | 'timeout' | 'failed'

export interface RenderResult {
  ok: boolean
  outcome: PdfRenderOutcome
  pageCount: number | null
  error?: string
  ms: number
}

export interface RenderOptions {
  /**
   * Wall-clock budget for this render, INCLUDING any wait for a cold renderer.
   * Exceeding it abandons the wait; it never abandons the renderer, which goes
   * on warming in the background for whoever asks next.
   */
  budgetMs?: number
}

export interface PdfRenderer {
  id: 'word-com' | 'libreoffice'
  isAvailable(): Promise<boolean>
  render(docxPath: string, pdfPath: string, opts?: RenderOptions): Promise<RenderResult>
  /** Start the renderer in the background without waiting for it. Optional. */
  prewarm?(): void
}

export function renderOk(pageCount: number | null, ms: number): RenderResult {
  return { ok: true, outcome: 'ok', pageCount, ms }
}

export function renderFailure(outcome: Exclude<PdfRenderOutcome, 'ok'>, error: string, ms: number): RenderResult {
  return { ok: false, outcome, pageCount: null, error, ms }
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

/** A positive integer from the environment, else the fallback. Bad values are ignored, not honoured half-way. */
export function envMs(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[name] ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// ─── Process helpers ─────────────────────────────────────────────────────────

export function runProcess(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr + err.message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/** PowerShell's -EncodedCommand takes UTF-16LE base64, so no path ever meets the shell's quoting rules. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

// ─── Serialization ───────────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve()

/** One at a time, in call order. LibreOffice's headless mode does not enjoy concurrency. */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}
