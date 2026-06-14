'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { RichTextEditor, type RichTextEditorHandle } from '@/components/editor/RichTextEditor'
import type { Template } from '@/types'

const PLACEHOLDER_HELPERS = [
  { label: 'Their recent work', value: '[mention something specific about their recent work or project]' },
  { label: 'Their company', value: '[add a specific detail about their company or what they build]' },
  { label: 'Relevant question', value: '[ask a genuine question relevant to their experience or role]' },
  { label: 'My accomplishment', value: '[highlight my most relevant accomplishment for this person]' },
  { label: 'My background', value: '[connect my background to their industry or work]' },
  { label: 'Shared connection', value: '[mention any shared context, school, or connection]' },
  { label: 'Specific ask', value: '[insert a specific, low-commitment ask tailored to them]' },
  { label: 'Opening hook', value: '[open with something specific and compelling about them]' },
]

// Extra placeholders that only make sense for follow-up templates, where the AI
// is given the original email it's replying to.
const FOLLOWUP_PLACEHOLDER_HELPERS = [
  { label: 'Reference previous email', value: '[reference my previous email in one natural line]' },
  { label: 'Fresh reason to reconnect', value: '[a fresh, low-pressure reason to follow up now]' },
  { label: 'Restate the ask briefly', value: '[restate my ask in one short, softer sentence]' },
]

const BLANK_FORM = {
  name: '',
  subject_template: '',
  body_template: '',
  category: '' as string,
  type: 'initial' as 'initial' | 'followup',
}

