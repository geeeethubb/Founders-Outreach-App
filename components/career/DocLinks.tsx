'use client'

export interface DocLink {
  path: string
  filename: string
  download_url: string
}

export interface DocumentSet {
  resume_docx?: DocLink | null
  resume_pdf?: DocLink | null
  cover_docx?: DocLink | null
  cover_pdf?: DocLink | null
}

export function downloadHref(path: string | null | undefined): string | null {
  return path ? `/api/career/documents/download?path=${encodeURIComponent(path)}` : null
}

/** Build a DocumentSet from the bare paths GET /api/career/jobs/[id] returns for older package versions. */
export function documentsFromPaths(p: {
  resume_docx_path?: string | null
  resume_pdf_path?: string | null
  cover_docx_path?: string | null
  cover_pdf_path?: string | null
  resume_filename?: string | null
  cover_filename?: string | null
}): DocumentSet {
  const mk = (path: string | null | undefined, filename: string | null | undefined): DocLink | null =>
    path ? { path, filename: filename ?? path.split('/').pop() ?? 'document', download_url: downloadHref(path)! } : null
  return {
    resume_docx: mk(p.resume_docx_path, p.resume_filename),
    resume_pdf: mk(p.resume_pdf_path, p.resume_filename?.replace(/\.docx$/i, '.pdf')),
    cover_docx: mk(p.cover_docx_path, p.cover_filename),
    cover_pdf: mk(p.cover_pdf_path, p.cover_filename?.replace(/\.docx$/i, '.pdf')),
  }
}

const ORDER: { key: keyof DocumentSet; label: string }[] = [
  { key: 'resume_pdf', label: 'Résumé PDF' },
  { key: 'resume_docx', label: 'Résumé DOCX' },
  { key: 'cover_pdf', label: 'Cover letter PDF' },
  { key: 'cover_docx', label: 'Cover letter DOCX' },
]

/** Download links for whatever documents a package has. Nothing here is a bucket URL — the route streams by owner-prefixed path. */
export default function DocLinks({ documents, compact = false }: { documents: DocumentSet | null | undefined; compact?: boolean }) {
  const links = ORDER.map((o) => ({ ...o, doc: documents?.[o.key] ?? null })).filter((o) => o.doc)
  if (links.length === 0) return <span className="text-xs text-slate-400">No documents yet.</span>
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => (
        <a
          key={l.key}
          href={l.doc!.download_url}
          title={l.doc!.filename}
          className={`inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 ${
            compact ? 'px-2 py-0.5 text-xs' : 'px-3 py-1.5 text-sm font-medium'
          }`}
        >
          ↓ {l.label}
        </a>
      ))}
    </div>
  )
}
