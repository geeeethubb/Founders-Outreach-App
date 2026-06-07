'use client'

import { useEffect, useState } from 'react'

export default function GmailConnection() {
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  async function loadStatus() {
    try {
      const res = await fetch('/api/google/status')
      const data = await res.json()
      setConnected(!!data.connected)
      setEmail(data.email ?? null)
    } catch {
      // leave as disconnected on error
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Surface the OAuth redirect result (?gmail=connected|error), then clean the URL.
    const params = new URLSearchParams(window.location.search)
    const g = params.get('gmail')
    if (g === 'connected') {
      setBanner({ type: 'success', text: 'Gmail connected — you can now send from your own address.' })
    } else if (g === 'error') {
      const reason = params.get('reason')
      setBanner({ type: 'error', text: `Couldn't connect Gmail${reason ? `: ${reason}` : ''}.` })
    }
    if (g) {
      params.delete('gmail')
      params.delete('reason')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
    loadStatus()
  }, [])

  async function disconnect() {
    if (!confirm("Disconnect this Gmail account? You won't be able to send until you reconnect.")) return
    setWorking(true)
    try {
      await fetch('/api/google/disconnect', { method: 'POST' })
      setConnected(false)
      setEmail(null)
      setBanner({ type: 'success', text: 'Gmail disconnected.' })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
      <div>
        <h3 className="font-medium text-slate-800 text-sm">Email Sending</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Connect your Gmail so outreach goes out from your own address. We only request permission to
          <span className="font-medium"> send</span> mail — never to read your inbox.
        </p>
      </div>

      {banner && (
        <div
          className={`text-sm px-3 py-2 rounded-lg border ${
            banner.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {banner.text}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Checking connection…</p>
      ) : connected ? (
        <div className="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-green-600 text-lg leading-none">✓</span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">Connected</p>
              <p className="text-xs text-slate-500 truncate">{email}</p>
            </div>
          </div>
          <button
            onClick={disconnect}
            disabled={working}
            className="text-xs font-medium text-slate-500 hover:text-red-600 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            {working ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <a
          href="/api/google/connect"
          className="inline-flex items-center gap-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Connect Gmail
        </a>
      )}
    </div>
  )
}
