import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { formatRelativeTime } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  open:             'bg-blue-100 text-blue-700',
  meeting_booked:   'bg-emerald-100 text-emerald-700',
  closed_positive:  'bg-green-100 text-green-700',
  closed_negative:  'bg-gray-100 text-gray-500',
  ghosted:          'bg-amber-100 text-amber-600',
}

export default async function ConversationsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: conversations } = await supabase
    .from('conversations')
    .select(`*, contact:contacts(name, email, company, role)`)
    .eq('user_id', user.id)
    .order('last_message_at', { ascending: false })

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Conversations</h1>
        <p className="text-slate-500 text-sm mt-1">
          Replies and active threads from your outreach
        </p>
      </div>

      {!conversations || conversations.length === 0 ? (
        <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-12 text-center">
          <div className="text-3xl mb-3">💬</div>
          <p className="font-medium text-slate-700 mb-1">No conversations yet</p>
          <p className="text-slate-400 text-sm mb-4">
            Replies to your outreach emails will appear here.
          </p>
          <Link
            href="/compose"
            className="inline-flex items-center gap-2 bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Send your first outreach →
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="divide-y divide-slate-50">
            {conversations.map((conv: any) => (
              <div key={conv.id} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 transition-colors">
                <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-indigo-600 font-semibold text-sm">
                    {conv.contact?.name?.charAt(0).toUpperCase() ?? '?'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-slate-800 text-sm">{conv.contact?.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[conv.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {conv.status?.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="text-slate-400 text-xs truncate">
                    {[conv.contact?.role, conv.contact?.company].filter(Boolean).join(' @ ')}
                  </p>
                  {conv.outcome && (
                    <p className="text-xs text-green-600 font-medium mt-0.5">✓ {conv.outcome}</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  {conv.last_message_at && (
                    <p className="text-xs text-slate-400">{formatRelativeTime(conv.last_message_at)}</p>
                  )}
                  {conv.meeting_at && (
                    <p className="text-xs text-emerald-600 font-medium mt-0.5">
                      Meeting: {new Date(conv.meeting_at).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
