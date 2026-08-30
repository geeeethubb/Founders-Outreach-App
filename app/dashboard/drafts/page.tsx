'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { RichTextEditor } from '@/components/editor/RichTextEditor'
import { formatRelativeTime } from '@/lib/utils'

interface DraftEmail {
  id: string
  contact_id: string
  campaign_id: string | null
  subject: string | null
  body: string | null
  variant_label: string | null
  created_at: string
  generation_metadata: { outreach_goal?: string } | null
  contact: {
    name: string
    email: string | null
    company: string | null
    role: string | null
  }
  campaign: { name: string } | null
}

export default function DraftsPage() {
  const supabase = createClient()
  const [drafts, setDrafts] = useState<DraftEmail[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Record<string, { subject: string; body: string }>>({})
  const [sending, setSending] = useState<Set<string>>(new Set())
  const [approvingAll, setApprovingAll] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase
      .from('emails')
      .select(`
        id, contact_id, campaign_id, subject, body, variant_label, created_at, generation_metadata,
        contact:contacts(name, email, company, role),
        campaign:campaigns(name)
      `)
      .eq('user_id', user.id)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
    setDrafts((data ?? []) as unknown as DraftEmail[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        // init edit state
        const draft = drafts.find((d) => d.id === id)
        if (draft && !editing[id]) {
          setEditing((e) => ({ ...e, [id]: { subject: draft.subject ?? '', body: draft.body ?? '' } }))
        }
      }
      return next
    })
  }

  function updateEdit(id: string, field: 'subject' | 'body', value: string) {
    setEditing((e) => ({ ...e, [id]: { ...e[id], subject: e[id]?.subject ?? '', body: e[id]?.body ?? '', [field]: value } }))
  }

  async function saveEdit(id: string) {
    const edit = editing[id]
    if (!edit) return
    await supabase.from('emails').update({ subject: edit.subject, body: edit.body }).eq('id', id)
    setDrafts((prev) => prev.map((d) => d.id === id ? { ...d, subject: edit.subject, body: edit.body } : d))
  }

  async function sendDraft(draft: DraftEmail) {
    if (!draft.contact.email) {
      setErrors((e) => ({ ...e, [draft.id]: 'No email address for this contact. Add one in their profile.' }))
      return
    }
    setSending((prev) => new Set(prev).add(draft.id))
    setErrors((e) => { const n = { ...e }; delete n[draft.id]; return n })

    // Save any pending edits first
    const edit = editing[draft.id]
    const subject = edit?.subject ?? draft.subject ?? ''
    const body = edit?.body ?? draft.body ?? ''
    if (edit) await supabase.from('emails').update({ subject, body }).eq('id', draft.id)

    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email_id: draft.id,
        to_email: draft.contact.email,
        to_name: draft.contact.name,
        subject,
        body,
      }),
    })
    const data = await res.json()

    setSending((prev) => { const n = new Set(prev); n.delete(draft.id); return n })

    if (!res.ok) {
      setErrors((e) => ({ ...e, [draft.id]: data.error ?? 'Send failed' }))
    } else {
      setDrafts((prev) => prev.filter((d) => d.id !== draft.id))
      deselect(draft.id)
    }
  }

  async function discardDraft(id: string) {
    if (!confirm('Discard this draft?')) return
    await supabase.from('emails').delete().eq('id', id)
    setDrafts((prev) => prev.filter((d) => d.id !== id))
    deselect(id)
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function deselect(id: string) {
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === drafts.length ? new Set() : new Set(drafts.map((d) => d.id))))
  }

  // A bulk send must never email one person twice. If any contact in the batch
  // has more than one draft, stop and ask the founder to pick one.
  function hasDuplicateContacts(batch: DraftEmail[]): boolean {
    const perContact = new Map<string, number>()
    for (const d of batch) perContact.set(d.contact_id, (perContact.get(d.contact_id) ?? 0) + 1)
    const dupes = [...perContact.values()].filter((n) => n > 1).length
    if (dupes === 0) return false
    alert(`${dupes} contact${dupes !== 1 ? 's have' : ' has'} more than one draft — pick one variant and discard the rest before sending in bulk.`)
    return true
  }

  async function sendSelected() {
    const sendable = drafts.filter((d) => selected.has(d.id) && d.contact.email)
    if (sendable.length === 0) {
      alert('None of the selected drafts have an email address to send to.')
      return
    }
    if (hasDuplicateContacts(sendable)) return
    if (!confirm(`Send ${sendable.length} selected email${sendable.length !== 1 ? 's' : ''} now? This cannot be undone.`)) return
    setBulkBusy(true)
    for (const draft of sendable) {
      await sendDraft(draft) // removes from drafts on success, sets an error otherwise
      deselect(draft.id)
      await new Promise((r) => setTimeout(r, 300)) // don't hammer the API
    }
    setBulkBusy(false)
  }

  async function discardSelected() {
    if (selected.size === 0) return
    if (!confirm(`Discard ${selected.size} selected draft${selected.size !== 1 ? 's' : ''}? This cannot be undone.`)) return
    setBulkBusy(true)
    const ids = [...selected]
    await supabase.from('emails').delete().in('id', ids)
    setDrafts((prev) => prev.filter((d) => !selected.has(d.id)))
    setSelected(new Set())
    setBulkBusy(false)
  }

  async function approveAll() {
    const sendable = drafts.filter((d) => d.contact.email)
    if (sendable.length === 0) {
      alert('No drafts with email addresses to send.')
      return
    }
    if (hasDuplicateContacts(sendable)) return
    if (!confirm(`Send ${sendable.length} email${sendable.length !== 1 ? 's' : ''} now? This cannot be undone.`)) return
    setApprovingAll(true)

    for (const draft of sendable) {
      await sendDraft(draft)
      // small delay to avoid hammering the API
      await new Promise((r) => setTimeout(r, 300))
    }
    setApprovingAll(false)
  }

  const sendableCount = drafts.filter((d) => d.contact.email).length
  const selectedCount = drafts.filter((d) => selected.has(d.id)).length
  const selectedSendableCount = drafts.filter((d) => selected.has(d.id) && d.contact.email).length
  const allSelected = drafts.length > 0 && selectedCount === drafts.length
  const busy = approvingAll || bulkBusy

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading drafts…</div>

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Draft Emails</h1>
          <p className="text-slate-500 text-sm mt-1">
            {drafts.length === 0
              ? 'No drafts yet'
              : `${drafts.length} draft${drafts.length !== 1 ? 's' : ''} waiting · ${sendableCount} ready to send`}
          </p>
        </div>
        {drafts.length > 0 && (
          <button
            onClick={approveAll}
            disabled={busy || sendableCount === 0}
            className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
          >
            {approvingAll ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Sending…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Approve All ({sendableCount})
              </>
            )}
          </button>
        )}
      </div>

      {/* Selection toolbar */}
      {drafts.length > 0 && (
        <div className="flex items-center gap-3 mb-3 bg-white border border-slate-200 rounded-lg px-4 py-2.5">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = selectedCount > 0 && !allSelected }}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300"
            />
            <span className="text-sm text-slate-600">
              {selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}
            </span>
          </label>

          {selectedCount > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={sendSelected}
                disabled={busy || selectedSendableCount === 0}
                title={selectedSendableCount === 0 ? 'None of the selected drafts have an email address' : undefined}
                className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                {bulkBusy ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                )}
                Send selected ({selectedSendableCount})
              </button>
              <button
                onClick={discardSelected}
                disabled={busy}
                className="flex items-center gap-1.5 border border-slate-200 text-slate-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                Discard selected ({selectedCount})
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-16 text-center">
          <div className="text-4xl mb-3">📭</div>
          <p className="font-medium text-slate-700 mb-1">No drafts yet</p>
          <p className="text-slate-400 text-sm">
            Drafts from Compose (2+ contacts) and Campaign generate appear here. Scout drafts are on Outreach.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map((draft) => {
            const isExpanded = expanded.has(draft.id)
            const isSending = sending.has(draft.id)
            const edit = editing[draft.id]
            const subject = edit?.subject ?? draft.subject ?? ''
            const body = edit?.body ?? draft.body ?? ''
            const hasEmail = !!draft.contact.email

            return (
              <div
                key={draft.id}
                className={`bg-white rounded-xl border overflow-hidden transition-colors ${
                  selected.has(draft.id) ? 'border-indigo-300 ring-1 ring-indigo-200' : 'border-slate-200'
                }`}
              >
                {/* Card header — always visible */}
                <div
                  className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-slate-50 transition-colors"
                  onClick={() => toggleExpand(draft.id)}
                >
                  <div onClick={(e) => e.stopPropagation()} className="flex items-center flex-shrink-0">
                    <input
                      type="checkbox"
                      checked={selected.has(draft.id)}
                      onChange={() => toggleSelect(draft.id)}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300 cursor-pointer"
                    />
                  </div>
                  <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-indigo-600 font-bold text-sm">
                      {draft.contact.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-800 text-sm">{draft.contact.name}</p>
                      {draft.variant_label && (
                        <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                          Variant {draft.variant_label}
                        </span>
                      )}
                      {draft.campaign && (
                        <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">
                          {draft.campaign.name}
                        </span>
                      )}
                      {!hasEmail && (
                        <span className="text-xs bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full">
                          No email address
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 truncate mt-0.5">
                      {[draft.contact.role, draft.contact.company].filter(Boolean).join(' @ ')}
                    </p>
                    <p className="text-sm text-slate-600 truncate mt-1 font-medium">{subject}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs text-slate-400">{formatRelativeTime(draft.created_at)}</span>
                    <svg
                      className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Expanded body */}
                {isExpanded && (
                  <div className="border-t border-slate-100 px-5 pb-5 pt-4 space-y-3">
                    {/* Subject */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Subject</label>
                      <input
                        value={subject}
                        onChange={(e) => updateEdit(draft.id, 'subject', e.target.value)}
                        onBlur={() => saveEdit(draft.id)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    {/* Body */}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Body</label>
                      <RichTextEditor
                        value={body}
                        onChange={(v) => updateEdit(draft.id, 'body', v)}
                        onBlur={() => saveEdit(draft.id)}
                        rows={10}
                        textareaClassName="font-mono"
                      />
                    </div>

                    {/* Error */}
                    {errors[draft.id] && (
                      <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">
                        {errors[draft.id]}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center justify-between pt-1">
                      <button
                        onClick={() => discardDraft(draft.id)}
                        className="text-xs text-slate-400 hover:text-red-500 transition-colors"
                      >
                        Discard
                      </button>
                      <div className="flex items-center gap-2">
                        {!hasEmail && (
                          <span className="text-xs text-amber-600">Add email address to contact first</span>
                        )}
                        <button
                          onClick={() => sendDraft(draft)}
                          disabled={isSending || !hasEmail}
                          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                        >
                          {isSending ? (
                            <>
                              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Sending…
                            </>
                          ) : (
                            <>
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                              </svg>
                              Send
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
