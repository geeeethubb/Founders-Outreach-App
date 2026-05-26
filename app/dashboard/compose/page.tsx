'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Contact, EmailVariant, EmailStyle } from '@/types'
import { EMAIL_STYLES } from '@/types'

const GOAL_OPTIONS = [
  { value: 'speaker',        label: '🎤 Speaker / Event',      desc: 'Invite them to speak at an Illinois Entrepreneurs event' },
  { value: 'mentor',         label: '🧭 Mentor / Advisor',     desc: 'Ask them to mentor a UIUC student founder' },
  { value: 'jobs',           label: '💼 Internship / Jobs',    desc: 'Connect our top students with their team' },
  { value: 'investor_intro', label: '💰 Investor Intro',       desc: 'Intro for a student-led startup' },
  { value: 'personal_career', label: '🙋 Personal Opportunity', desc: 'Internships, mentorship, or opportunities for yourself' },
] as const

type Goal = typeof GOAL_OPTIONS[number]['value']

export default function ComposePage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const preselectedContactId = searchParams.get('contact')

  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContactId, setSelectedContactId] = useState(preselectedContactId ?? '')
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [goal, setGoal] = useState<Goal>('speaker')
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

  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data } = await supabase
        .from('contacts')
        .select('*, research:contact_research(*)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })

      setContacts((data as Contact[]) ?? [])

      if (preselectedContactId) {
        const c = (data as Contact[])?.find((c) => c.id === preselectedContactId)
        if (c) setSelectedContact(c)
      }
    }
    load()
  }, [])

  useEffect(() => {
    const c = contacts.find((c) => c.id === selectedContactId)
    setSelectedContact(c ?? null)
    setVariants([])
    setStep('setup')
  }, [selectedContactId, contacts])

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

  async function generate() {
    if (!selectedContactId) return
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: selectedContactId,
          outreach_goal: goal,
          styles: selectedStyles,
          custom_note: customNote || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setVariants(data.variants)
      setSelectedVariant(0)
      setStep('variants')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  async function send() {
    if (!selectedContact || !variants[selectedVariant]) return
    if (!selectedContact.email) {
      setError("This contact doesn't have an email address yet. Add it on their profile page.")
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
      setSendSuccess(true)
      setStep('send')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  const wordCount = editedBody.split(/\s+/).filter(Boolean).length

  if (sendSuccess) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4">🚀</div>
          <h2 className="text-2xl font-semibold text-slate-900 mb-2">Email Sent!</h2>
          <p className="text-slate-500 mb-6">
            Your outreach to <strong>{selectedContact?.name}</strong> is on its way.
            You'll be notified when they open or reply.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => { setSendSuccess(false); setStep('setup'); setVariants([]); setSelectedContactId('') }}
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
        <h1 className="text-2xl font-semibold text-slate-900">Compose Outreach</h1>
        <p className="text-slate-500 text-sm mt-1">
          AI-powered, personalized emails for your Illinois Entrepreneurs outreach
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {['Setup', 'AI Variants', 'Review & Send'].map((label, i) => {
          const steps = ['setup', 'variants', 'send']
          const current = steps.indexOf(step)
          return (
            <div key={label} className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i < current ? 'bg-indigo-600 text-white' :
                i === current ? 'bg-indigo-600 text-white' :
                'bg-slate-200 text-slate-500'
              }`}>
                {i < current ? '✓' : i + 1}
              </div>
              <span className={`text-sm ${i === current ? 'font-medium text-slate-800' : 'text-slate-400'}`}>
                {label}
              </span>
              {i < 2 && <div className="w-8 h-px bg-slate-200 mx-1" />}
            </div>
          )
        })}
      </div>

      {/* ── Step 1: Setup ── */}
      {step === 'setup' && (
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-5">

            {/* Contact selector */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <label className="block text-sm font-medium text-slate-700 mb-3">
                Who are you reaching out to?
              </label>
              <select
                value={selectedContactId}
                onChange={(e) => setSelectedContactId(e.target.value)}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              >
                <option value="">Select a contact…</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.company ? ` — ${c.company}` : ''}{!c.research ? ' (not researched)' : ''}
                  </option>
                ))}
              </select>
              {selectedContact && !selectedContact.research && (
                <p className="text-xs text-amber-600 mt-2">
                  ⚠️ Not researched yet — email will be less personalized.{' '}
                  <a href={`/dashboard/contacts/${selectedContact.id}`} className="underline">Research first →</a>
                </p>
              )}
            </div>

            {/* Goal selector */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <label className="block text-sm font-medium text-slate-700 mb-3">
                What's the goal?
              </label>
              <div className="space-y-2">
                {GOAL_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                      goal === opt.value ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio" name="goal" value={opt.value}
                      checked={goal === opt.value}
                      onChange={() => setGoal(opt.value)}
                      className="mt-0.5 accent-indigo-600"
                    />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{opt.label}</p>
                      <p className="text-xs text-slate-500">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* ── Style tags ── */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-slate-700">
                  Writing Style
                </label>
                {selectedStyles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedStyles([])}
                    className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-400 mb-3">
                Pick any combination — the AI applies all selected styles at once
              </p>
              <div className="flex flex-wrap gap-2">
                {EMAIL_STYLES.map((style) => {
                  const active = selectedStyles.includes(style.id)
                  return (
                    <button
                      key={style.id}
                      type="button"
                      onClick={() => toggleStyle(style.id)}
                      title={style.description}
                      className={`group relative flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border-2 transition-all ${
                        active
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm'
                          : 'border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600'
                      }`}
                    >
                      <span>{style.emoji}</span>
                      <span>{style.label}</span>
                      {active && (
                        <span className="ml-0.5 text-indigo-400">✓</span>
                      )}
                    </button>
                  )
                })}
              </div>
              {selectedStyles.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <p className="text-xs text-slate-500 font-medium mb-1">Active styles:</p>
                  <div className="space-y-1">
                    {selectedStyles.map((id) => {
                      const s = EMAIL_STYLES.find((e) => e.id === id)!
                      return (
                        <p key={id} className="text-xs text-slate-500">
                          {s.emoji} <strong>{s.label}:</strong> {s.description}
                        </p>
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
                placeholder="E.g., 'We're hosting a speaker event Feb 15th', 'The student founder is working on a fintech startup'…"
                rows={3}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            <button
              onClick={generate}
              disabled={!selectedContactId || generating}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium py-3 rounded-xl transition-colors"
            >
              {generating ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Generating {selectedStyles.length > 0 ? `(${selectedStyles.length} style${selectedStyles.length > 1 ? 's' : ''} applied)` : '3 variants'}…
                </>
              ) : (
                <>
                  ✨ Generate AI Email Variants
                  {selectedStyles.length > 0 && (
                    <span className="ml-1 text-indigo-200 text-xs">
                      · {selectedStyles.map((s) => EMAIL_STYLES.find((e) => e.id === s)?.emoji).join('')}
                    </span>
                  )}
                </>
              )}
            </button>
          </div>

          {/* Right: Contact preview */}
          {selectedContact && (
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">Contact Preview</p>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
                  <span className="text-indigo-600 font-bold">{selectedContact.name.charAt(0)}</span>
                </div>
                <div>
                  <p className="font-semibold text-slate-800">{selectedContact.name}</p>
                  <p className="text-slate-500 text-xs">
                    {[selectedContact.role, selectedContact.company].filter(Boolean).join(' @ ')}
                  </p>
                </div>
              </div>
              {selectedContact.research ? (
                <div className="space-y-3">
                  {selectedContact.research.summary && (
                    <p className="text-sm text-slate-600 leading-relaxed">{selectedContact.research.summary}</p>
                  )}
                  {selectedContact.research.hooks && selectedContact.research.hooks.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-500 mb-1">Top talking points:</p>
                      <ul className="space-y-1">
                        {selectedContact.research.hooks.slice(0, 3).map((h, i) => (
                          <li key={i} className="text-xs text-slate-600 flex gap-2">
                            <span className="text-indigo-400">•</span> {h}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-4">
                  <p className="text-sm text-slate-400 mb-2">No research yet</p>
                  <a href={`/dashboard/contacts/${selectedContact.id}`}
                    className="text-xs text-indigo-600 hover:text-indigo-700">
                    Run AI research first for better results →
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Variants ── */}
      {step === 'variants' && variants.length > 0 && (
        <div className="space-y-5">
          {/* Active styles badge */}
          {selectedStyles.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">Styles applied:</span>
              {selectedStyles.map((id) => {
                const s = EMAIL_STYLES.find((e) => e.id === id)!
                return (
                  <span key={id} className="inline-flex items-center gap-1 text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full font-medium">
                    {s.emoji} {s.label}
                  </span>
                )
              })}
              <button
                onClick={() => { setStep('setup'); setVariants([]) }}
                className="ml-auto text-xs text-slate-400 hover:text-slate-600"
              >
                ← Back
              </button>
            </div>
          )}

          {/* Variant tabs */}
          <div className="flex gap-2">
            {variants.map((v, i) => (
              <button
                key={v.label}
                onClick={() => setSelectedVariant(i)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border-2 transition-colors ${
                  selectedVariant === i
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                <span className="font-bold">Variant {v.label}</span>
                <span className="text-xs opacity-70 hidden sm:block">
                  {v.hook_type === 'accomplishment' ? '🏆' : v.hook_type === 'shared_context' ? '🤝' : '💡'}
                  {' '}{v.hook_type.replace('_', ' ')}
                </span>
              </button>
            ))}
            {selectedStyles.length === 0 && (
              <button
                onClick={() => { setStep('setup'); setVariants([]) }}
                className="ml-auto text-sm text-slate-400 hover:text-slate-600 px-3"
              >
                ← Back
              </button>
            )}
          </div>

          {/* Hook info */}
          {variants[selectedVariant] && (
            <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-2 text-sm text-blue-700">
              <strong>Hook used:</strong> {variants[selectedVariant].hook_used}
            </div>
          )}

          {/* Editable email */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <label className="block text-xs font-medium text-slate-500 mb-1">Subject</label>
              <input
                value={editedSubject}
                onChange={(e) => setEditedSubject(e.target.value)}
                className="w-full text-sm font-medium text-slate-800 focus:outline-none"
              />
            </div>
            <div className="p-5">
              <label className="block text-xs font-medium text-slate-500 mb-2">Body</label>
              <textarea
                value={editedBody}
                onChange={(e) => setEditedBody(e.target.value)}
                rows={12}
                className="w-full text-sm text-slate-700 leading-relaxed focus:outline-none resize-none"
              />
              <div className={`text-right text-xs mt-2 ${wordCount > 150 ? 'text-red-500' : 'text-slate-400'}`}>
                {wordCount} words {wordCount > 150 && '— aim for under 150'}
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
          )}

          <div className="flex gap-3">
            <button
              onClick={generate}
              disabled={generating}
              className="px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              {generating ? 'Regenerating…' : '↻ Regenerate'}
            </button>
            <button
              onClick={send}
              disabled={sending || !selectedContact?.email}
              className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              {sending ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Sending…
                </>
              ) : !selectedContact?.email ? (
                '⚠️ Add email address to send'
              ) : (
                `Send to ${selectedContact?.name} →`
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
