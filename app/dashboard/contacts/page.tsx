'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import AddContactModal from '@/components/contacts/AddContactModal'
import AddToCampaignButton from '@/components/contacts/AddToCampaignButton'
import { formatRelativeTime, STATUS_COLORS, CATEGORY_COLORS, relevanceLabel, relevanceColor } from '@/lib/utils'
import type { Contact } from '@/types'

const STATUS_ORDER = ['new', 'researching', 'researched', 'drafted', 'sent', 'replied', 'meeting', 'archived']
const CATEGORIES = ['speaker', 'mentor', 'recruiter', 'investor', 'peer', 'partner']
const SORT_OPTIONS = [
  { value: 'added_desc', label: 'Newest first' },
  { value: 'added_asc', label: 'Oldest first' },
  { value: 'relevance_desc', label: 'Relevance: High → Low' },
  { value: 'relevance_asc', label: 'Relevance: Low → High' },
  { value: 'name_asc', label: 'Name: A → Z' },
]

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [userId, setUserId] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [relevanceFilter, setRelevanceFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<string>('added_desc')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [researchingAll, setResearchingAll] = useState(false)
  const [researchQueued, setResearchQueued] = useState<number | null>(null)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUserId(user.id)
      const { data } = await supabase
        .from('contacts')
        .select('*, research:contact_research(*)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      const loaded = (data as Contact[]) ?? []
      setContacts(loaded)
      setLoading(false)
      const unresearched = loaded.filter((c) => c.status === 'new')
      if (unresearched.length > 0) {
        fetch('/api/research/batch', { method: 'POST' }).catch(() => {})
      }
    }
    load()
  }, [])

  async function handleResearchAll() {
    setResearchingAll(true); setResearchQueued(null)
    try {
      const res = await fetch('/api/research/batch', { method: 'POST' })
      const data = await res.json()
      setResearchQueued(data.queued ?? 0)
      setTimeout(async () => {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        const { data: fresh } = await supabase
          .from('contacts').select('*, research:contact_research(*)')
          .eq('user_id', user.id).order('created_at', { ascending: false })
        setContacts((fresh as Contact[]) ?? [])
      }, 3000)
    } finally {
      setResearchingAll(false)
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete ${name}? This also removes all their emails and research.`)) return
    setDeletingId(id)
    await fetch(`/api/contacts/${id}`, { method: 'DELETE' })
    setContacts((prev) => prev.filter((c) => c.id !== id))
    setDeletingId(null)
  }

  function getRelevanceTier(c: Contact): string {
    const score = c.research?.relevance_score
    if (score == null) return 'none'
    if (score >= 0.85) return 'high'
    if (score >= 0.6) return 'medium'
    return 'low'
  }

  const filtered = contacts
    .filter((c) => {
      if (search && !c.name.toLowerCase().includes(search.toLowerCase()) &&
          !c.company?.toLowerCase().includes(search.toLowerCase()) &&
          !c.role?.toLowerCase().includes(search.toLowerCase())) return false
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (categoryFilter !== 'all' && c.research?.category !== categoryFilter) return false
      if (relevanceFilter !== 'all' && getRelevanceTier(c) !== relevanceFilter) return false
      return true
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'added_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        case 'relevance_desc':
          return (b.research?.relevance_score ?? -1) - (a.research?.relevance_score ?? -1)
        case 'relevance_asc':
          return (a.research?.relevance_score ?? 2) - (b.research?.relevance_score ?? 2)
        case 'name_asc':
          return a.name.localeCompare(b.name)
        default: // added_desc
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }
    })

  const unresearchedCount = contacts.filter((c) => c.status === 'new').length
  const activeFilters = [statusFilter, categoryFilter, relevanceFilter].filter(f => f !== 'all').length

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-slate-400 text-sm">Loading contacts...</div>
      </div>
    )
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Contacts</h1>
          <p className="text-slate-500 text-sm mt-1">
            {filtered.length !== contacts.length
              ? `${filtered.length} of ${contacts.length} contacts`
              : `${contacts.length} people in your pipeline`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {unresearchedCount > 0 && (
            <button onClick={handleResearchAll} disabled={researchingAll}
              className="flex items-center gap-2 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors disabled:opacity-50">
              {researchingAll ? (
                <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Queuing...</>
              ) : (
                <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>Research {unresearchedCount} unresearched</>
              )}
            </button>
          )}
          {researchQueued !== null && (
            <span className="text-xs text-green-600 font-medium">
              {researchQueued > 0 ? `Queued ${researchQueued}` : 'All caught up!'}
            </span>
          )}
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Contact
          </button>
        </div>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-2 mb-4">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, company, role..."
            className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>

        {/* Category filter */}
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
          className={`px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 ${categoryFilter !== 'all' ? 'border-indigo-400 text-indigo-700 bg-indigo-50' : 'border-slate-200'}`}>
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
          ))}
        </select>

        {/* Relevance filter */}
        <select value={relevanceFilter} onChange={(e) => setRelevanceFilter(e.target.value)}
          className={`px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 ${relevanceFilter !== 'all' ? 'border-indigo-400 text-indigo-700 bg-indigo-50' : 'border-slate-200'}`}>
          <option value="all">All relevance</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="none">Not researched</option>
        </select>

        {/* Status filter */}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className={`px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 ${statusFilter !== 'all' ? 'border-indigo-400 text-indigo-700 bg-indigo-50' : 'border-slate-200'}`}>
          <option value="all">All statuses</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>

        {/* Sort */}
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Clear filters */}
        {(activeFilters > 0 || search) && (
          <button
            onClick={() => { setSearch(''); setStatusFilter('all'); setCategoryFilter('all'); setRelevanceFilter('all') }}
            className="px-3 py-2 text-sm text-slate-400 hover:text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
            Clear {activeFilters > 0 ? `(${activeFilters})` : ''}
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-12 text-center">
          <div className="text-3xl mb-3">👥</div>
          <p className="font-medium text-slate-700 mb-1">
            {contacts.length === 0 ? 'No contacts yet' : 'No contacts match your filters'}
          </p>
          {contacts.length === 0 ? (
            <>
              <p className="text-slate-400 text-sm mb-4">Add founders, operators, mentors, or investors you want to reach.</p>
              <button onClick={() => setShowModal(true)}
                className="bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors">
                Add first contact
              </button>
            </>
          ) : (
            <button onClick={() => { setSearch(''); setStatusFilter('all'); setCategoryFilter('all'); setRelevanceFilter('all') }}
              className="text-sm text-indigo-600 hover:text-indigo-700 font-medium mt-2">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Person</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Category</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Relevance</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Added</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map((contact) => (
                <tr key={contact.id} className="hover:bg-slate-50 transition-colors group">
                  <td className="px-6 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-indigo-600 font-semibold text-xs">{contact.name.charAt(0).toUpperCase()}</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-slate-800">{contact.name}</p>
                          {!contact.email && (
                            <span className="text-xs bg-amber-50 text-amber-600 border border-amber-200 px-1.5 py-0.5 rounded font-medium">No email</span>
                          )}
                        </div>
                        <p className="text-slate-400 text-xs">
                          {[contact.role, contact.company].filter(Boolean).join(' @ ') || '—'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    {contact.research?.category ? (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[contact.research.category] ?? 'bg-gray-100 text-gray-600'}`}>
                        {contact.research.category}
                      </span>
                    ) : <span className="text-xs text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[contact.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {contact.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    {contact.research?.relevance_score != null ? (
                      <span className={`text-sm font-medium ${relevanceColor(contact.research.relevance_score)}`}>
                        {relevanceLabel(contact.research.relevance_score)}
                      </span>
                    ) : <span className="text-xs text-slate-300">Not researched</span>}
                  </td>
                  <td className="px-4 py-3.5 text-xs text-slate-400">{formatRelativeTime(contact.created_at)}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Link href={`/dashboard/contacts/${contact.id}`}
                        className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                        Open →
                      </Link>
                      <AddToCampaignButton contactId={contact.id} contactName={contact.name} variant="icon" />
                      <button onClick={() => handleDelete(contact.id, contact.name)}
                        disabled={deletingId === contact.id}
                        className="text-xs text-slate-300 hover:text-red-400 transition-colors disabled:opacity-50"
                        title="Delete contact">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
      