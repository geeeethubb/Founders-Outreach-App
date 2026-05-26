'use client'

import { useState } from 'react'
import type { Contact } from '@/types'
import { CATEGORY_COLORS, relevanceLabel, relevanceColor } from '@/lib/utils'

interface Props {
  contact: Contact
}

export default function ResearchCard({ contact }: Props) {
  const [loading, setLoading] = useState(false)
  const [pastedBio, setPastedBio] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [error, setError] = useState('')
  const research = contact.research

  async function runResearch() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contact.id,
          name: contact.name,
          company: contact.company,
          role: contact.role,
          linkedin_url: contact.linkedin_url,
          pasted_bio: pastedBio || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      // Refresh the contact data
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Research failed')
    } finally {
      setLoading(false)
    }
  }

  if (!research) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.346.346a5 5 0 01-7.072 0l-.346-.346z" />
            </svg>
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">AI Research</h3>
            <p className="text-xs text-slate-500">Not researched yet</p>
          </div>
        </div>

        <p className="text-sm text-slate-600 mb-4">
          Run AI research to get a summary, talking points, and shared context with your club — so your email feels like it came from someone who actually knows their work.
        </p>

        {showPaste && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Paste LinkedIn bio / About section (optional but improves quality)
            </label>
            <textarea
              value={pastedBio}
              onChange={(e) => setPastedBio(e.target.value)}
              placeholder="Paste their LinkedIn About section, bio, or any relevant text here…"
              rows={5}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg mb-3">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={runResearch}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
          >
            {loading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Researching (30–60s)…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Run AI Research
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowPaste(!showPaste)}
            className="px-3 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors"
            title="Paste LinkedIn text"
          >
            📋
          </button>
        </div>
      </div>
    )
  }

  // Research exists — show the results
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Research Complete</h3>
            <p className="text-xs text-slate-400">
              {research.category && (
                <span className={`inline-block mr-2 px-2 py-0.5 rounded-full text-xs font-medium ${CATEGORY_COLORS[research.category] ?? ''}`}>
                  {research.category}
                </span>
              )}
              {research.relevance_score != null && (
                <span className={`font-medium ${relevanceColor(research.relevance_score)}`}>
                  {relevanceLabel(research.relevance_score)} relevance
                </span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => { setPastedBio(''); runResearch() }}
          disabled={loading}
          className="text-xs text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
        >
          {loading ? 'Re-researching…' : '↻ Re-research'}
        </button>
      </div>

      {/* Summary */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Summary</p>
        <p className="text-sm text-slate-700 leading-relaxed">{research.summary}</p>
      </div>

      {/* Hooks */}
      {research.hooks && research.hooks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Talking Points
          </p>
          <ul className="space-y-1.5">
            {research.hooks.map((hook, i) => (
              <li key={i} className="flex gap-2 text-sm text-slate-700">
                <span className="text-indigo-400 flex-shrink-0 mt-0.5">•</span>
                <span>{hook}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Shared context */}
      {research.shared_context && research.shared_context.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Shared Context w/ Illinois
          </p>
          <ul className="space-y-1.5">
            {research.shared_context.map((ctx, i) => (
              <li key={i} className="flex gap-2 text-sm text-slate-700">
                <span className="text-emerald-400 flex-shrink-0 mt-0.5">◉</span>
                <span>{ctx}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Suggested ask */}
      {research.suggested_ask && (
        <div className="bg-indigo-50 rounded-lg px-4 py-3">
          <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-1">
            Suggested Ask
          </p>
          <p className="text-sm text-indigo-800">{research.suggested_ask}</p>
        </div>
      )}
    </div>
  )
}
