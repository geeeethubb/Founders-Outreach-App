'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { Campaign, Contact } from '@/types'
import { STATUS_COLORS, formatRelativeTime } from '@/lib/utils'

interface CampaignContact {
  campaign_id: string
  contact_id: string
  added_at: string
  contact: Contact
}

export default function CampaignDetailPage() {
  const params = useParams()
  const router = useRouter()
  const campaignId = params.id as string
  const supabase = createClient()

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [members, setMembers] = useState<CampaignContact[]>([])
  const [allContacts, setAllContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    const [{ data: camp }, { data: mems }, { data: contacts }] = await Promise.all([
      supabase.from('campaigns').select('*').eq('id', campaignId).single(),
      supabase
        .from('campaign_contacts')
        .select('campaign_id, contact_id, added_at, contact:contacts(*, research:contact_research(*))')
        .eq('campaign_id', campaignId)
        .order('added_at', { ascending: false }),
      supabase
        .from('contacts')
        .select('*, research:contact_research(*)')
        .eq('user_id', user.id)
        .order('name'),
    ])

    setCampaign(camp)
    setMembers((mems ?? []) as unknown as CampaignContact[])
    setAllContacts((contacts ?? []) as Contact[])
    setLoading(false)
  }, [campaignId])

  useEffect(() => { load() }, [load])

  const memberIds = new Set(members.map((m) => m.contact_id))
  const available = allContacts.filter((c) => !memberIds.has(c.id))
  const filtered = available.filter((c) =>
    search === '' ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.company ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (c.role ?? '').toLowerCase().includes(search.toLowerCase())
  )

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function addContacts() {
    if (selected.size === 0) return
    setAdding(true)
    const rows = Array.from(selected).map((contact_id) => ({
      campaign_id: campaignId,
      contact_id,
    }))
    await supabase.from('campaign_contacts').insert(rows)
    await supabase
      .from('campaigns')
      .update({ total_contacts: (campaign?.total_contacts ?? 0) + selected.size })
      .eq('id', campaignId)
    setSelected(new Set())
    setSearch('')
    setShowAddModal(false)
    await load()
    setAdding(false)
  }

  async function removeContact(contactId: string) {
    setRemoving(contactId)
    await supabase
      .from('campaign_contacts')
      .delete()
      .eq('campaign_id', campaignId)
      .eq('contact_id', contactId)
    await supabase
      .from('campaigns')
      .update({ total_contacts: Math.max(0, (campaign?.total_contacts ?? 1) - 1) })
      .eq('id', campaignId)
    setMembers((prev) => prev.filter((m) => m.contact_id !== contactId))
    setCampaign((prev) => prev ? { ...prev, total_contacts: Math.max(0, prev.total_contacts - 1) } : prev)
    setRemoving(null)
  }

  const statusColors = {
    active: 'bg-green-100 text-green-700',
    paused: 'bg-amber-100 text-amber-700',
    completed: 'bg-slate-100 text-slate-600',
  }

  if (loading) {
    return <div className="p-8 text-slate-400 text-sm">Loading…</div>
  }

  if (!campaign) {
    return <div className="p-8 text-slate-500 text-sm">Campaign not found.</div>
  }

  return (
    <div className="p-8 max-w-5xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-slate-400 mb-6">
        <Link href="/dashboard/campaigns" className="hover:text-slate-600 transition-colors">
          Campaigns
        </Link>
        <span>/</span>
        <span className="text-slate-700 font-medium">{campaign.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold text-slate-900">{campaign.name}</h1>
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColors[campaign.status]}`}>
              {campaign.status}
            </span>
          </div>
          {campaign.goal && (
            <p className="text-slate-500 text-sm mt-1">{campaign.goal}</p>
          )}
          <p className="text-xs text-slate-400 mt-1">
            {members.length} contact{members.length !== 1 ? 's' : ''} · Created {formatRelativeTime(campaign.created_at)}
          </p>
        </div>
        <button
          onClick={() => { setShowAddModal(true); setSelected(new Set()); setSearch('') }}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Contacts
        </button>
      </div>

      {/* Contact list */}
      {members.length === 0 ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-12 text-center">
          <div className="text-3xl mb-3">👥</div>
          <p className="font-medium text-slate-700 mb-1">No contacts yet</p>
          <p className="text-slate-400 text-sm mb-4">
            Add contacts from your list to start tracking outreach for this campaign.
          </p>
          <button
            onClick={() => { setShowAddModal(true); setSelected(new Set()); setSearch('') }}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            + Add Contacts
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Contact</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Added</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((member) => (
                <tr key={member.contact_id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-indigo-600 font-semibold text-xs">
                          {member.contact.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <Link
                          href={`/dashboard/contacts/${member.contact_id}`}
                          className="font-medium text-slate-800 hover:text-indigo-600 transition-colors"
                        >
                          {member.contact.name}
                        </Link>
                        <p className="text-xs text-slate-400">
                          {[member.contact.role, member.contact.company].filter(Boolean).join(' @ ') || '—'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[member.contact.status] ?? ''}`}>
                      {member.contact.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-400">
                    {formatRelativeTime(member.added_at)}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center gap-3 justify-end">
                      <Link
                        href={`/dashboard/compose?contact=${member.contact_id}`}
                        className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                      >
                        Compose
                      </Link>
                      <button
                        onClick={() => removeContact(member.contact_id)}
                        disabled={removing === member.contact_id}
                        className="text-xs text-slate-400 hover:text-red-500 disabled:opacity-40 transition-colors"
                      >
                        {removing === member.contact_id ? '…' : 'Remove'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Contacts Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowAddModal(false)}
          />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h2 className="font-semibold text-slate-900">Add Contacts</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {available.length} contact{available.length !== 1 ? 's' : ''} available to add
                </p>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-3 border-b border-slate-100">
              <input
                autoFocus
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, company, or role…"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">
                  {available.length === 0
                    ? 'All your contacts are already in this campaign.'
                    : 'No contacts match your search.'}
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {filtered.map((contact) => (
                    <label
                      key={contact.id}
                      className="flex items-center gap-3 px-6 py-3 hover:bg-slate-50 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(contact.id)}
                        onChange={() => toggleSelect(contact.id)}
                        className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300"
                      />
                      <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-indigo-600 font-semibold text-xs">
                          {contact.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-800 text-sm truncate">{contact.name}</p>
                        <p className="text-xs text-slate-400 truncate">
                          {[contact.role, contact.company].filter(Boolean).join(' @ ') || contact.email || '—'}
                        </p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${STATUS_COLORS[contact.status] ?? ''}`}>
                        {contact.status}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
              <span className="text-sm text-slate-500">
                {selected.size > 0 ? `${selected.size} selected` : 'Select contacts to add'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 text-sm rounded-lg hover:bg-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={addContacts}
                  disabled={selected.size === 0 || adding}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {adding ? 'Adding…' : `Add ${selected.size > 0 ? selected.size : ''} Contact${selected.size !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
                                                                                                                                                                                                              