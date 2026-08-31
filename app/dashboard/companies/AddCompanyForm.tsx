'use client'

import { useState } from 'react'
import { api } from '@/components/career/api'
import { PRIORITY_MAX, PRIORITY_MIN } from '@/lib/career/companies/intent'

// Adding a company by hand IS the explicit choice this whole page turns on, so
// the only options are the user's own two intents. 'suggested' belongs to the
// scout and is never written from here.
const CHOICES: { value: string; label: string }[] = [
  { value: 'target', label: 'Target — I want to work here' },
  { value: 'watching', label: 'Watching — keep an eye on it' },
]

export default function AddCompanyForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [careersUrl, setCareersUrl] = useState('')
  const [status, setStatus] = useState<string>('target')
  const [priority, setPriority] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setErr(null)
    const r = await api<{ id: string }>('/api/career/companies', {
      json: {
        name: name.trim(),
        domain: domain.trim() || undefined,
        careers_url: careersUrl.trim() || undefined,
        watch_status: status,
        watch_priority: priority === '' ? undefined : Number(priority),
        watch_note: note.trim() || undefined,
      },
    })
    setBusy(false)
    if (!r.ok) return setErr(r.error)
    setName('')
    setDomain('')
    setCareersUrl('')
    setPriority('')
    setNote('')
    setOpen(false)
    onAdded()
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
        Add company
      </button>
    )
  }

  const input = 'rounded-md border border-slate-300 px-2 py-1 text-sm'
  return (
    <form onSubmit={submit} className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name *" required className={input} />
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="domain (acme.com)" className={input} />
        <input value={careersUrl} onChange={(e) => setCareersUrl(e.target.value)} placeholder="careers URL (helps ATS detection)" className={input} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
          {CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={PRIORITY_MIN}
          max={PRIORITY_MAX}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          placeholder="priority 0–100 (higher is checked first)"
          className={input}
        />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note — why this company?" className={input} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" disabled={busy || !name.trim()} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Adding…' : 'Add to watchlist'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500">
          Cancel
        </button>
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>
    </form>
  )
}
