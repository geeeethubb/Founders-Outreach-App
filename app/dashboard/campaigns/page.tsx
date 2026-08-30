'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { Campaign } from '@/types'
import { formatRelativeTime } from '@/lib/utils'

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [creating, setCreating] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('campaigns')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      setCampaigns(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  async function createCampaign(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data } = await supabase
      .from('campaigns')
      .insert({ user_id: user.id, name: name.trim(), goal: goal.trim() || null })
      .select()
      .single()

    if (data) {
      setCampaigns((c) => [data, ...c])
      setName('')
      setGoal('')
      setShowCreate(false)
    }
    setCreating(false)
  }

  const statusColors = {
    active: 'bg-green-100 text-green-700',
    paused: 'bg-amber-100 text-amber-700',
    completed: 'bg-slate-100 text-slate-600',
  }

  if (loading) {
    return <div className="p-8 text-slate-400 text-sm">Loading campaigns…</div>
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Campaigns</h1>
          <p className="text-slate-500 text-sm mt-1">
            Group your outreach by goal — speaker series, mentor drives, job pipelines
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Campaign
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
          <h3 className="font-semibold text-slate-800 mb-4">Create Campaign</h3>

          <form onSubmit={createCampaign} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Campaign Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Industrial AI internships — winter 2026"
                required
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Goal</label>
              <input
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="What are you trying to accomplish?"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setShowCreate(false)}
                className="px-4 py-2 border border-slate-200 text-slate-600 text-sm rounded-lg hover:bg-slate-50">
                Cancel
              </button>
              <button type="submit" disabled={creating}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                {creating ? 'Creating…' : 'Create Campaign'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Campaign list */}
      {campaigns.length === 0 ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-12 text-center">
          <div className="text-3xl mb-3">🎯</div>
          <p className="font-medium text-slate-700 mb-1">No campaigns yet</p>
          <p className="text-slate-400 text-sm">
            Create a campaign to group your outreach by goal — speaker series, mentor drives, job pipelines.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <Link
              key={campaign.id}
              href={`/dashboard/campaigns/${campaign.id}`}
              className="block bg-white rounded-xl border border-slate-200 p-5 hover:border-indigo-200 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="font-semibold text-slate-800">{campaign.name}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[campaign.status]}`}>
                      {campaign.status}
                    </span>
                  </div>
                  {campaign.goal && (
                    <p className="text-sm text-slate-500">{campaign.goal}</p>
                  )}
                </div>
                <p className="text-xs text-slate-400 flex-shrink-0 ml-4">
                  {formatRelativeTime(campaign.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-4 mt-3 pt-3 border-t border-slate-50">
                <span className="text-xs text-slate-400">
                  {campaign.total_contacts} contacts
                </span>
                <div className="flex gap-2 ml-auto">
                  <button
                    onClick={async (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!confirm(`Delete "${campaign.name}"? This cannot be undone.`)) return
                      await supabase.from('campaigns').delete().eq('id', campaign.id)
                      setCampaigns((c) => c.filter((x) => x.id !== campaign.id))
                    }}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
