'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { RichTextEditor } from '@/components/editor/RichTextEditor'
import { formatRelativeTime } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  open:             'bg-blue-100 text-blue-700',
  meeting_booked:   'bg-emerald-100 text-emerald-700',
  closed_positive:  'bg-green-100 text-green-700',
  closed_negative:  'bg-gray-100 text-gray-500',
  ghosted:          'bg-amber-100 text-amber-600',
}

interface Turn {
  id: string
  direction: 'inbound' | 'outbound'
  fromName: string
  subject: string
  date: string | null
  body: string
}

interface Conv {
  id: string
  status: string
  outcome: string | null
  meeting_at: string | null
  contact: { name: string; email: string | null; company: string | null; role: string | null }
}

export default function ConversationDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const supabase = createClient()

  const [conv, setConv] = useState<Conv | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(true)
  const [threadWarning, setThreadWarning] = useState<string | null>(null)

  // Reply composer
  const [instruction, setInstruction] = useState('')
  const [draft, setDraft] = useState('')
  const [strategy, setStrategy] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRan = useRef(false)

  const loadConv = useCallback(async () => {
    const { data } = await supabase
      .from('conversations')
      .select('id, status, outcome, meeting_at, contact:contacts(name, email, company, role)')
      .eq('id', id)
      .maybeSingle()
    setConv(data as unknown as Conv)
  }, [id])

  const loadThread = useCallback(async () => {
    const res = await fetch(`/api/conversations/${id}/thread`)
    const data = await res.json()
    if (res.ok) {
      setTurns(data.turns ?? [])
      setThreadWarning(data.warning ?? null)
    } else {
      setThreadWarning(data.error ?? 'Could not load the email thread.')
    }
  }, [id])

  useEffect(() => {
    if (threadRan.current) return
    threadRan.current = true
    Promise.all([loadConv(), loadThread()]).finally(() => setLoading(false))
  }, [loadConv, loadThread])

  async function suggest() {
    setSuggesting(true)
    setError(null)
    setStrategy('')
    try {
      const res = await fetch(`/api/conversations/${id}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: instruction || undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not generate a reply.')
        return
      }
      setDraft(data.body ?? '')
      setStrategy(data.strategy ?? '')
    } catch {
      setError('Could not generate a reply.')
    } finally {
      setSuggesting(false)
    }
  }

  async function send() {
    if (!draft.trim()) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: draft }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not send the reply.')
        return
      }
      setDraft('')
      setStrategy('')
      setInstruction('')
      await Promise.all([loadConv(), loadThread()])
      router.refresh()
    } catch {
      setError('Could not send the reply.')
    } finally {
      setSending(false)
    }
  }

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading…</div>
  if (!conv) return <div className="p-8 text-slate-500 text-sm">Conversation not found.</div>

  const c = conv.contact

  return (
    <div className="p-8 max-w-3xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-slate-400 mb-6">
        <Link href="/dashboard/conversations" className="hover:text-slate-600 transition-colors">Conversations</Link>
        <span>/</span>
        <span className="text-slate-700 font-medium">{c?.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <span className="text-indigo-600 font-semibold">{c?.name?.charAt(0).toUpperCase() ?? '?'}</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-900">{c?.name}</h1>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[conv.status] ?? 'bg-gray-100 text-gray-600'}`}>
                {conv.status?.replace('_', ' ')}
              </span>
            </div>
            <p className="text-sm text-slate-400">
              {[c?.role, c?.company].filter(Boolean).join(' @ ') || c?.email}
            </p>
            {conv.meeting_at && (
              <p className="text-xs text-emerald-600 font-medium mt-0.5">
                Meeting: {new Date(conv.meeting_at).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>

      {threadWarning && (
        <div className="mb-4 text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700">
          {threadWarning}
        </div>
      )}

      {/* Thread */}
      <div className="space-y-3 mb-6">
        {turns.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-8 border border-dashed border-slate-200 rounded-xl">
            No messages to show.
          </div>
        ) : (
          turns.map((t) => (
            <div
              key={t.id}
              className={`rounded-xl border p-4 ${
                t.direction === 'outbound'
                  ? 'bg-indigo-50/50 border-indigo-100 ml-8'
                  : 'bg-white border-slate-200 mr-8'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-slate-600">
                  {t.direction === 'outbound' ? 'You' : (t.fromName || c?.name)}
                </span>
                {t.date && <span className="text-xs text-slate-400">{formatRelativeTime(t.date)}</span>}
              </div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{t.body}</p>
            </div>
          ))
        )}
      </div>

      {/* AI reply composer */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 bg-violet-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h3 className="font-semibold text-slate-800 text-sm">Suggested reply</h3>
        </div>

        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Optional steer — e.g. 'propose Tue/Wed 3pm CT' or 'keep it short and warm'"
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onClick={suggest}
            disabled={suggesting}
            className="inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
          >
            {suggesting ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Thinking…
              </>
            ) : (
              draft ? 'Regenerate' : 'Suggest reply'
            )}
          </button>
        </div>

        {strategy && (
          <p className="text-xs text-violet-700 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2 mb-3">
            💡 {strategy}
          </p>
        )}

        {error && (
          <div className="text-sm px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 mb-3">
            {error}
          </div>
        )}

        <RichTextEditor
          value={draft}
          onChange={setDraft}
          rows={8}
          placeholder="Your reply will appear here — edit it freely before sending."
        />

        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-slate-400">
            Sends from your Gmail, threaded into this conversation. Your signature is added by Gmail.
          </p>
          <button
            onClick={send}
            disabled={sending || !draft.trim()}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
          >
            {sending ? 'Sending…' : 'Send reply'}
          </button>
        </div>
      </div>
    </div>
  )
}
