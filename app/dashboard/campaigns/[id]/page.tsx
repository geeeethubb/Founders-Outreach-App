'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { Campaign, Contact, GenerateRequest, EmailStyle } from '@/types'
import { STATUS_COLORS, formatRelativeTime } from '@/lib/utils'
import { EMAIL_STYLES } from '@/types'

const GOAL_OPTIONS = [
  { value: 'speaker',         label: '🎤 Speaker / Event',      desc: 'Invite them to speak at an Illinois Entrepreneurs event' },
  { value: 'mentor',          label: '🧭 Mentor / Advisor',     desc: 'Ask them to mentor a UIUC student founder' },
  { value: 'jobs',            label: '💼 Internship / Jobs',    desc: 'Connect our top students with their team' },
  { value: 'investor_intro',  label: '💰 Investor Intro',       desc: 'Intro for a student-led startup' },
  { value: 'personal_career', label: '🙋 Personal Opportunity', desc: 'Internships, mentorship, or opportunities for yourself' },
] as const

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

  // Generate panel
  const [genGoal, setGenGoal] = useState<GenerateRequest['outreach_goal']>('jobs')
  const [genStyles, setGenStyles] = useState<EmailStyle[]>([])
  const [genNote, setGenNote] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genResult, setGenResult] = useState<{ generated: number; skipped: { name: string; reason: string }[] } | null>(null)
  const [genError, setGenError] = useState('')

  function toggleGenStyle(s: EmailStyle) {
    setGenStyles((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])
  }

  async function generateCampaignEmails() {
    setGenerating(true)
    setGenResult(null)
    setGenError('')
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outreach_goal: genGoal, styles: genStyles, custom_note: genNote || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setGenResult(data)
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

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

      {/* Generate Emails Panel */}
      <div className="mt-6 bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-8 h-8 bg-violet-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Generate Campaign Emails</h3>
            <p className="text-xs text-slate-500">AI drafts a personalized email for every contact in this campaign</p>
          </div>
        </div>

        {/* Goal */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Goal</label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {GOAL_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  genGoal === opt.value
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="gen-goal"
                  value={opt.value}
                  checked={genGoal === opt.value}
                  onChange={() => setGenGoal(opt.value as GenerateRequest['outreach_goal'])}
                  className="mt-0.5 text-indigo-600"
                />
                <div>
                  <p className="text-sm font-medium text-slate-800">{opt.label}</p>
                  <p className="text-xs text-slate-500">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Style tags */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Style <span className="font-normal text-slate-400">(optional — pick any)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {EMAIL_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleGenStyle(s.id)}
                className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
                  genStyles.includes(s.id)
                    ? 'bg-indigo-600 border-indigo-600 text-white'
                    : 'border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600'
                }`}
              >
                {s.emoji} {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom note */}
        <div className="mb-5">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Context for AI <span className="font-normal text-slate-400">(optional)</span>
       