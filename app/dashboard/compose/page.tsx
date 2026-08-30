'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { RichTextEditor } from '@/components/editor/RichTextEditor'
import type { Contact, EmailVariant, EmailStyle, Template } from '@/types'
import { EMAIL_STYLES } from '@/types'
import { formatRelativeTime } from '@/lib/utils'

interface EmailedInfo { count: number; lastSentAt: string }

const GOAL_OPTIONS = [
  { value: 'personal_career', label: '🙋 Personal Opportunity', desc: 'Internships, mentorship, or opportunities for yourself' },
  { value: 'mentor',         label: '🧭 Mentor / Advisor',     desc: 'Ask them to mentor a UIUC student founder' },
  { value: 'jobs',           label: '💼 Internship / Jobs',    desc: 'Connect our top students with their team' },
  { value: 'investor_intro', label: '💰 Investor Intro',       desc: 'Intro for a student-led startup' },
] as const

type Goal = typeof GOAL_OPTIONS[number]['value']
type Mode = 'template' | 'fresh'

export default function ComposePage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-slate-500">Loading compose...</div>}>
      <ComposeContent />
    </Suspense>
  )
}

function ComposeContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const preselectedContactId = searchParams.get('contact')

  const [contacts, setContacts] = useState<Contact[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [emailedMap, setEmailedMap] = useState<Map<string, EmailedInfo>>(new Map())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    preselectedContactId ? new Set([preselectedContactId]) : new Set()
  )
  const [contactSearch, setContactSearch] = useState('')
  const [goal, setGoal] = useState<Goal>('personal_career')
  const [mode, setMode] = useState<Mode>('template')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')

  // single-contact helpers
  const selectedContactId = selectedIds.size === 1 ? [...selectedIds][0] : ''
  const selectedContact = contacts.find((c) => c.id === selectedContactId) ?? null

  const [selectedStyles, setSelectedStyles] = useState<EmailStyle[]>([])
  const [customNote, setCustomNote] = useState('')
  const [variants, setVariants] = useState<(EmailVariant & { email_id: string })[]>([])
  const [selectedVariant, setSelectedVariant] = useState(0)
  const [editedSubject, setEditedSubject] = useState('')
  const [editedBody, setEditedBody] = useState('')
  const [step, setStep] = useState<'setup' | 'variants' | 'send'>('setup')
  const [generating, setGenerating] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sendSuccess, setSendSuccess] = useState(false)
  const [sentContactName, setSentContactName] = useState('')

  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const [{ data: contactData }, { data: templateData }, { data: sentData }] = await Promise.all([
        supabase.from('contacts').select('*, research:contact_research(*)').eq('user_id', user.id).order('name'),
        supabase.from('templates').select('*').eq('user_id', user.id).eq('is_active', true).order('created_at', { ascending: false }),
        supabase.from('emails').select('contact_id, sent_at').eq('user_id', user.id).eq('status', 'sent'),
      ])
      setContacts((contactData as Contact[]) ?? [])
      setTemplates((templateData as Template[]) ?? [])
      if (templateData && templateData.length > 0) {
        setSelectedTemplateId(templateData[0].id)
      }

      // Tally who's already been emailed (and most recent send) to flag redundancy
      // in the picker and gate follow-up templates.
      const map = new Map<string, EmailedInfo>()
      for (const row of (sentData as { contact_id: string; sent_at: string | null }[]) ?? []) {
        if (!row.contact_id) continue
        const existing = map.get(row.contact_id)
        const sentAt = row.sent_at ?? ''
        if (existing) {
          existing.count += 1
          if (sentAt > existing.lastSentAt) existing.lastSentAt = sentAt
        } else {
          map.set(row.contact_id, { count: 1, lastSentAt: sentAt })
        }
      }
      setEmailedMap(map)
    }
    load()
  }, [])

  useEffect(() => {
    if (variants[selectedVariant]) {
      setEditedSubject(variants[selectedVariant].subject)
      setEditedBody(variants[selectedVariant].body)
    }
  }, [selectedVariant, variants])

  function toggleStyle(style: EmailStyle) {
    setSelectedStyles((prev) =>
      prev.includes(style) ? prev.filter((s) => s !== style) : [...prev, style]
    )
  }

  // Generating persists every variant as a draft row. Only one is ever sent, so
  // the others are removed here rather than left to pile up in Draft Emails —
  // where Approve All would send them to the same person. Only status='draft'
  // rows from this compose session are touched.
  async function discardDraftRows(ids: string[]) {
    if (ids.length === 0) return
    await supabase.from('emails').delete().in('id', ids).eq('status', 'draft')
  }

  function toggleContact(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
    setVariants([])
    setStep('setup')
  }

  async function generate() {
    if (selectedIds.size === 0) return
    if (mode === 'template' && !selectedTemplateId) {
      setError('Please select a template first, or switch to Generate Fresh mode.')
      return
    }
    // Follow-up templates require a prior sent email for every selected contact.
    const tmpl = templates.find((t) => t.id === selectedTemplateId)
    if (mode === 'template' && tmpl?.type === 'followup') {
      const blockers = [...selectedIds].filter((id) => !emailedMap.has(id))
      if (blockers.length > 0) {
        const names = blockers.map((id) => contacts.find((c) => c.id === id)?.name ?? '?').join(', ')
        setError(`Follow-ups reply to a previous email. These contacts haven't been emailed yet — send an initial email first: ${names}.`)
        return
      }
    }
    setGenerating(true)
    setError('')
    try {
      // A regenerate replaces the previous variants. Their rows are dropped only
      // after the new ones arrive, so a failed call leaves the old drafts usable.
      const previousIds = variants.map((v) => v.email_id)
      if (selectedIds.size === 1) {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contact_id: selectedContactId,
            outreach_goal: goal,
            styles: mode === 'fresh' ? selectedStyles : undefined,
            custom_note: customNote || undefined,
            template_id: mode === 'template' ? selectedTemplateId : undefined,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        setVariants(data.variants)
        setSelectedVariant(0)
        setStep('variants')
        await discardDraftRows(previousIds)
      } else {
        const res = await fetch('/api/generate-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contact_ids: [...selectedIds],
            outreach_goal: goal,
            styles: mode === 'fresh' ? selectedStyles : undefined,
            custom_note: customNote || undefined,
            template_id: mode === 'template' ? selectedTemplateId : undefined,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        await discardDraftRows(previousIds)
        router.push(`/dashboard/drafts?generated=${data.generated}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  async function send() {
    if (!selectedContact || !variants[selectedVariant]) return
    if (!selectedContact.email) {
      setError("This contact doesn't have an email address. Add it on their profile page.")
      return
    }
    setSending(true)
    setError('')
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_id: variants[selectedVariant].email_id,
          to_email: selectedContact.email,
          to_name: selectedContact.name,
          subject: editedSubject,
          body: editedBody,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      // The sent variant is now status='sent'; the unsent ones are orphans.
      await discardDraftRows(
        variants.filter((_, i) => i !== selectedVariant).map((v) => v.email_id)
      )
      setSentContactName(selectedContact.name)
      setSendSuccess(true)
      setStep('send')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  const wordCount = editedBody.split(/\s+/).filter(Boolean).length
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId)

  // Follow-up templates thread onto a prior email — selected contacts who haven't
  // been emailed yet can't be followed up.
  const isFollowupMode = mode === 'template' && selectedTemplate?.type === 'followup'
  const followupBlockers = isFollowupMode
    ? [...selectedIds].filter((id) => !emailedMap.has(id))
    : []
  const followupBlocked = isFollowupMode && followupBlockers.length > 0

  if (sendSuccess) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4">🚀</div>
          <h2 className="text-2xl font-semibold text-slate-900 mb-2">Email Sent!</h2>
          <p className="text-slate-500 mb-6">
            Your outreach to <strong>{sentContactName}</strong> is on its way.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => { setSendSuccess(false); setStep('setup'); setVariants([]); setSelectedIds(new Set()) }}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Send Another
            </button>
            <button
              onClick={() => router.push('/dashboard/contacts')}
              className="px-4 py-2 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors"
            >
              Back to Contacts
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Compose</h1>
        <p className="text-slate-500 text-sm mt-1">AI-powered, personalized emails for your outreach</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {['Setup', mode === 'template' ? 'Preview & Edit' : 'AI Variants', 'Review & Send'].map((label, i) => {
          const steps = ['setup', 'variants', 'send']
          const current = steps.indexOf(step)
          return (
            <div key={label} className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i <= current ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'
              }`}>
                {i < current ? '✓' : i + 1}
              </div>
              <span className={`text-sm ${i === current ? 'font-medium text-slate-800' : 'text-slate-400'}`}>{label}</span>
              {i < 2 && <div className="w-8 h-px bg-slate-200 mx-1" />}
            </div>
          )
        })}
      </div>

      {/* ── Step 1: Setup ── */}
      {step === 'setup' && (
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-5">

            {/* Contact checklist */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-slate-700">Who are you reaching out to?</label>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                      {selectedIds.size} selected
                    </span>
                    <button onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-400 hover:text-slate-600">Clear</button>
                  </div>
                )}
              </div>
              <input
                type="text"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder="Search contacts…"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-2"
              />
              <div className="max-h-52 overflow-y-auto divide-y divide-slate-50 border border-slate-100 rounded-lg">
                {contacts
                  .filter((c) => contactSearch === '' || c.name.toLowerCase().includes(contactSearch.toLowerCase()) || (c.company ?? '').toLowerCase().includes(contactSearch.toLowerCase()))
                  .map((c) => (
                    <label key={c.id} className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors ${selectedIds.has(c.id) ? 'bg-indigo-50' : ''}`}>
                      <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleContact(c.id)} className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{c.name}</p>
                        <p className="text-xs text-slate-400 truncate">{[c.role, c.company].filter(Boolean).join(' @ ') || '—'}</p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {!c.research && <span className="text-xs text-amber-500">no research</span>}
                        {(() => {
                          const e = emailedMap.get(c.id)
                          return e ? (
                            <span
                              title={`Emailed ${e.count} time${e.count !== 1 ? 's' : ''}${e.lastSentAt ? ` · last ${formatRelativeTime(e.lastSentAt)}` : ''}`}
                              className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full whitespace-nowrap"
                            >
                              ✓ emailed{e.count > 1 ? ` ${e.count}×` : ''}{e.lastSentAt ? ` · ${formatRelativeTime(e.lastSentAt)}` : ''}
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-400">new</span>
                          )
                        })()}
                      </div>
                    </label>
                  ))}
                {contacts.length === 0 && <p className="px-3 py-4 text-sm text-slate-400 text-center">No contacts yet</p>}
              </div>
              {selectedIds.size > 1 && (
                <p className="text-xs text-indigo-600 mt-2">✦ {selectedIds.size} contacts — drafts will be saved to Draft Emails</p>
              )}
            </div>

            {/* Goal selector */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <label className="block text-sm font-medium text-slate-700 mb-3">What's the goal?</label>
              <div className="space-y-2">
                {GOAL_OPTIONS.map((opt) => (
                  <label key={opt.value} className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${goal === opt.value ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <input type="radio" name="goal" value={opt.value} checked={goal === opt.value} onChange={() => setGoal(opt.value)} className="mt-0.5 accent-indigo-600" />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{opt.label}</p>
                      <p className="text-xs text-slate-500">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* ── Mode toggle ── */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <label className="block text-sm font-medium text-slate-700 mb-3">How should the AI write this?</label>
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setMode('template')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${mode === 'template' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                >
                  🎨 Use My Template
                </button>
                <button
                  onClick={() => setMode('fresh')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${mode === 'fresh' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                >
                  ✨ Generate Fresh
                </button>
              </div>

              {/* Template picker */}
              {mode === 'template' && (
                <div>
                  {templates.length === 0 ? (
                    <div className="text-center py-3 border border-dashed border-slate-200 rounded-lg">
                      <p className="text-sm text-slate-400 mb-1">No templates yet</p>
                      <a href="/dashboard/templates" className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                        Create your first template →
                      </a>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {templates.map((t) => (
                        <label key={t.id} className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${selectedTemplateId === t.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'}`}>
                          <input type="radio" name="template" value={t.id} checked={selectedTemplateId === t.id} onChange={() => setSelectedTemplateId(t.id)} className="mt-0.5 accent-indigo-600" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-medium text-slate-800">{t.name}</p>
                              {t.type === 'followup' && (
                                <span className="text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full">↩ Follow-up</span>
                              )}
                            </div>
                            {t.subject_template && t.type !== 'followup' && <p className="text-xs text-slate-400 truncate">Subject: {t.subject_template}</p>}
                            {(() => {
                              const count = (t.body_template?.match(/\[[^\]]+\]/g) ?? []).length
                              return count > 0 ? (
                                <span className="text-xs text-indigo-500">{count} AI placeholder{count !== 1 ? 's' : ''}</span>
                              ) : null
                            })()}
                          </div>
                        </label>
                      ))}
                      <a href="/dashboard/templates" className="block text-xs text-center text-slate-400 hover:text-indigo-600 mt-1 transition-colors">
                        + Manage templates
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Style tags for fresh mode */}
              {mode === 'fresh' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-slate-500">Pick any combination of writing styles</p>
                    {selectedStyles.length > 0 && (
                      <button type="button" onClick={() => setSelectedStyles([])} className="text-xs text-slate-400 hover:text-slate-600">Clear all</button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {EMAIL_STYLES.map((style) => {
                      const active = selectedStyles.includes(style.id)
                      return (
                        <button key={style.id} type="button" onClick={() => toggleStyle(style.id)} title={style.description}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border-2 transition-all ${active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
                          <span>{style.emoji}</span>
                          <span>{style.label}</span>
                          {active && <span className="ml-0.5 text-indigo-400">✓</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Custom note */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Additional context <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
                placeholder="Anything extra the AI should know for this outreach…"
                rows={3}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
            </div>

            {isFollowupMode && !followupBlocked && selectedIds.size > 0 && (
              <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-lg">
                ↩ This will be sent as a reply inside your existing email thread with {selectedIds.size === 1 ? selectedContact?.name ?? 'this contact' : `these ${selectedIds.size} contacts`}.
              </div>
            )}
            {followupBlocked && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
                Follow-ups reply to a previous email, but {followupBlockers.length} selected contact{followupBlockers.length !== 1 ? 's haven\'t' : " hasn't"} been emailed yet. Send an initial email first, or deselect them.
              </div>
            )}

            {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>}

            <button
              onClick={generate}
              disabled={selectedIds.size === 0 || generating || (mode === 'template' && !selectedTemplateId) || followupBlocked}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium py-3 rounded-xl transition-colors"
            >
              {generating ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {mode === 'template' ? 'Filling template…' : 'Generating variants…'}
                </>
              ) : mode === 'template' ? (
                <>🎨 Fill Template for {selectedIds.size > 0 ? `${selectedIds.size} contact${selectedIds.size > 1 ? 's' : ''}` : '…'}</>
              ) : (
                <>✨ Generate AI Email Variants</>
              )}
            </button>
          </div>

          {/* Right: Contact or template preview */}
          <div className="space-y-4">
            {selectedContact && (
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">Contact Preview</p>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
                    <span className="text-indigo-600 font-bold">{selectedContact.name.charAt(0)}</span>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800">{selectedContact.name}</p>
                    <p className="text-slate-500 text-xs">{[selectedContact.role, selectedContact.company].filter(Boolean).join(' @ ')}</p>
                  </div>
                </div>
                {selectedContact.research ? (
                  <div className="space-y-2">
                    {selectedContact.research.summary && <p className="text-sm text-slate-600 leading-relaxed">{selectedContact.research.summary}</p>}
                    {selectedContact.research.hooks && selectedContact.research.hooks.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1">Top talking points:</p>
                        <ul className="space-y-1">
                          {selectedContact.research.hooks.slice(0, 3).map((h, i) => (
                            <li key={i} className="text-xs text-slate-600 flex gap-2"><span className="text-indigo-400">•</span> {h}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">No research yet — <a href={`/dashboard/contacts/${selectedContact.id}`} className="text-indigo-600 underline">run research first</a></p>
                )}
              </div>
            )}

            {mode === 'template' && selectedTemplate && (
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Template Preview</p>
                <p className="font-medium text-slate-800 text-sm mb-2">{selectedTemplate.name}</p>
                {selectedTemplate.subject_template && (
                  <p className="text-xs text-slate-500 mb-2">Subject: {selectedTemplate.subject_template}</p>
                )}
                <pre className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap font-sans bg-slate-50 rounded-lg p-3 max-h-48 overflow-y-auto">
                  {selectedTemplate.body_template}
                </pre>
                <div className="mt-2">
                  {(selectedTemplate.body_template?.match(/\[[^\]]+\]/g) ?? []).map((p, i) => (
                    <span key={i} className="inline-block text-xs bg-indigo-50 text-indigo-600 border border-indigo-200 px-1.5 py-0.5 rounded mr-1 mb-1 font-mono">{p}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Step 2: Variants / Preview ── */}
      {step === 'variants' && variants.length > 0 && (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            {mode === 'template' ? (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <span className="bg-indigo-100 text-indigo-700 text-xs font-medium px-2.5 py-1 rounded-full">🎨 {selectedTemplate?.name}</span>
                <span className="text-slate-400 text-xs">filled for {selectedContact?.name}</span>
              </div>
            ) : (
              <div className="flex gap-2">
                {variants.map((v, i) => (
                  <button key={v.label} onClick={() => setSelectedVariant(i)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border-2 transition-colors ${selectedVariant === i ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                    <span className="font-bold">Variant {v.label}</span>
                    <span className="text-xs opacity-70 hidden sm:block">
                      {v.hook_type === 'accomplishment' ? '🏆' : v.hook_type === 'shared_context' ? '🤝' : '💡'} {v.hook_type.replace('_', ' ')}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => { void discardDraftRows(variants.map((v) => v.email_id)); setStep('setup'); setVariants([]) }}
              className="ml-auto text-sm text-slate-400 hover:text-slate-600"
            >
              ← Back
            </button>
          </div>

          {mode === 'fresh' && variants[selectedVariant] && (
            <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-2 text-sm text-blue-700">
              <strong>Hook used:</strong> {variants[selectedVariant].hook_used}
            </div>
          )}

          {/* Editable email */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <label className="block text-xs font-medium text-slate-500 mb-1">Subject</label>
              <input value={editedSubject} onChange={(e) => setEditedSubject(e.target.value)} className="w-full text-sm font-medium text-slate-800 focus:outline-none" />
            </div>
            <div className="p-5">
              <label className="block text-xs font-medium text-slate-500 mb-2">Body</label>
              <RichTextEditor
                value={editedBody}
                onChange={setEditedBody}
                rows={14}
              />
              <div className={`text-right text-xs mt-2 ${wordCount > 180 ? 'text-red-500' : 'text-slate-400'}`}>
                {wordCount} words {wordCount > 180 && '— consider trimming'}
              </div>
            </div>
          </div>

          {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>}

          <div className="flex gap-3">
            <button onClick={generate} disabled={generating}
              className="px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
              {generating ? 'Regenerating…' : '↻ Regenerate'}
            </button>
            <button onClick={send} disabled={sending || !selectedContact?.email}
              className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors">
              {sending ? (
                <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Sending…</>
              ) : !selectedContact?.email ? '⚠️ Add email to send' : `Send to ${selectedContact?.name} →`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
