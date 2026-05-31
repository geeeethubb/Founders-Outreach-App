'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

interface Props {
  userId: string
  onClose: () => void
}

type Mode = 'linkedin' | 'manual'

const COMMON_TAGS = ['YC Founder', 'Bay Area', 'Investor', 'Operator', 'Engineer', 'Designer']

const BLANK_FORM = {
  name: '',
  email: '',
  company: '',
  role: '',
  location: '',
  linkedin_url: '',
  twitter_handle: '',
  tags: [] as string[],
  notes: '',
}

export default function AddContactModal({ userId, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('linkedin')

  // LinkedIn import state
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')

  // Form state (used for both enriched review + manual entry)
  const [form, setForm] = useState(BLANK_FORM)
  const [enriched, setEnriched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const router = useRouter()
  const supabase = createClient()

  function toggleTag(tag: string) {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }))
  }

  // ── Step 1: Enrich from LinkedIn ──────────────────────────────────────────
  async function handleImport() {
    if (!linkedinUrl.trim()) return
    setImporting(true)
    setImportError('')
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
        name: c.name ?? '',
        email: c.email ?? '',
        company: c.company ?? '',
        role: c.role ?? '',
        location: c.location ?? '',
        linkedin_url: c.linkedin_url ?? linkedinUrl.trim(),
        twitter_handle: '',
        tags: [],
        notes: '',
      })
      setEnriched(true)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  // ── Step 2: Save contact + fire research ─────────────────────────────────
  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setSaveError('')

    const { data, error } = await supabase
      .from('contacts')
      .insert({
        user_id: userId,
        name: form.name.trim(),
        email: form.email.trim() || null,
        company: form.company.trim() || null,
        role: form.role.trim() || null,
        location: form.location.trim() || null,
        linkedin_url: form.linkedin_url.trim() || null,
        twitter_handle: form.twitter_handle.trim() || null,
        tags: form.tags,
        notes: form.notes.trim() || null,
        status: 'new',
        source: enriched ? 'apollo' : 'manual',
      })
      .select()
      .single()

    if (error) {
      setSaveError(error.message)
      setSaving(false)
      return
    }

    // Trigger AI research in background — fire and forget
    if (data?.id) {
      fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: data.id }),
      }).catch(() => {})
    }

    onClose()
    router.refresh()
    router.push(`/dashboard/contacts/${data.id}`)
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
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
              ✓ Pulled from Apollo — edit anything before saving. AI research starts automatically.
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Full Name *</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="Not found — add manually"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Company</label>
                <input value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
                <input value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Location</label>
                <input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">LinkedIn URL</label>
                <input value={form.linkedin_url} onChange={(e) => setForm((f) => ({ ...f, linkedin_url: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">Tags</label>
              <div className="flex flex-wrap gap-2">
                {COMMON_TAGS.map((tag) => (
                  <button key={tag} type="button" onClick={() => toggleTag(tag)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      form.tags.includes(tag) ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300'
                    }`}>
                    {tag}
                  </button>
        