// Where generated documents and uploaded résumés live.
//
// Primary: the private Supabase Storage bucket `career-docs` (migration 014),
// accessed only through the service-role client in route handlers — the
// browser never sees a bucket URL. Fallback: a local, gitignored directory
// under the project (`.career-out/`), which is also what scripts and evals
// use so they run without a network.
//
// A storage path is self-describing: `supabase:<bucket>/<object>` or
// `local:<relative path>`. Files are never overwritten — paths carry the
// package version, and `upsert` is off — which is what makes an application's
// submitted documents immutable (docs/CAREER_OS.md §4).

import fs from 'fs'
import path from 'path'
import { createServiceClient } from '@/lib/supabase/server'

export const CAREER_BUCKET = 'career-docs'

export function localOutputDir(): string {
  return process.env.CAREER_OUTPUT_DIR || path.join(process.cwd(), '.career-out')
}

export type StorageBackend = 'supabase' | 'local'

export interface SaveDocumentParams {
  userId: string
  /** Relative object path, e.g. "packages/<packageId>/v1/Zuyu_Liu_Acme_Resume.docx". */
  relativePath: string
  data: Buffer
  contentType: string
  /** Force a backend. Default: supabase when configured, else local. */
  backend?: StorageBackend
}

export interface SaveDocumentResult {
  storage_path: string
  backend: StorageBackend
  byte_size: number
  /** Set when the primary backend failed and the local fallback was used. */
  warning?: string
}

function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function safeRelative(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.includes('..')) throw new Error(`unsafe storage path: ${p}`)
  return cleaned
}

async function saveLocal(userId: string, relativePath: string, data: Buffer): Promise<SaveDocumentResult> {
  const rel = path.posix.join(userId, safeRelative(relativePath))
  const abs = path.join(localOutputDir(), rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  if (fs.existsSync(abs)) throw new Error(`refusing to overwrite existing document: ${rel}`)
  fs.writeFileSync(abs, data)
  return { storage_path: `local:${rel}`, backend: 'local', byte_size: data.length }
}

export async function saveDocument(params: SaveDocumentParams): Promise<SaveDocumentResult> {
  const backend: StorageBackend = params.backend ?? (supabaseConfigured() ? 'supabase' : 'local')
  if (backend === 'local') return saveLocal(params.userId, params.relativePath, params.data)

  const object = path.posix.join(params.userId, safeRelative(params.relativePath))
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.storage
      .from(CAREER_BUCKET)
      .upload(object, params.data, { contentType: params.contentType, upsert: false })
    if (error) throw new Error(error.message)
    return { storage_path: `supabase:${CAREER_BUCKET}/${object}`, backend: 'supabase', byte_size: params.data.length }
  } catch (e) {
    // The bucket may not exist yet (migration 014 creates it, but the storage
    // schema can be unavailable) — degrade to local and SAY so.
    const message = e instanceof Error ? e.message : String(e)
    const local = await saveLocal(params.userId, params.relativePath, params.data)
    return { ...local, warning: `Supabase Storage unavailable (${message.slice(0, 120)}); saved locally instead` }
  }
}

export async function loadDocument(storagePath: string): Promise<Buffer | null> {
  if (storagePath.startsWith('local:')) {
    const abs = path.join(localOutputDir(), storagePath.slice('local:'.length))
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null
  }
  if (storagePath.startsWith('supabase:')) {
    const rest = storagePath.slice('supabase:'.length)
    const slash = rest.indexOf('/')
    const bucket = rest.slice(0, slash)
    const object = rest.slice(slash + 1)
    const supabase = createServiceClient()
    const { data, error } = await supabase.storage.from(bucket).download(object)
    if (error || !data) return null
    return Buffer.from(await data.arrayBuffer())
  }
  // Bare absolute/relative filesystem path — scripts pass these.
  return fs.existsSync(storagePath) ? fs.readFileSync(storagePath) : null
}

/** Absolute filesystem path for a local document, or null for remote ones. */
export function localPathFor(storagePath: string): string | null {
  if (storagePath.startsWith('local:')) return path.join(localOutputDir(), storagePath.slice('local:'.length))
  if (!storagePath.startsWith('supabase:')) return storagePath
  return null
}

export function contentTypeFor(filename: string): string {
  if (filename.endsWith('.pdf')) return 'application/pdf'
  if (filename.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'application/octet-stream'
}
