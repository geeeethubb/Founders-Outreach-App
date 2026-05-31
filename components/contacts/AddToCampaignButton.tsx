'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

interface Props {
  contactId: string
  contactName: string
  /** 'icon' = small icon button for table rows; 'button' = full labelled button for detail page */
  variant?: 'icon' | 'button'
}

interface Campaign {
  id: string
  name: string
  status: string
}

export default function AddToCampaignButton({ contactId, contactName, variant = 'icon' }: Props) {
  const [open, setOpen] = useState(false)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const supabase = createClient()

  useEffect(() => {
    if (!open) return
    async function load() {
      setLoading(true)
      setError('')
      // Load all active campaigns
      const { data: camps } = await supabase
        .from('campaigns')
        .select('id, name, status')
        .order('created_at', { ascending: false })
      setCampaigns((camps as Campaign[]) ?? [])

      // Check which campaigns this contact is already in
      const { data: existing } = await supabase
        .from('campaign_contacts')
        .select('campaign_id')
        .eq('contact_id', contactId)
      const ids = new Set((existing ?? []).map((r: any) => r.campaign_id))
      setAdded(ids)
      setLoading(false)
    }
    load()
  }, [open])

  async function handleAdd(campaignId: string) {
    setSaving(campaignId)
    setError('')
    const { error } = await supabase
      .from('campaign_contacts')
      .insert({ campaign_id: campaignId, contact_id: contactId })
    if (error) {
      setError(error.message)
    } else {
      setAdded((prev) => new Set([...prev, campaignId]))
    }
    setSaving(null)
  }

  async function handleRemove(campaignId: string) {
    setSaving(campaignId)
    await supabase
      .from('campaign_contacts')
      .delete()
      .eq('campaign_id', campaignId)
      .eq('contact_id', contactId)
    setAdded((prev) => { const s = new Set(prev); s.delete(campaignId); return s })
    setSaving(null)
  }

  const trigger = variant === 'button' ? (
    <button
      onClick={() => setOpen(true)}
      className="flex items-center gap-2 w-full px-3 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium rounded-lg transition-colors"
    >
      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
      Add to Campaign
    </button>
  ) : (
    <button
      onClick={() => setOpen(true)}
      className="text-xs text-slate-300 hover:text-indigo-500 transition-colors"
      title="Add to campaign"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    </button>
  )

  return (
    <>
      {trigger}

      {open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div>
                <h2 className="font-semibold text-slate-900 text-sm">Add to Campaign</h2>
                <p className="text-xs text-slate-400 mt-0.5">{contactName}</p>
              </div>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-5 py-3 max-h-80 overflow-y-auto">
              {loading ? (
                <p className="text-sm text-slate-400 text-center py-6">Loading campaigns…</p>
              ) : campaigns.length === 0 ? (
                <div className="text-center py-6">
                  <p className="text-sm text-slate-500 mb-1">No campaigns yet</p>
                  <p className="text-xs text-slate-400">Create a campaign first from the Campaigns page</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {campaigns.map((camp) => {
                    const isIn = added.has(camp.id)
                    const isSaving = saving === camp.id
                    return (
                      <div key={camp.id} className="flex items-center justify-between py-2">
                        <div>
                          <p className="text-sm font-medium text-slate-800">{camp.name}</p>
                          <p className="text-xs text-slate-400 capitalize">{camp.status}</p>
                        </div>
                        <button
                          onClick={() => isIn ? handleRemove(camp.id) : handleAdd(camp.id)}
                          disabled={isSaving}
                          className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                            isIn
                              ? 'bg-red-50 text-red-500 hover:bg-red-100 border border-red-200'
                              : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200'
                          }`}
                        >
                          {isSaving ? '…' : isIn ? 'Remove' : '+ Add'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
            </div>

            <div className="px-5 py-3 border-t border-slate-100">
              <button onClick={() => setOpen(false)}
                className="w-full py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
