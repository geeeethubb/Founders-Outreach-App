'use client'

// The campaign's reference email.
//
// Self-contained on purpose: app/dashboard/campaigns/[id]/page.tsx is 962 lines
// and CLAUDE.md says not to add to it. This mounts with one line there.
//
// The panel shows what the system LEARNED from the pasted email, not just that
// it stored it. A style analysis the founder cannot read is an invisible prompt,
// and invisible prompts are what this whole feature replaces.

import { useCallback, useEffect, useState } from 'react'

interface ReferenceStyle {
  register: string
  directness: string
  context_depth: string
  credential_style: string
  cta_style: string
  sentence_style: string
  structure: string[]
  distinctive_moves: string[]
  avoid: string[]
  recipient_specific: string[]
  summary: string
  measured: { words: number; paragraphs: number; sentences: number; avgSentenceWords: number }
  target_words: { min: number; max: number }
}

interface CampaignReference {
  campaignId: string
  campaignName: string
  subject: string | null
  body: string | null
  notes: string | null
  targetAudience: string | null
  style: ReferenceStyle | null
  styleCurrent: boolean
  updatedAt: string | null
}

export default function ReferenceEmailPanel({ campaignId }: { campaignId: string }) {
  const [reference, setReference] = useState<CampaignReference | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [notes, setNotes] = useState('')
  const [audience, setAudience] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/reference`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load the reference email')
      setReference(data.reference)
      setSubject(data.reference?.subject ?? '')
      setBody(data.reference?.body ?? '')
      setNotes(data.reference?.notes ?? '')
      setAudience(data.reference?.targetAudience ?? '')
      setEditing(!data.reference?.body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }, [campaignId])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/reference`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body, notes, targetAudience: audience }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not save')
      setReference(data.reference)
      setEditing(false)
      setNotice(
        data.analysed
          ? `Saved and analysed — $${Number(data.costUsd ?? 0).toFixed(4)}.`
          : 'Saved.'
      )
      if (data.warning) setNotice((n) => `${n} ${data.warning}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!confirm('Remove this campaign’s reference email? New drafts will use the default voice.')) return
    setSaving(true)
    try {
      await fetch(`/api/campaigns/${campaignId}/reference`, { method: 'DELETE' })
      await load()
      setNotice('Reference removed. New drafts will use the default voice.')
    } finally {
      setSaving(false)
    }
  }

  const words = body.trim() ? body.trim().split(/\s+/).filter(Boolean).length : 0

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-slate-900">Reference email</h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Paste one real email that shows how this campaign should sound. Every draft in this
            campaign is written to match it — its length, its warmth, its way of asking. It is an
            example, not a template: no brackets, no variables.
          </p>
        </div>
        {!editing && reference?.body && (
          <button
            onClick={() => setEditing(true)}
            className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 hover:bg-slate-50"
          >
            Replace
          </button>
        )}
      </div>

      {loading && <p className="mt-4 text-sm text-slate-500">Loading…</p>}

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">{error}</div>
      )}
      {notice && !error && (
        <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded p-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {!loading && editing && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600">Subject (optional)</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="The subject line you actually used"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">
              The email <span className="text-slate-400">— paste it exactly as you sent it</span>
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              placeholder={
                'Hi Maya,\n\nI read your piece on why plant-floor pilots stall...\n\n' +
                'Paste the real thing. Keep the recipient-specific details in — the system is told ' +
                'which facts belong to them and must not reuse them.'
              }
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono leading-relaxed"
            />
            <div className="mt-1 text-xs text-slate-500">
              {words} words
              {words > 0 && words < 20 && ' — too short to learn a voice from'}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">Who this campaign is for</label>
              <input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="e.g. seed-stage industrial founders"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Notes (optional)</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="anything about how you want it to land"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || words < 20}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:bg-slate-300"
            >
              {saving ? 'Saving and analysing…' : 'Save reference'}
            </button>
            {reference?.body && (
              <button
                onClick={() => {
                  setEditing(false)
                  setSubject(reference.subject ?? '')
                  setBody(reference.body ?? '')
                }}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {!loading && !editing && reference?.body && (
        <div className="mt-4 space-y-4">
          <div className="bg-slate-50 border border-slate-200 rounded p-3">
            {reference.subject && (
              <div className="text-xs text-slate-500 mb-2">Subject: {reference.subject}</div>
            )}
            <pre className="whitespace-pre-wrap text-sm text-slate-800 font-sans leading-relaxed max-h-72 overflow-auto">
              {reference.body}
            </pre>
          </div>

          {reference.style ? (
            <div className="space-y-3">
              <div className="bg-indigo-50 border border-indigo-100 rounded p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-indigo-500">
                  What the writer learned from this
                </div>
                <p className="mt-1 text-sm text-slate-900">{reference.style.summary}</p>
                <p className="mt-2 text-xs text-slate-600">
                  {reference.style.measured.words} words · {reference.style.measured.paragraphs} paragraph
                  {reference.style.measured.paragraphs === 1 ? '' : 's'} ·{' '}
                  {reference.style.measured.avgSentenceWords} words per sentence → new drafts target{' '}
                  <strong>
                    {reference.style.target_words.min}–{reference.style.target_words.max} words
                  </strong>
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <Trait label="Voice" value={reference.style.register} />
                <Trait label="Directness" value={reference.style.directness} />
                <Trait label="Context before the point" value={reference.style.context_depth} />
                <Trait label="How credentials appear" value={reference.style.credential_style} />
                <Trait label="The ask" value={reference.style.cta_style} />
                <Trait label="Sentences" value={reference.style.sentence_style} />
              </div>

              {reference.style.structure.length > 0 && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Structure new drafts will follow
                  </div>
                  <ol className="mt-1 text-sm text-slate-700 list-decimal list-inside space-y-0.5">
                    {reference.style.structure.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              )}

              {reference.style.recipient_specific.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-amber-700">
                    Facts belonging to this email’s own recipient — never reused
                  </div>
                  <ul className="mt-1 text-sm text-amber-900 space-y-0.5">
                    {reference.style.recipient_specific.map((s, i) => (
                      <li key={i}>· {s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">
              Stored, but not analysed yet. The next draft in this campaign will analyse it.
            </p>
          )}

          <button onClick={remove} disabled={saving} className="text-xs text-red-600 hover:underline">
            Remove reference
          </button>
        </div>
      )}
    </div>
  )
}

function Trait({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-slate-700">{value}</div>
    </div>
  )
}
