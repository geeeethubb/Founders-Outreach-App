'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

// Drives reply-sync from the Conversations page: runs once on mount so the list
// feels live, and again on demand. Surfaces "reconnect Gmail" errors inline.
export default function SyncButton() {
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)
  const ran = useRef(false)

  async function sync() {
    setSyncing(true)
    setMessage(null)
    setIsError(false)
    try {
      const res = await fetch('/api/conversations/sync', { method: 'POST' })
      const data = (await res.json()) as {
        newReplies?: number
        threadsResolved?: number
        sentEmails?: number
        error?: string
        errors?: string[]
      }
      if (!res.ok) {
        setIsError(true)
        setMessage(data.error ?? 'Sync failed')
        return
      }
      let text: string
      if (data.newReplies && data.newReplies > 0) {
        text = `Found ${data.newReplies} new ${data.newReplies === 1 ? 'reply' : 'replies'}`
        router.refresh()
      } else if (!data.sentEmails) {
        text = 'No sent emails to check yet'
      } else if (!data.threadsResolved) {
        // Sent emails exist but none mapped to a Gmail thread — usually a missing
        // read scope or the send predating thread tracking.
        text = `No Gmail threads matched your ${data.sentEmails} sent email${data.sentEmails === 1 ? '' : 's'}`
      } else {
        text = `Up to date · checked ${data.threadsResolved} thread${data.threadsResolved === 1 ? '' : 's'}`
      }
      // Errors from linking replies to Outreach rows — shown, never swallowed.
      if (data.errors && data.errors.length > 0) {
        setIsError(true)
        text = `${text} · ${data.errors.join('; ')}`
      }
      setMessage(text)
    } catch {
      setIsError(true)
      setMessage('Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  // Auto-sync once when the page opens.
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex items-center gap-3">
      {message && (
        <span className={`text-xs ${isError ? 'text-red-600' : 'text-slate-400'}`}>{message}</span>
      )}
      <button
        onClick={sync}
        disabled={syncing}
        className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 transition-colors"
      >
        <svg
          className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {syncing ? 'Syncing…' : 'Sync replies'}
      </button>
    </div>
  )
}
