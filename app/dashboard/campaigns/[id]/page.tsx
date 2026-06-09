'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { Campaign, Contact, GenerateRequest, EmailStyle, Template } from '@/types'
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

// Engagement buckets derived from send history + contact status, used to filter
// the member list so you can bulk-keep/remove contacts before the next push.
type Engagement = 'new' | 'emailed' | 'followed_up' | 'responded'
type MemberFilter = 'all' | Engagement

const MEMBER_FILTERS: { key: MemberFilter; label: string }[] = [
  { key: 'all',          label: 'All' },
  { key: 'new',          label: 'Not emailed' },
  { key: 'emailed',      label: 'Emailed once' },
  { key: 'followed_up',  label: 'Followed up' },
  { key: 'responded',    label: 'Responded' },
]

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
  const [genMode, setGenMode] = useState<'template' | 'fresh'>('template')
  const [genTemplateId, setGenTemplateId] = useState<string>('')
  const [templates, setTemplates] = useState<Template[]>([])
  const [emailedMap, setEmailedMap] = useState<Map<string, { count: number; lastSentAt: string }>>(new Map())

  // Member-list filtering + bulk selection (distinct from the Add-Contacts modal)
  const [memberFilter, setMemberFilter] = useState<MemberFilter>('all')
  const [memberSelected, setMemberSelected] = useState<Set<string>>(new Set())
  const [bulkRemoving, setBulkRemoving] = useState(false)
  const generatePanelRef = useRef<HTMLDivElement>(null)

  function toggleGenStyle(s: EmailStyle) {
    setGenStyles((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])
  }

  async function generateCampaignEmails() {
    if (genMode === 'template' && !genTemplateId) {
      setGenError('Please select a template first.')
      return
    }
    setGenerating(true)
    setGenResult(null)
    setGenError('')
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outreach_goal: genGoal,
          styles: genMode === 'fresh' ? genStyles : undefined,
          custom_note: genNote || undefined,
          template_id: genMode === 'template' ? genTemplateId : undefined,
          contact_ids: targetIds ?? undefined,
        }),
      })
      // The server can run for minutes on large campaigns. If it's killed
      // (timeout) or hits a gateway error, the body is an HTML/text error page,
      // not JSON — guard the parse so it surfaces a clear message instead of
      // a cryptic "Unexpected token 'A'…".
      const raw = await res.text()
      let data: { generated?: number; skipped?: { name: string; reason: string }[]; error?: string }
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error(
          res.ok
            ? 'The server returned an unexpected response. Some drafts may have been created — check Drafts.'
            : `Generation failed (HTTP ${res.status}). The request may have timed out; any drafts created so far are in Drafts.`
        )
      }
      if (!res.ok) throw new Error(data.error || `Generation failed (HTTP ${res.status})`)
      setGenResult(data as { generated: number; skipped: { name: string; reason: string }[] })
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    const [{ data: camp }, { data: mems }, { data: contacts }, { data: tmplData }, { data: sentData }] = await Promise.all([
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
      supabase
        .from('templates')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false }),
      supabase.from('emails').select('contact_id, sent_at').eq('user_id', user.id).eq('status', 'sent'),
    ])

    setCampaign(camp)
    setMembers((mems ?? []) as unknown as CampaignContact[])
    setAllContacts((contacts ?? []) as Contact[])
    setTemplates((tmplData as Template[]) ?? [])
    if (tmplData && tmplData.length > 0) setGenTemplateId(tmplData[0].id)

    const map = new Map<string, { count: number; lastSentAt: string }>()
    for (const row of (sentData as { contact_id: string; sent_at: string | null }[]) ?? []) {
      if (!row.contact_id) continue
      const existing = map.get(row.contact_id)
      const sentAt = row.sent_at ?? ''
      if (existing) {
        existing.count += 1
        if (sentAt > existing.lastSentAt) existing.lastSentAt = sentAt
      } else {
        map.set(row.contact_id, { count: 1, lastSentAt: sentAt })
      }
    }
    setEmailedMap(map)
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

  // Which engagement bucket a member falls into. A reply wins over send count.
  function memberEngagement(member: CampaignContact): Engagement {
    const status = member.contact.status
    if (status === 'replied' || status === 'meeting') return 'responded'
    const count = emailedMap.get(member.contact_id)?.count ?? 0
    if (count >= 2) return 'followed_up'
    if (count === 1) return 'emailed'
    return 'new'
  }

  const memberCounts = members.reduce((acc, m) => {
    const e = memberEngagement(m)
    acc[e] = (acc[e] ?? 0) + 1
    return acc
  }, {} as Record<Engagement, number>)

  const filteredMembers =
    memberFilter === 'all' ? members : members.filter((m) => memberEngagement(m) === memberFilter)

  const filteredIds = filteredMembers.map((m) => m.contact_id)
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => memberSelected.has(id))

  // The recipients of the next batch: the selected members, or everyone if none
  // are selected. Selecting never removes anyone — it just scopes generation.
  const targetMembers = memberSelected.size > 0 ? members.filter((m) => memberSelected.has(m.contact_id)) : members
  const targetIds = memberSelected.size > 0 ? Array.from(memberSelected) : null

  function toggleMemberSelect(id: string) {
    setMemberSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelectAllFiltered() {
    setMemberSelected((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) filteredIds.forEach((id) => next.delete(id))
      else filteredIds.forEach((id) => next.add(id))
      return next
    })
  }

  async function removeSelectedMembers() {
    if (memberSelected.size === 0) return
    const n = memberSelected.size
    if (!confirm(`Remove ${n} contact${n !== 1 ? 's' : ''} from this campaign? This doesn't delete the contact.`)) return
    setBulkRemoving(true)
    const ids = Array.from(memberSelected)
    await supabase
      .from('campaign_contacts')
      .delete()
      .eq('campaign_id', campaignId)
      .in('contact_id', ids)
    await supabase
      .from('campaigns')
      .update({ total_contacts: Math.max(0, (campaign?.total_contacts ?? ids.length) - ids.length) })
      .eq('id', campaignId)
    setMembers((prev) => prev.filter((m) => !memberSelected.has(m.contact_id)))
    setCampaign((prev) => (prev ? { ...prev, total_contacts: Math.max(0, prev.total_contacts - ids.length) } : prev))
    setMemberSelected(new Set())
    setBulkRemoving(false)
  }

  // Badge describing a member's outreach state, aligned with the filters above.
  function engagementBadge(member: CampaignContact) {
    const e = memberEngagement(member)
    const info = emailedMap.get(member.contact_id)
    const rel = info?.lastSentAt ? formatRelativeTime(info.lastSentAt) : null
    const base = 'text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap'
    if (e === 'responded') return <span className={`${base} text-green-700 bg-green-50 border border-green-200`}>💬 Responded</span>
    if (e === 'followed_up') return <span className={`${base} text-amber-700 bg-amber-50 border border-amber-200`}>↩ Followed up ({info?.count}×){rel ? ` · ${rel}` : ''}</span>
    if (e === 'emailed') return <span className={`${base} text-emerald-700 bg-emerald-50 border border-emerald-200`}>✓ Emailed once{rel ? ` · ${rel}` : ''}</span>
    return <span className={`${base} text-slate-500 bg-slate-50 border border-slate-200`}>— Not emailed</span>
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
        <>
          {/* Engagement filters */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {MEMBER_FILTERS.map((f) => {
              const count = f.key === 'all' ? members.length : (memberCounts[f.key as Engagement] ?? 0)
              const active = memberFilter === f.key
              return (
                <button
                  key={f.key}
                  onClick={() => setMemberFilter(f.key)}
                  className={`text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${active ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}
                >
                  {f.label}
                  <span className={`ml-1.5 text-xs ${active ? 'text-indigo-100' : 'text-slate-400'}`}>{count}</span>
                </button>
              )
            })}
          </div>

          {/* Bulk actions — selection scopes the next email batch; nobody leaves the campaign unless you explicitly remove them */}
          {memberSelected.size > 0 && (
            <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-2.5 mb-3">
              <span className="text-sm font-medium text-indigo-700">
                {memberSelected.size} selected for this batch
              </span>
              <div className="flex items-center gap-3">
                <button onClick={() => setMemberSelected(new Set())} className="text-xs font-medium text-slate-500 hover:text-slate-700">
                  Clear
                </button>
                <button
                  onClick={removeSelectedMembers}
                  disabled={bulkRemoving}
                  className="text-xs font-medium text-slate-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                >
                  {bulkRemoving ? 'Removing…' : 'Remove from campaign'}
                </button>
                <button
                  onClick={() => generatePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="inline-flex items-center gap-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                >
                  Generate for selected →
                </button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-5 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAllFiltered}
                    aria-label="Select all in view"
                    className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300"
                  />
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Contact</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Outreach</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Added</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredMembers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-400">
                    No contacts in this filter.
                  </td>
                </tr>
              ) : filteredMembers.map((member) => (
                <tr key={member.contact_id} className={`hover:bg-slate-50 transition-colors ${memberSelected.has(member.contact_id) ? 'bg-indigo-50/40' : ''}`}>
                  <td className="px-5 py-3.5">
                    <input
                      type="checkbox"
                      checked={memberSelected.has(member.contact_id)}
                      onChange={() => toggleMemberSelect(member.contact_id)}
                      aria-label={`Select ${member.contact.name}`}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300"
                    />
                  </td>
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
                  <td className="px-5 py-3.5">
                    {engagementBadge(member)}
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
        </>
      )}

      {/* Generate Emails Panel */}
      <div ref={generatePanelRef} className="mt-6 bg-white rounded-xl border border-slate-200 p-6 scroll-mt-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-8 h-8 bg-violet-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h3 className="font-semibold text-slate-800">Generate Campaign Emails</h3>
            <p className="text-xs text-slate-500">
              {memberSelected.size > 0
                ? `AI drafts a personalized email for the ${memberSelected.size} selected contact${memberSelected.size !== 1 ? 's' : ''}`
                : 'AI drafts a personalized email for every contact in this campaign'}
            </p>
          </div>
        </div>

        {memberSelected.size > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 bg-violet-50 border border-violet-200 rounded-lg px-4 py-2.5">
            <p className="text-xs text-violet-700">
              This batch is scoped to <span className="font-semibold">{memberSelected.size} selected</span> of {members.length} — the rest stay in the campaign, untouched.
            </p>
            <button
              onClick={() => setMemberSelected(new Set())}
              className="text-xs font-medium text-violet-600 hover:text-violet-800 whitespace-nowrap"
            >
              Use all instead
            </button>
          </div>
        )}

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

        {/* Mode toggle */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Email Source</label>
          <div className="flex gap-2 mb-3">
            <button onClick={() => setGenMode('template')}
              className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition-colors ${genMode === 'template' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>
              🎨 Use Template
            </button>
            <button onClick={() => setGenMode('fresh')}
              className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition-colors ${genMode === 'fresh' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>
              ✨ Generate Fresh
            </button>
          </div>

          {genMode === 'template' && (
            templates.length === 0 ? (
              <div className="text-center py-3 border border-dashed border-slate-200 rounded-lg">
                <p className="text-sm text-slate-400 mb-1">No templates yet</p>
                <a href="/dashboard/templates" className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">Create a template →</a>
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map((t) => (
                  <label key={t.id} className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${genTemplateId === t.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <input type="radio" name="gen-template" value={t.id} checked={genTemplateId === t.id} onChange={() => setGenTemplateId(t.id)} className="mt-0.5 accent-indigo-600" />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-slate-800">{t.name}</p>
                        {t.type === 'followup' && (
                          <span className="text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full">↩ Follow-up</span>
                        )}
                      </div>
                      {(() => {
                        const count = (t.body_template?.match(/\[[^\]]+\]/g) ?? []).length
                        return count > 0 ? <span className="text-xs text-indigo-500">{count} AI placeholder{count !== 1 ? 's' : ''}</span> : null
                      })()}
                    </div>
                  </label>
                ))}
              </div>
            )
          )}

          {genMode === 'fresh' && (
            <div>
              <p className="text-xs text-slate-400 mb-2">Optional style tags</p>
              <div className="flex flex-wrap gap-2">
                {EMAIL_STYLES.map((s) => (
                  <button key={s.id} type="button" onClick={() => toggleGenStyle(s.id)}
                    className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${genStyles.includes(s.id) ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600'}`}>
                    {s.emoji} {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Custom note */}
        <div className="mb-5">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Context for AI <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            value={genNote}
            onChange={(e) => setGenNote(e.target.value)}
            placeholder="e.g. Event is March 15th, 80 students attending. Looking for founders with AI / B2B SaaS experience."
            rows={2}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />
        </div>

        {/* Error */}
        {genError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg mb-4">
            {genError}
          </div>
        )}

        {/* Success result */}
        {genResult && (
          <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 mb-4">
            <p className="text-sm font-medium text-green-800">
              ✅ {genResult.generated} email{genResult.generated !== 1 ? 's' : ''} drafted
              {genResult.skipped.length > 0 && ` · ${genResult.skipped.length} skipped (no research)`}
            </p>
            {genResult.skipped.length > 0 && (
              <p className="text-xs text-green-700 mt-1">
                Skipped: {genResult.skipped.map((s) => s.name).join(', ')} — run AI Research on their profiles first
              </p>
            )}
            <Link href="/dashboard/drafts" className="text-xs font-semibold text-green-700 underline mt-1 inline-block">
              Review drafts →
            </Link>
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-400">
            {members.length === 0
              ? 'Add contacts to this campaign first'
              : genMode === 'template' && templates.find((t) => t.id === genTemplateId)?.type === 'followup'
              ? (() => {
                  const eligible = targetMembers.filter((m) => emailedMap.has(m.contact_id)).length
                  return `Follow-up · ${eligible} of ${targetMembers.length} ${memberSelected.size > 0 ? 'selected ' : ''}already emailed will get a threaded reply; the rest are skipped`
                })()
              : `Will generate for ${targetMembers.length} ${memberSelected.size > 0 ? 'selected ' : ''}contact${targetMembers.length !== 1 ? 's' : ''} · contacts without research are skipped`}
          </p>
          <button
            onClick={generateCampaignEmails}
            disabled={generating || targetMembers.length === 0}
            className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            {generating ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating ({targetMembers.length})…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {memberSelected.size > 0 ? `Generate for ${targetMembers.length} selected` : 'Generate Emails'}
              </>
            )}
          </button>
        </div>
      </div>

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
                      {emailedMap.has(contact.id) && (
                        <span
                          title={`Already emailed${emailedMap.get(contact.id)!.lastSentAt ? ` · last ${formatRelativeTime(emailedMap.get(contact.id)!.lastSentAt)}` : ''}`}
                          className="text-[11px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 text-emerald-700 bg-emerald-50 border border-emerald-200 whitespace-nowrap"
                        >
                          ✓ emailed
                        </span>
                      )}
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
