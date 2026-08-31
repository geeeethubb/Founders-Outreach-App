// DOCX → PDF, through whatever renderer this machine has.
//
// Fidelity matters more than portability here: the one-page check is only
// meaningful if the PDF is laid out the way the recruiter's Word will lay it
// out. Microsoft Word via COM is therefore first choice; LibreOffice is the
// fallback; with neither, the DOCX still ships and QA reports the PDF as
// unavailable rather than faking one with a low-fidelity layout engine.
//
// Word's automation server does not enjoy concurrency, so renders are
// serialized through a module-level queue.

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { pdfPageCountFallback } from './pdf-text'
import { makeTempDir, removeTempDir } from './tmp'

export interface RenderResult {
  ok: boolean
  pageCount: number | null
  error?: string
  ms: number
}

export interface PdfRenderer {
  id: 'word-com' | 'libreoffice'
  isAvailable(): Promise<boolean>
  render(docxPath: string, pdfPath: string): Promise<RenderResult>
}

const RENDER_TIMEOUT_MS = 90_000

// ─── Serialization ───────────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

// ─── Process helper ──────────────────────────────────────────────────────────

function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
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

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

// ─── Microsoft Word via COM ──────────────────────────────────────────────────
//
// Measured on the dev machine: launching Word costs ~2 s, the FIRST PDF export
// in a fresh instance costs 8–40 s (converter warm-up), every export after
// that under a second. One Word per document would make a ten-package eval
// take minutes, so one PowerShell process holds one Word open and takes jobs
// over stdin, a tab-separated "docx<TAB>pdf" line at a time, until it has been
// idle for a while. The whole script travels as -EncodedCommand so no path
// ever meets the shell's quoting rules.

const MISSING = '[Type]::Missing'

const WORD_SERVER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
  '$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
  '$word = New-Object -ComObject Word.Application',
  '$word.Visible = $false',
  '$word.DisplayAlerts = 0',
  '$word.AutomationSecurity = 3',
  'try { $word.Options.UpdateLinksAtOpen = $false } catch {}',
  '$after = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
  '$mine = @($after | Where-Object { $before -notcontains $_ })',
  '[Console]::Out.WriteLine("STARTED WORDPID=" + ($mine -join ",")); [Console]::Out.Flush()',
  // Warm-up: the first export in a fresh instance is the slow one (8-110 s measured).
  // Pay it here, on a throwaway document, so every real job gets the warm path.
  '$warm = [IO.Path]::Combine([IO.Path]::GetTempPath(), "career-word-warmup-" + $PID + ".pdf")',
  'try {',
  '  $wd = $word.Documents.Add()',
  '  $wd.Content.Text = "warm-up"',
  '  $wd.ExportAsFixedFormat($warm, 17, $false, 0, 0, 0, 0, 0, $false, $false, 0, $false, $false, $false)',
  '  $wd.Close(0)',
  '  Remove-Item $warm -ErrorAction SilentlyContinue',
  '} catch {}',
  '[Console]::Out.WriteLine("READY WORDPID=" + ($mine -join ",")); [Console]::Out.Flush()',
  'try {',
  '  while ($true) {',
  '    $line = [Console]::In.ReadLine()',
  "    if ($line -eq $null -or $line -eq 'QUIT') { break }",
  '    $parts = $line.Split([char]9)',
  '    $doc = $null',
  '    try {',
  `      $doc = $word.Documents.Open($parts[0], $false, $true, $false, ${MISSING}, ${MISSING}, ${MISSING}, ${MISSING}, ${MISSING}, ${MISSING}, ${MISSING}, $false)`,
  '      $doc.ExportAsFixedFormat($parts[1], 17, $false, 0, 0, 0, 0, 0, $false, $false, 0, $false, $false, $false)',
  '      $pages = $doc.ComputeStatistics(2)',
  '      [Console]::Out.WriteLine("PAGES=" + $pages)',
  '    } catch {',
  '      [Console]::Out.WriteLine("ERROR=" + ($_.Exception.Message -replace "[\\r\\n]+", " "))',
  '    } finally {',
  '      if ($doc -ne $null) { try { $doc.Close(0) } catch {} }',
  '      [Console]::Out.Flush()',
  '    }',
  '  }',
  '} finally {',
  '  try { $word.Quit() } catch {}',
  '}',
].join('\n')

