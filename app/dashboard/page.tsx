import { createClient } from '@/lib/supabase/server'
import { getDashboardStats, getContacts } from '@/lib/supabase/queries'
import Link from 'next/link'
import { formatRelativeTime, STATUS_COLORS } from '@/lib/utils'
import type { Contact } from '@/types'

export default async function DashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  const [stats, recentContacts] = await Promise.all([
    getDashboardStats(user.id),
    getContacts(user.id).then((c) => c.slice(0, 5)),
  ])

  const statCards = [
    { label: 'Total Contacts', value: stats.total_contacts, color: 'text-slate-900', sub: 'in your pipeline' },
    { label: 'Researched', value: stats.researched, color: 'text-blue-600', sub: 'with AI research' },
    { label: 'Emails Sent', value: stats.emails_sent, color: 'text-indigo-600', sub: 'cold outreach sent' },
    { label: 'Replies', value: stats.replies, color: 'text-green-600', sub: `${stats.reply_rate}% reply rate` },
    { label: 'Meetings', value: stats.meetings, color: 'text-emerald-600', sub: 'booked or completed' },
  ]

  return (
    <div className="p-8 max-w-6xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 text-sm mt-1">
          People, internships, drafts and replies — nothing sends without you.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4 mb-8">
        {statCards.map((card) => (
          <div key={card.label} className="bg-white rounded-xl border border-slate-200 p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
              {card.label}
            </p>
            <p className={`text-3xl font-bold ${card.color} mb-1`}>{card.value}</p>
            <p className="text-xs text-slate-400">{card.sub}</p>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {[
          {
            href: '/dashboard/scout',
            title: 'Scout',
            desc: 'Describe a goal, get ranked people',
            icon: '🔎',
            color: 'border-indigo-200 hover:border-indigo-400',
          },
          {
            href: '/dashboard/jobs',
            title: 'Jobs',
            desc: 'Ranked, verified internship postings',
            icon: '💼',
            color: 'border-purple-200 hover:border-purple-400',
          },
          {
            href: '/dashboard/outreach',
            title: 'Outreach',
            desc: 'Review and send Scout drafts',
            icon: '✉️',
            color: 'border-orange-200 hover:border-orange-400',
          },
          {
            href: '/dashboard/conversations',
            title: 'Conversations',
            desc: 'Answer replies',
            icon: '💬',
            color: 'border-green-200 hover:border-green-400',
          },
        ].map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className={`bg-white rounded-xl border-2 ${action.color} p-5 transition-colors group`}
          >
            <div className="text-2xl mb-3">{action.icon}</div>
            <p className="font-semibold text-slate-800 text-sm group-hover:text-indigo-700 transition-colors">
              {action.title}
            </p>
            <p className="text-slate-400 text-xs mt-1">{action.desc}</p>
          </Link>
        ))}
      </div>

      {/* Recent contacts */}
      {recentContacts.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
            <h2 className="font-semibold text-slate-800">Recent Contacts</h2>
            <Link href="/dashboard/contacts" className="text-sm text-indigo-600 hover:text-indigo-700">
              View all →
            </Link>
          </div>
          <div className="divide-y divide-slate-50">
            {recentContacts.map((contact: Contact) => (
              <Link
                key={contact.id}
                href={`/dashboard/contacts/${contact.id}`}
                className="flex items-center gap-4 px-6 py-3.5 hover:bg-slate-50 transition-colors"
              >
                {/* Avatar */}
                <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-indigo-600 font-semibold text-sm">
                    {contact.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 text-sm truncate">{contact.name}</p>
                  <p className="text-slate-400 text-xs truncate">
                    {[contact.role, contact.company].filter(Boolean).join(' @ ')}
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    STATUS_COLORS[contact.status] ?? 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {contact.status}
                </span>
                <span className="text-xs text-slate-400 flex-shrink-0">
                  {formatRelativeTime(contact.created_at)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {recentContacts.length === 0 && (
        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-12 text-center">
          <div className="text-4xl mb-3">🚀</div>
          <h3 className="font-semibold text-slate-700 mb-2">Start with Scout</h3>
          <p className="text-slate-400 text-sm mb-4">
            Describe who you want to reach; Scout finds and ranks people, and drafts wait for your approval.
          </p>
          <Link
            href="/dashboard/scout"
            className="inline-flex items-center gap-2 bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Open Scout →
          </Link>
        </div>
      )}
    </div>
  )
}
