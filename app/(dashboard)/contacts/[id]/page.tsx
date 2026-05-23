import { createClient } from '@/lib/supabase/server'
import { getContact } from '@/lib/supabase/queries'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import ResearchCard from '@/components/contacts/ResearchCard'
import { STATUS_COLORS, formatRelativeTime } from '@/lib/utils'

interface Props {
  params: { id: string }
}

export default async function ContactDetailPage({ params }: Props) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const contact = await getContact(params.id)
  if (!contact) notFound()

  // Load emails for this contact
  const { data: emails } = await supabase
    .from('emails')
    .select('id, subject, status, variant_label, sent_at, created_at, generation_metadata')
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
    .limit(10)

  return (
    <div className="p-8 max-w-5xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-slate-400 mb-6">
        <Link href="/contacts" className="hover:text-slate-600 transition-colors">Contacts</Link>
        <span>/</span>
        <span className="text-slate-700 font-medium">{contact.name}</span>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: Contact info */}
        <div className="col-span-1 space-y-4">
          {/* Profile card */}
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center">
                <span className="text-indigo-600 font-bold text-lg">
                  {contact.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <div>
                <h1 className="font-semibold text-slate-900">{contact.name}</h1>
                <p className="text-slate-500 text-sm">
                  {[contact.role, contact.company].filter(Boolean).join(' @ ')}
                </p>
              </div>
            </div>

            <div className="space-y-2 text-sm">
              {contact.location && (
                <div className="flex gap-2 text-slate-600">
                  <span className="text-slate-400">📍</span>
                  <span>{contact.location}</span>
                </div>
              )}
              {contact.email && (
                <div className="flex gap-2 text-slate-600">
                  <span className="text-slate-400">✉️</span>
                  <a href={`mailto:${contact.email}`} className="hover:text-indigo-600 truncate">
                    {contact.email}
                  </a>
                </div>
              )}
              {contact.linkedin_url && (
                <div className="flex gap-2 text-slate-600">
                  <span className="text-slate-400">🔗</span>
                  <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer"
                    className="hover:text-indigo-600 truncate text-xs">
                    LinkedIn Profile
                  </a>
                </div>
              )}
              {contact.twitter_handle && (
                <div className="flex gap-2 text-slate-600">
                  <span className="text-slate-400">𝕏</span>
                  <span className="text-xs">{contact.twitter_handle}</span>
                </div>
              )}
            </div>

            {/* Status */}
            <div className="mt-4 pt-4 border-t border-slate-100">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Status</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[contact.status] ?? ''}`}>
                  {contact.status}
                </span>
              </div>
              {contact.tags && contact.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {contact.tags.map((tag) => (
                    <span key={tag} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {contact.notes && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-xs text-slate-500 mb-1">Notes</p>
                <p className="text-sm text-slate-700">{contact.notes}</p>
              </div>
            )}

            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs text-slate-400">Added {formatRelativeTime(contact.created_at)}</p>
            </div>
          </div>

          {/* Quick actions */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">Actions</p>
            <Link
              href={`/compose?contact=${contact.id}`}
              className="flex items-center gap-2 w-full px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Write Outreach Email
            </Link>
          </div>
        </div>

        {/* Right: Research + Email history */}
        <div className="col-span-2 space-y-5">
          {/* Research */}
          <ResearchCard contact={contact} onResearchComplete={() => {}} />

          {/* Email history */}
          {emails && emails.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-6">
              <h3 className="font-semibold text-slate-800 mb-4">Email History</h3>
              <div className="space-y-3">
                {emails.map((email) => (
                  <div key={email.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                    <div className="w-6 h-6 rounded-md bg-indigo-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-indigo-600 text-xs font-bold">
                        {email.variant_label ?? '—'}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-700 truncate">
                        {email.subject ?? 'No subject'}
                      </p>
                      <p className="text-xs text-slate-400">
                        {email.sent_at
                          ? `Sent ${formatRelativeTime(email.sent_at)}`
                          : `Draft · ${formatRelativeTime(email.created_at)}`}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      email.status === 'sent' ? 'bg-green-100 text-green-700' :
                      email.status === 'draft' ? 'bg-gray-100 text-gray-600' :
                      email.status === 'failed' ? 'bg-red-100 text-red-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>
                      {email.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