const WORD_IDLE_MS = 45_000
/** Startup includes the warm-up export, which is the slow one. */
const WORD_STARTUP_TIMEOUT_MS = 240_000

interface WordServer {
  child: ChildProcess
  wordPids: number[]
  buffer: string
  waiter: ((line: string) => void) | null
  idleTimer: NodeJS.Timeout | null
}

let server: WordServer | null = null
let wordAvailable: Promise<boolean> | null = null

function killWordServer(mode: 'graceful' | 'immediate'): void {
  const s = server
  if (!s) return
  server = null
  if (s.idleTimer) clearTimeout(s.idleTimer)
  try {
    s.child.stdin?.write('QUIT\n')
  } catch {
    /* already gone */
  }
  const force = () => {
    try {
      s.child.kill('SIGKILL')
    } catch {
      /* gone */
    }
    // Killing PowerShell does not kill the out-of-process COM server; Word would
    // linger invisibly forever. We know its pid, so it goes too.
    for (const pid of s.wordPids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
  if (mode === 'immediate') force()
  else setTimeout(force, 2_000).unref()
}

function startWordServer(): Promise<WordServer> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(WORD_SERVER_SCRIPT)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const s: WordServer = { child, wordPids: [], buffer: '', waiter: null, idleTimer: null }
    let ready = false
    const onLine = (line: string) => {
      if (!ready) {
        // STARTED carries Word's pid before the slow warm-up, so a warm-up that
        // never finishes can still be cleaned up.
        const m = line.match(/^(STARTED|READY) WORDPID=([\d,]*)/)
        if (m) s.wordPids = m[2].split(',').filter(Boolean).map(Number)
        if (m && m[1] === 'READY') {
          ready = true
          resolve(s)
        }
        return
      }
      if (s.waiter) {
        const w = s.waiter
        s.waiter = null
        w(line)
      }
    }
    child.stdout?.on('data', (d: Buffer) => {
      s.buffer += d.toString('utf8')
      let nl: number
      while ((nl = s.buffer.indexOf('\n')) >= 0) {
        const line = s.buffer.slice(0, nl).replace(/\r$/, '')
        s.buffer = s.buffer.slice(nl + 1)
        onLine(line)
      }
    })
    child.stderr?.on('data', () => undefined)
    // A write to a server that has already exited surfaces as an async EPIPE on
    // stdin; unhandled, that is an uncaught exception that takes the worker down.
    child.stdin?.on('error', () => undefined)
    child.on('error', (err) => {
      if (!ready) reject(err)
      if (server === s) server = null
    })
    child.on('close', () => {
      if (!ready) reject(new Error('Word server exited before READY'))
      if (server === s) server = null
      if (s.waiter) {
        const w = s.waiter
        s.waiter = null
        w('ERROR=Word server exited')
      }
    })
    setTimeout(() => {
      if (!ready) {
        child.kill('SIGKILL')
        for (const pid of s.wordPids) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* gone */
          }
        }
        reject(new Error(`Word did not become ready within ${WORD_STARTUP_TIMEOUT_MS}ms`))
      }
    }, WORD_STARTUP_TIMEOUT_MS).unref()
  })
}

async function wordServer(): Promise<WordServer> {
  if (server) return server
  const s = await startWordServer()
  server = s
  return s
}

function touchIdle(s: WordServer): void {
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = setTimeout(() => {
    if (server === s) killWordServer('graceful')
  }, WORD_IDLE_MS)
  s.idleTimer.unref()
}

