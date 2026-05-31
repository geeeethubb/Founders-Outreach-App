'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

interface Props {
  userId: string
  onClose: () => void
}

type Mode = 'linkedin' | 'bulk' | 'manual'

const COMMON_TAGS = ['YC Founder', 'Bay Area', 'Investor', 'Operator', 'Engineer', 'Designer']

const BLANK_FORM = {
  name: '', email: '', company: '', role: '',
  location: '', linkedin_url: '', twitter_handle: '',
  tags: [] as string[], notes: '',
}

interface BulkResult {
  url: string
  status: 'pending' | 'loading' | 'found' | 'not_found' | 'error'
  contact?: typeof BLANK_FORM & { linkedin_url: string }
  error?: string
}

async function triggerResearch(contactId: string) {
  fetch('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId }),
  }).catch(() => {})
}

export default function AddContactModal({ userId, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('linkedin')

  // Single LinkedIn import
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [form, setForm] = useState(BLANK_FORM)
  const [enriched, setEnriched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Bulk import
  const [bulkText, setBulkText] = useState('')
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([])
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkDone, setBulkDone] = useState(false)

  const router = useRouter()
  const supabase = createClient()

  function toggleTag(tag: string) {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }))
  }

  // ── Single import ─────────────────────────────────────────────────────────
  async function handleImport() {
    if (!linkedinUrl.trim()) return
    setImporting(true); setImportError('')
    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedin_url: linkedinUrl.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Import failed')
      const c = data.contact
      setForm({
        name: c.name ?? '', email: c.email ?? '', company: c.company ?? '',
        role: c.role ?? '', location: c.location ?? '',
        linkedin_url: c.linkedin_url ?? linkedinUrl.trim(),
        twitter_handle: '', tags: [], notes: '',
      })
      setEnriched(true)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true); setSaveError('')
    const { data, error } = await supabase.from('contacts').insert({
      user_id: userId,
      name: form.name.trim(),
      email: form.email.trim() || null,
      company: form.company.trim() || null,
      role: form.role.trim() || null,
      location: form.location.trim() || null,
      linkedin_url: form.linkedin_url.trim() || null,
      twitter_handle: form.twitter_handle.trim() || null,
      tags: form.tags, notes: form.notes.trim() || null,
      status: 'new', source: enriched ? 'apollo' : 'manual',
    }).select().single()
    if (error) { setSaveError(error.message); setSaving(false); return }
    if (data?.id) triggerResearch(data.id)
    onClose(); router.refresh(); router.push(`/dashboard/contacts/${data.id}`)
  }

  // ── Bulk import ───────────────────────────────────────────────────────────
  function parseBulkUrls(): string[] {
    return bulkText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.includes('linkedin.com/in/'))
  }

  async function handleBulkEnrich() {
    const urls = parseBulkUrls()
    if (urls.length === 0) return
    setBulkRunning(true)
    setBulkDone(false)
    const initial: BulkResult[] = urls.map((url) => ({ url, status: 'pending' }))
    setBulkResults(initial)

    for (let i = 0; i < urls.length; i++) {
      setBulkResults((prev) => prev.map((r, idx) => idx === i ? { ...r, status: 'loading' } : r))
      try {
        const res = await fetch('/api/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkedin_url: urls[i] }),
        })
        const data = await res.json()
        if (!res.ok || !data.contact) throw new Error(data.error ?? 'Not found')
        const c = data.contact
        setBulkResults((prev) => prev.map((r, idx) => idx === i ? {
          ...r, status: 'found',
          contact: {
            name: c.name ?? '', email: c.email ?? '', company: c.company ?? '',
            role: c.role ?? '', location: c.location ?? '',
            linkedin_url: c.linkedin_url ?? urls[i],
            twitter_handle: '', tags: [], notes: '',
          },
        } : r))
      } catch (e) {
        setBulkResults((prev) => prev.map((r, idx) => idx === i ? {
          ...r, status: 'error',
          error: e instanceof Error ? e.message : 'Failed',
        } : r))
      }
      // Small delay to avoid rate limits
      if (i < urls.length - 1) await new Promise((r) => setTimeout(r, 400))
    }
    setBulkRunning(false)
    setBulkDone(true)
  }

  async function handleBulkSave() {
    const found = bulkResults.filter((r) => r.status === 'found' && r.contact)
    if (found.length === 0) return
    setBulkSaving(true)
    const savedIds: string[] = []
    for (const r of found) {
      const c = r.contact!
      const { data } = await supabase.from('contacts').insert({
        user_id: userId,
        name: c.name.trim(),
        email: c.email.trim() || null,
        company: c.company.trim() || null,
        role: c.role.trim() || null,
        location: c.location.trim() || null,
        linkedin_url: c.linkedin_url.trim() || null,
        tags: [], notes: null,
        status: 'new', source: 'apollo',
      }).select().single()
      if (data?.id) savedIds.push(data.id)
    }
    // Fire research for all saved contacts
    for (const id of savedIds) triggerResearch(id)
    setBulkSaving(false)
    onClose()
    router.refresh()
  }

  // ── Enriched review screen ────────────────────────────────────────────────
  if (enriched) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <h2 className="font-semibold text-slate-900">Contact found — review & save</h2>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
              ✓ Pulled from Apollo — edit anything before saving. AI research starts automatically.
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Full Name *</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="Not found — add manually" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Company</label>
                <input value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
                <input value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Location</label>
                <input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">LinkedIn URL</label>
                <input value={form.linkedin_url} onChange={(e) => setForm((f) => ({ ...f, linkedin_url: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">Tags</label>
              <div className="flex flex-wrap gap-2">
                {COMMON_TAGS.map((tag) => (
                  <button key={tag} type="button" onClick={() => toggleTag(tag)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${form.tags.includes(tag) ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300'}`}>{tag}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
              <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="How you found them, why you want to connect…" rows={2} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
            </div>
            {saveError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">{saveError}</div>}
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setEnriched(false)} className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors">← Back</button>
              <button type="submit" disabled={saving} className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
                {saving ? 'Saving…' : 'Save & Start Research'}
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        {/* Header + tabs */}
        <div className="px-6 pt-5 pb-4 border-b border-slate-100">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">Add Contact</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="flex rounded-lg border border-slate-200 p-1 gap-1">
            {(['linkedin', 'bulk', 'manual'] as Mode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === m ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700'}`}>
                {m === 'linkedin' ? 'Import from LinkedIn' : m === 'bulk' ? 'Bulk Import' : 'Add Manually'}
              </button>
            ))}
          </div>
        </div>

        {/* ── Single LinkedIn ── */}
        {mode === 'linkedin' && (
          <div className="px-6 py-6 space-y-5">
            <div className="text-center">
              <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-700">Paste a LinkedIn profile URL</p>
              <p className="text-xs text-slate-400 mt-1">Apollo finds their email, role, company, and location automatically</p>
            </div>
            <input value={linkedinUrl} onChange={(e) => { setLinkedinUrl(e.target.value); setImportError('') }}
              onKeyDown={(e) => e.key === 'Enter' && handleImport()}
              placeholder="https://linkedin.com/in/samaltman"
              className="w-full px-3 py-3 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" autoFocus />
            {importError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">{importError}</div>}
            <button onClick={handleImport} disabled={importing || !linkedinUrl.trim()}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2">
              {importing ? (<><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Looking up…</>) : 'Import Contact'}
            </button>
            <p className="text-center text-xs text-slate-400">Uses 1 Apollo credit per lookup</p>
          </div>
        )}

        {/* ── Bulk import ── */}
        {mode === 'bulk' && (
          <div className="px-6 py-5 space-y-4">
            {!bulkDone ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    LinkedIn URLs <span className="text-slate-400 font-normal">— one per line (or comma-separated)</span>
                  </label>
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    placeholder={`https://linkedin.com/in/samaltman\nhttps://linkedin.com/in/sama\nhttps://linkedin.com/in/elonmusk`}
                    rows={6}
                    disabled={bulkRunning}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-mono disabled:opacity-50"
                  />
                  <p className="text-xs text-slate-400 mt-1">{parseBulkUrls().length} valid URL{parseBulkUrls().length !== 1 ? 's' : ''} detected · Uses 1 Apollo credit each</p>
                </div>

                {/* Progress */}
                {bulkResults.length > 0 && (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {bulkResults.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        {r.status === 'loading' && <svg className="w-3.5 h-3.5 animate-spin text-indigo-500 flex-shrink-0" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
                        {r.status === 'pending' && <div className="w-3.5 h-3.5 rounded-full border border-slate-300 flex-shrink-0" />}
                        {r.status === 'found' && <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                        {(r.status === 'not_found' || r.status === 'error') && <svg className="w-3.5 h-3.5 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>}
                        <span className="truncate text-slate-500">{r.url.replace('https://www.linkedin.com/in/', '').replace('https://linkedin.com/in/', '')}</span>
                        {r.status === 'found' && <span className="text-green-600 font-medium flex-shrink-0">{r.contact?.name}</span>}
                        {r.status === 'error' && <span className="text-red-400 flex-shrink-0">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                )}

                <button onClick={handleBulkEnrich} disabled={bulkRunning || parseBulkUrls().length === 0}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2">
                  {bulkRunning ? (<><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className