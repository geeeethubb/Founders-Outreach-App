'use client'

import { useState } from 'react'
import type { EvidenceBank } from '@/lib/career/types'
import { Notice } from './shared'

interface ImportResult {
  ok: boolean
  summary: string[]
  errors: string[]
  costUsd: number
}

export default function DocumentsTab({ bank, reload }: { bank: EvidenceBank; reload: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null)
  const [approve, setApprove] = useState(false)
  const [includeProfile, setIncludeProfile] = useState(false)
  const [text, setText] = useState('')
  const [source, setSource] = useState('linkedin')
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const doc = bank.masterDocument

  async function run(label: string, fn: () => Promise<Response>) {
    setRunning(label)
    setError(null)
    setResult(null)
    try {
      const res = await fn()
      const body = (await res.json()) as ImportResult & { error?: string }
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`)
      setResult(body)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setRunning(null)
    }
  }

  function upload() {
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    form.append('as_master', 'true')
    form.append('approve', String(approve))
    form.append('include_profile', String(includeProfile))
    run('upload', () => fetch('/api/career/evidence/upload', { method: 'POST', body: form }))
  }

  const importMaster = () =>
    run('master', () =>
      fetch('/api/career/evidence/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'master', approve, includeProfile }),
      })
    )

  const importText = () =>
    run('text', () =>
      fetch('/api/career/evidence/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'text', text, source, approve }),
      })
    )

  return (
    <div className="space-y-6">
      {error && <Notice kind="error">{error}</Notice>}
      {running && (
        <Notice kind="info">
          Running {running}… the importer reads every bullet and proposes facts; a full résumé takes a minute or two.
        </Notice>
      )}
      {result && (
        <Notice kind={result.ok ? 'ok' : 'error'}>
          <div className="font-medium">{result.ok ? 'Import finished.' : 'Import finished with problems.'}</div>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {result.summary.map((l, i) => <li key={i}>{l}</li>)}
            {result.errors.map((l, i) => <li key={`e${i}`} className="text-red-700">{l}</li>)}
          </ul>
        </Notice>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Master résumé</div>
        {doc ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">{doc.filename}</span>
            <span className="font-mono text-xs text-slate-500">sha {doc.sha256.slice(0, 12)}</span>
            <span className="text-xs text-slate-500">{doc.byte_size ? `${Math.round(doc.byte_size / 1024)} KB` : ''}</span>
            <span className="text-xs text-slate-500">uploaded {new Date(doc.uploaded_at).toLocaleString()}</span>
            <span className="text-xs text-slate-500">{doc.paragraph_map.length} paragraphs mapped</span>
          </div>
        ) : (
          <div className="text-sm text-slate-500">No master stored. Upload one below or run <code className="rounded bg-slate-100 px-1">npm run career:seed</code>.</div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input type="file" accept=".docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
          <button type="button" disabled={!file || running !== null} onClick={upload} className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50">
            Upload as master
          </button>
          <button type="button" disabled={!doc || running !== null} onClick={importMaster} className="rounded border border-indigo-200 bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700 disabled:opacity-50">
            Import from master
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} /> approve imported rows immediately</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeProfile} onChange={(e) => setIncludeProfile(e.target.checked)} /> also import My Profile text (creates a second source; conflicts may appear under Review)</label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Import pasted text</div>
        <p className="mb-2 text-xs text-slate-500">LinkedIn “About” and experience text, an older résumé, project notes. Each line is a citable paragraph; experiences are inferred.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder="Paste text here" className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs text-slate-800" />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="linkedin">linkedin</option>
            <option value="alternate_resume">alternate résumé</option>
            <option value="project_notes">project notes</option>
            <option value="manual">manual</option>
          </select>
          <button type="button" disabled={text.trim().length < 40 || running !== null} onClick={importText} className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50">
            Import pasted text
          </button>
        </div>
      </section>
    </div>
  )
}