/**
 * Close the shared Word instance and take the deferred scratch with it.
 * Scripts call it before exiting; process exit calls it too. Sweeping here is
 * what stops a render's temp directory outliving the process that made it —
 * the retry timers are `unref`'d, so an exit cancels them.
 */
export function shutdownPdfRenderers(): void {
  killWordServer('graceful')
  sweepRenderScratch()
}

process.on('exit', () => {
  killWordServer('immediate')
  sweepRenderScratch()
})

export const wordComRenderer: PdfRenderer = {
  id: 'word-com',
  isAvailable() {
    if (process.platform !== 'win32') return Promise.resolve(false)
    if (!wordAvailable) {
      // The ProgID's presence in the registry is the cheap, honest signal; it
      // avoids launching WINWORD just to find out.
      const script = "if (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application') { Write-Output 'YES' } else { Write-Output 'NO' }"
      wordAvailable = runProcess('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], 20_000)
        .then((r) => /YES/.test(r.stdout))
        .catch(() => false)
    }
    return wordAvailable
  },
  render(docxPath, pdfPath) {
    return serialized(async () => {
      const t0 = Date.now()
      const docxAbs = path.resolve(docxPath)
      const pdfAbs = path.resolve(pdfPath)
      fs.mkdirSync(path.dirname(pdfAbs), { recursive: true })
      let s: WordServer
      try {
        s = await wordServer()
      } catch (err) {
        return { ok: false, pageCount: null, error: `Word could not be started: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - t0 }
      }
      if (s.idleTimer) clearTimeout(s.idleTimer)

      const reply = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          // A hung export means a hung Word. Drop the whole server; the next render starts a fresh one.
          s.waiter = null
          if (server === s) killWordServer('immediate')
          resolve('TIMEOUT')
        }, RENDER_TIMEOUT_MS)
        s.waiter = (line) => {
          clearTimeout(timer)
          resolve(line)
        }
        s.child.stdin?.write(`${docxAbs}\t${pdfAbs}\n`, 'utf8')
      })
      const ms = Date.now() - t0
      if (server === s) touchIdle(s)

      if (reply === 'TIMEOUT') return { ok: false, pageCount: null, error: `Word render timed out after ${RENDER_TIMEOUT_MS}ms`, ms }
      const err = reply.match(/^ERROR=(.*)/)?.[1]
      if (err) return { ok: false, pageCount: null, error: err.trim(), ms }
      if (!fs.existsSync(pdfAbs)) return { ok: false, pageCount: null, error: 'Word reported success but no PDF was written', ms }
      const pages = reply.match(/^PAGES=(\d+)/)?.[1]
      return { ok: true, pageCount: pages ? Number(pages) : pdfPageCountFallback(fs.readFileSync(pdfAbs)), ms }
    })
  },
}

// ─── LibreOffice ─────────────────────────────────────────────────────────────

const SOFFICE_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/opt/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
]

let sofficePath: Promise<string | null> | null = null

function findSoffice(): Promise<string | null> {
  if (!sofficePath) {
    sofficePath = (async () => {
      for (const c of SOFFICE_CANDIDATES) if (fs.existsSync(c)) return c
      const exe = process.platform === 'win32' ? 'soffice.exe' : 'soffice'
      for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        const p = path.join(dir, exe)
        if (dir && fs.existsSync(p)) return p
      }
      return null
    })()
  }
  return sofficePath
}

export const libreOfficeRenderer: PdfRenderer = {
  id: 'libreoffice',
  async isAvailable() {
    return (await findSoffice()) !== null
  },
  render(docxPath, pdfPath) {
    return serialized(async () => {
      const t0 = Date.now()
      const soffice = await findSoffice()
      if (!soffice) return { ok: false, pageCount: null, error: 'soffice not found', ms: 0 }
      const docxAbs = path.resolve(docxPath)
      const pdfAbs = path.resolve(pdfPath)
      const outDir = makeTempDir('soffice')
      try {
        const r = await runProcess(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, docxAbs], RENDER_TIMEOUT_MS)
        const ms = Date.now() - t0
        if (r.timedOut) return { ok: false, pageCount: null, error: `LibreOffice timed out after ${RENDER_TIMEOUT_MS}ms`, ms }
        const produced = path.join(outDir, path.basename(docxAbs, path.extname(docxAbs)) + '.pdf')
        if (!fs.existsSync(produced)) return { ok: false, pageCount: null, error: (r.stderr || r.stdout || `exit ${r.code}`).trim(), ms }
        fs.mkdirSync(path.dirname(pdfAbs), { recursive: true })
        fs.copyFileSync(produced, pdfAbs)
        return { ok: true, pageCount: pdfPageCountFallback(fs.readFileSync(pdfAbs)), ms }
      } finally {
        removeTempDirLater(outDir)
      }
    })
  },
}

// ─── Selection ───────────────────────────────────────────────────────────────

export const PDF_RENDERERS: PdfRenderer[] = [wordComRenderer, libreOfficeRenderer]

export async function selectPdfRenderer(): Promise<PdfRenderer | null> {
  for (const r of PDF_RENDERERS) if (await r.isAvailable()) return r
  return null
}

export const NO_RENDERER_ERROR = 'no PDF renderer available (install Microsoft Word or LibreOffice)'

/**
 * Render a DOCX (bytes or path) to `outPdfPath`.
 *
 * A buffer needs a file on disk for the renderer to open. That file goes in an
 * OS temp directory (`documents/tmp.ts`) — never under `.career-out`, which is
 * a relative path that does not exist in a deployed runtime and whose `mkdir`
 * is what used to fail with ENOENT after research had already been paid for.
 */
export async function renderDocxToPdf(docx: Buffer | string, outPdfPath: string): Promise<RenderResult & { renderer: string | null }> {
  const renderer = await selectPdfRenderer()
  if (!renderer) return { ok: false, pageCount: null, error: NO_RENDERER_ERROR, ms: 0, renderer: null }
  let docxPath: string
  let scratch: string | null = null
  if (Buffer.isBuffer(docx)) {
    scratch = makeTempDir('render')
    docxPath = path.join(scratch, 'source.docx')
    fs.writeFileSync(docxPath, docx)
  } else {
    docxPath = docx
  }
  try {
    const r = await renderer.render(docxPath, outPdfPath)
    return { ...r, renderer: renderer.id }
  } finally {
    if (scratch) removeTempDirLater(scratch)
  }
}

/** Scratch whose removal was deferred because a renderer still held the file. */
const pendingScratch = new Set<string>()

/**
 * Word keeps the file handle a moment after Close, so the first remove can
 * fail with EBUSY. Retry a few times, then give up quietly: the directory is
 * OS-owned scratch, and a cleanup failure must never replace the real error.
 *
 * The retry timers are `unref`'d — they must never hold a CLI open — which
 * means a process that exits first would leak the directory. `sweepRenderScratch`
 * is the answer to that, and both `shutdownPdfRenderers` and process exit call it.
 */
function removeTempDirLater(dir: string, attempt = 0): void {
  const failure = removeTempDir(dir)
  if (!failure) {
    pendingScratch.delete(dir)
    return
  }
  pendingScratch.add(dir)
  if (attempt < 5) setTimeout(() => removeTempDirLater(dir, attempt + 1), 500).unref()
  else console.warn(`[career/pdf] could not remove the temp directory ${dir}: ${failure.message}`)
}

/**
 * Remove every deferred scratch directory now, and say which ones would not go.
 * Best effort by design: this runs at shutdown, when the only alternative to a
 * best effort is a leak.
 */
export function sweepRenderScratch(): string[] {
  const left: string[] = []
  for (const dir of Array.from(pendingScratch)) {
    if (removeTempDir(dir)) left.push(dir)
    else pendingScratch.delete(dir)
  }
  return left
}