export default function TemplatesPage() {
  const supabase = createClient()
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Template | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const editorRef = useRef<RichTextEditorHandle>(null)

  async function load() {
    const { data } = await supabase
      .from('templates')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
    setTemplates((data as Template[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function startNew() {
    setEditing(null)
    setIsNew(true)
    setForm(BLANK_FORM)
    setSaved(false)
    setError('')
  }

  function startEdit(t: Template) {
    setEditing(t)
    setIsNew(false)
    setForm({
      name: t.name ?? '',
      subject_template: t.subject_template ?? '',
      body_template: t.body_template ?? '',
      category: t.category ?? '',
      type: t.type === 'followup' ? 'followup' : 'initial',
    })
    setSaved(false)
    setError('')
  }

  function cancelEdit() {
    setEditing(null)
    setIsNew(false)
  }

  function insertPlaceholder(placeholder: string) {
    editorRef.current?.insertAtCursor(placeholder)
  }

  async function save() {
    if (!form.name.trim()) { setError('Template name is required'); return }
    if (!form.body_template.trim()) { setError('Template body is required'); return }
    setSaving(true)
    setError('')
    try {
      if (isNew) {
        const res = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            subject_template: form.subject_template || null,
            body_template: form.body_template,
            category: form.category || null,
            type: form.type,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        setSaved(true)
        setIsNew(false)
        setEditing(data.template)
        await load()
      } else if (editing) {
        const res = await fetch(`/api/templates/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            subject_template: form.subject_template || null,
            body_template: form.body_template,
            category: form.category || null,
            type: form.type,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        setSaved(true)
        await load()
      }
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this template?')) return
    setDeletingId(id)
    await fetch(`/api/templates/${id}`, { method: 'DELETE' })
    if (editing?.id === id) cancelEdit()
    await load()
    setDeletingId(null)
  }

  // Count placeholders in body
  const placeholders = (form.body_template.match(/\[[^\]]+\]/g) ?? [])

  const showEditor = isNew || editing !== null

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Email Templates</h1>
          <p className="text-slate-500 text-sm mt-1">
            Write your email in your style. Use <code className="bg-slate-100 px-1 rounded text-xs">[placeholders]</code> where AI should fill in personalized content.
          </p>
        </div>
        <button
          onClick={startNew}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Template
        </button>
      </div>

      <div className={`grid gap-6 ${showEditor ? 'grid-cols-[300px_1fr]' : 'grid-cols-1'}`}>

        {/* ── Template list ── */}
        <div className="space-y-3">
          {loading ? (
            <p className="text-sm text-slate-400 py-4 text-center">Loading…</p>
          ) : templates.length === 0 && !showEditor ? (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
              <div className="text-4xl mb-3">📝</div>
              <p className="font-medium text-slate-700 mb-1">No templates yet</p>
              <p className="text-sm text-slate-400 mb-4">Create your first template to get started</p>
              <button
                onClick={startNew}
                className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
              >
                Create template →
              </button>
            </div>
          ) : (
            templates.map((t) => (
              <div
                key={t.id}
                className={`bg-white rounded-xl border-2 p-4 cursor-pointer transition-colors ${
                  editing?.id === t.id
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
                onClick={() => startEdit(t)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="font-medium text-slate-800 text-sm truncate">{t.name}</p>
                      {t.type === 'followup' && (
                        <span className="flex-shrink-0 text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full">↩ Follow-up</span>
                      )}
                    </div>
                    {t.subject_template && t.type !== 'followup' && (
                      <p className="text-xs text-slate-400 truncate mt-0.5">
                        Subject: {t.subject_template}
                      </p>
                    )}
                    {t.body_template && (
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">
                        {t.body_template.slice(0, 100)}…
                      </p>
                    )}
                    {/* Placeholder count badge */}
                    {(() => {
                      const count = (t.body_template?.match(/\[[^\]]+\]/g) ?? []).length
                      return count > 0 ? (
                        <span className="inline-block mt-2 text-xs bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-full">
                          {count} AI placeholder{count !== 1 ? 's' : ''}
                        </span>
                      ) : null
                    })()}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id) }}
                    disabled={deletingId === t.id}
                    className="text-slate-300 hover:text-red-400 transition-colors flex-shrink-0 mt-0.5"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Editor ── */}
        {showEditor && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-5">
                <h2 className="font-semibold text-slate-800">
                  {isNew ? 'New Template' : `Editing: ${editing?.name}`}
                </h2>
                <button
                  onClick={cancelEdit}
                  className="text-sm text-slate-400 hover:text-slate-600"
                >
                  ✕ Cancel
                </button>
              </div>

              <div className="space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Template Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Speaker Invite, Personal Career Outreach, Investor Intro"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                {/* Type */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Template Type</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, type: 'initial' }))}
                      className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition-colors ${form.type === 'initial' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                    >
                      ✉️ Initial outreach
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, type: 'followup' }))}
                      className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition-colors ${form.type === 'followup' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                    >
                      ↩ Follow-up
                    </button>
                  </div>
                  {form.type === 'followup' && (
                    <p className="text-xs text-slate-500 mt-1.5 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                      Sent as a reply inside your original email thread. The AI sees your first email to each
                      contact, so you can reference it. The subject is set automatically to <code className="bg-white px-1 rounded">Re: …</code>.
                    </p>
                  )}
                </div>

                {/* Subject */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Subject Line Template <span className="text-slate-400 font-normal">
                      {form.type === 'followup' ? '(ignored — follow-ups reuse the original "Re:" subject)' : '(optional — AI writes one if blank)'}
                    </span>
                  </label>
                  <input
                    value={form.subject_template}
                    onChange={(e) => setForm((f) => ({ ...f, subject_template: e.target.value }))}
                    placeholder="e.g. Speaking at Founders Illinois — [their company or topic]"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                {/* Placeholder helpers */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-xs font-medium text-slate-600">Insert AI Placeholder</label>
                    <span className="text-xs text-slate-400">— click to insert at cursor position</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(form.type === 'followup' ? [...FOLLOWUP_PLACEHOLDER_HELPERS, ...PLACEHOLDER_HELPERS] : PLACEHOLDER_HELPERS).map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => insertPlaceholder(p.value)}
                        className="text-xs px-2.5 py-1.5 rounded-full border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition-colors font-medium"
                      >
                        + {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Body */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-600">Email Body *</label>
                    {placeholders.length > 0 && (
                      <span className="text-xs text-indigo-600 font-medium">
                        {placeholders.length} placeholder{placeholders.length !== 1 ? 's' : ''} detected
                      </span>
                    )}
                  </div>
                  <RichTextEditor
                    ref={editorRef}
                    value={form.body_template}
                    onChange={(v) => setForm((f) => ({ ...f, body_template: v }))}
                    rows={16}
                    textareaClassName="font-mono"
                    placeholder={`Hi [recipient first name],\n\n[open with something specific and compelling about them]\n\nI'm reaching out because [mention why this person is a fit for your goal].\n\n[highlight my most relevant accomplishment for this person]\n\nWould you be open to a 20-minute call to explore this further?\n\nSincerely,\nZuyu Liu\nChemical Engineer, UIUC\nPresident @ Founders: Illinois Entrepreneurs\n[LinkedIn](https://www.linkedin.com/in/zuyu-liu-58b2b2241/)`}
                  />
                  <p className="text-xs text-slate-400 mt-1.5">
                    Use the toolbar (or <code className="bg-slate-100 px-1 rounded">**bold**</code>, <code className="bg-slate-100 px-1 rounded">*italic*</code>) to format, and <code className="bg-slate-100 px-1 rounded">[bracket instructions]</code> wherever AI should fill in personalized content. Hit <strong>Preview</strong> to see exactly how it sends.
                  </p>
                </div>

                {/* Placeholder preview */}
                {placeholders.length > 0 && (
                  <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-3">
                    <p className="text-xs font-medium text-indigo-700 mb-1.5">AI will fill these placeholders:</p>
                    <div className="space-y-1">
                      {placeholders.map((p, i) => (
                        <p key={i} className="text-xs text-indigo-600 font-mono">
                          {i + 1}. {p}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {error && (
                  <p className="text-sm text-red-500">⚠ {error}</p>
                )}

                <div className="flex items-center justify-between pt-1">
                  <p className="text-xs text-slate-400">
                    {form.body_template.split(/\s+/).filter(Boolean).length} words
                  </p>
                  <button
                    onClick={save}
                    disabled={saving}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
                  >
                    {saving ? 'Saving…' : saved ? (
                      <>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Saved
                      </>
                    ) : 'Save Template'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
