'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/types'
import GmailConnection from '@/components/settings/GmailConnection'

export default function ProfilePage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'basic' | 'career'>('basic')
  const [extracting, setExtracting] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadedName, setUploadedName] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    email: '',
    role: '',
    company: '',
    major: '',
    graduation_year: '',
    linkedin_url: '',
    portfolio_url: '',
    bio: '',
    linkedin_bio_text: '',
    resume_text: '',
    target_roles: '',
    supplementary_materials: '',
    personal_context: '',
  })

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (data) {
        const p = data as Profile
        setForm({
          name: p.name ?? '',
          email: p.email ?? user.email ?? '',
          role: p.role ?? '',
          company: p.company ?? '',
          major: p.major ?? '',
          graduation_year: p.graduation_year ?? '',
          linkedin_url: p.linkedin_url ?? '',
          portfolio_url: p.portfolio_url ?? '',
          bio: p.bio ?? '',
          linkedin_bio_text: p.linkedin_bio_text ?? '',
          resume_text: p.resume_text ?? '',
          target_roles: p.target_roles ?? '',
          supplementary_materials: p.supplementary_materials ?? '',
          personal_context: p.personal_context ?? '',
        })
      } else {
        setForm((f) => ({ ...f, email: user.email ?? '' }))
      }
      setLoading(false)
    }
    load()
  }, [])

  function set(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setSaved(false)
  }

  // Resume upload is a convenience backup — it extracts plain text from the file
  // and drops it into the editable Résumé box. The file itself is not stored.
  async function handleResumeFile(file: File) {
    setUploadError(null)
    setUploadedName(null)
    setExtracting(true)
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      let text = ''
      if (isPdf) {
        text = await extractPdfText(file)
      } else if (/\.(txt|md|markdown)$/i.test(file.name) || file.type.startsWith('text/')) {
        text = await file.text()
      } else {
        throw new Error('Unsupported file. Upload a PDF or .txt file, or paste the text below.')
      }
      text = text.replace(/\n{3,}/g, '\n\n').trim()
      if (!text) throw new Error('Could not read any text from that file — try pasting it instead.')
      set('resume_text', text)
      setUploadedName(file.name)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Could not read that file — paste the text instead.')
    } finally {
      setExtracting(false)
    }
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setSaving(false); return }
    const { error } = await supabase.from('profiles').upsert({
      id: user.id,
      name: form.name || null,
      email: form.email || null,
      role: form.role || null,
      company: form.company || null,
      major: form.major || null,
      graduation_year: form.graduation_year || null,
      linkedin_url: form.linkedin_url || null,
      portfolio_url: form.portfolio_url || null,
      bio: form.bio || null,
      linkedin_bio_text: form.linkedin_bio_text || null,
      resume_text: form.resume_text || null,
      target_roles: form.target_roles || null,
      supplementary_materials: form.supplementary_materials || null,
      personal_context: form.personal_context || null,
    })
    setSaving(false)
    if (error) {
      setSaveError(error.message)
    } else {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    }
  }

  const tabs = [
    { id: 'basic', label: 'Basic Info' },
    { id: 'career', label: 'Career Context' },
  ] as const

  if (loading) return <div className="p-8 text-slate-400 text-sm">Loading…</div>

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">My Profile</h1>
        <p className="text-slate-500 text-sm mt-1">
          The AI uses this to write better personal outreach emails on your behalf
        </p>
      </div>

      {/* Avatar + name header */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6 flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
          <span className="text-indigo-600 font-bold text-xl">
            {form.name ? form.name.charAt(0).toUpperCase() : '?'}
          </span>
        </div>
        <div>
          <p className="font-semibold text-slate-900 text-lg">{form.name || 'Your Name'}</p>
          <p className="text-slate-500 text-sm">
            {[form.role || (form.major ? `${form.major} Student` : null), form.company || 'UIUC'].filter(Boolean).join(' @ ')}
          </p>
          {form.graduation_year && (
            <p className="text-xs text-slate-400 mt-0.5">Class of {form.graduation_year}</p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-slate-100 p-1 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === t.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {activeTab === 'basic' && (
          <>
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <h3 className="font-medium text-slate-800 text-sm">About You</h3>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Full Name *" value={form.name} onChange={(v) => set('name', v)} placeholder="Zuyu Chen" />
                <Field label="Email" value={form.email} onChange={(v) => set('email', v)} placeholder="you@illinois.edu" />
                <Field label="Major" value={form.major} onChange={(v) => set('major', v)} placeholder="Computer Science" />
                <Field label="Graduation Year" value={form.graduation_year} onChange={(v) => set('graduation_year', v)} placeholder="2026" />
                <Field label="Current Role / Title" value={form.role} onChange={(v) => set('role', v)} placeholder="Undergraduate Researcher" />
                <Field label="Company / Club" value={form.company} onChange={(v) => set('company', v)} placeholder="Founders: Illinois Entrepreneurs" />
              </div>
              <TextArea
                label="Short Bio"
                value={form.bio}
                onChange={(v) => set('bio', v)}
                placeholder="2–3 sentences about you. The AI uses this to personalize your intro line."
                rows={3}
              />
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <h3 className="font-medium text-slate-800 text-sm">Links</h3>
              <div className="grid grid-cols-1 gap-4">
                <Field
                  label="LinkedIn URL"
                  value={form.linkedin_url}
                  onChange={(v) => set('linkedin_url', v)}
                  placeholder="https://linkedin.com/in/yourhandle"
                  prefix="🔗"
                />
                <Field
                  label="Portfolio / Website"
                  value={form.portfolio_url}
                  onChange={(v) => set('portfolio_url', v)}
                  placeholder="https://yoursite.com"
                  prefix="🌐"
                />
              </div>
            </div>

            <GmailConnection />
          </>
        )}

        {activeTab === 'career' && (
          <>
            <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
              <p className="text-sm text-indigo-800 font-medium mb-1">
                💡 How this is used
              </p>
              <p className="text-sm text-indigo-700">
                The AI reads everything on this tab for two things: <strong>(1) ranking your contacts</strong> by how relevant each person is to <em>you</em> — your skills, experience, and what you're looking for — instead of just how famous they are; and <strong>(2) writing emails</strong> that sound like you. The more you add here, the better the fit ranking.
              </p>
              <p className="text-xs text-indigo-600 mt-2">
                After updating this, go to <strong>Contacts → Re-research All</strong> to re-rank everyone with your new profile.
              </p>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-slate-800 text-sm">What you're looking for</h3>
                <span className="text-xs text-indigo-500 font-medium">⭐ Top ranking signal</span>
              </div>
              <p className="text-xs text-slate-500">
                The single most important input for ranking. Describe the roles, industries, and kinds of people you want to reach — this is what a contact is scored against.
              </p>
              <TextArea
                label=""
                value={form.target_roles}
                onChange={(v) => set('target_roles', v)}
                placeholder="e.g. SWE / PM internships at Series A–C AI-infrastructure or fintech startups. Want to talk to founders and eng leaders building developer tools, and investors who back technical founders."
                rows={4}
              />
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-slate-800 text-sm">LinkedIn About Section</h3>
                <span className="text-xs text-slate-400">Paste from your profile</span>
              </div>
              <p className="text-xs text-slate-500">
                Go to your LinkedIn profile → About section → "See more" → copy all the text and paste here.
              </p>
              <TextArea
                label=""
                value={form.linkedin_bio_text}
                onChange={(v) => set('linkedin_bio_text', v)}
                placeholder="Paste your LinkedIn About section here…"
                rows={6}
              />
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-slate-800 text-sm">Résumé</h3>
                <span className="text-xs text-slate-400">Paste text, or upload as a backup</span>
              </div>
              <p className="text-xs text-slate-500">
                The richest signal for ranking — the AI uses your real projects, skills, and experience to judge how relevant each contact is to you. Pasting is most reliable; uploading a PDF/.txt just fills the box below (still editable).
              </p>

              <div className="flex items-center gap-3 flex-wrap">
                <label className="inline-flex items-center gap-2 cursor-pointer border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs font-medium px-3 py-2 rounded-lg transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12L8 8m4-4l4 4" />
                  </svg>
                  {extracting ? 'Reading…' : 'Upload PDF / .txt'}
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,text/plain,application/pdf"
                    className="hidden"
                    disabled={extracting}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) handleResumeFile(f)
                      e.target.value = '' // allow re-uploading the same file
                    }}
                  />
                </label>
                {uploadedName && !uploadError && (
                  <span className="text-xs text-green-600 font-medium">✓ Loaded {uploadedName} — review below</span>
                )}
                {uploadError && (
                  <span className="text-xs text-amber-600 font-medium">⚠ {uploadError}</span>
                )}
                <span className="text-xs text-slate-400">.docx not supported — paste the text</span>
              </div>

              <TextArea
                label=""
                value={form.resume_text}
                onChange={(v) => set('resume_text', v)}
                placeholder="Paste your resume here (plain text), or upload above…"
                rows={10}
              />
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
              <h3 className="font-medium text-slate-800 text-sm">Supplementary Materials</h3>
              <p className="text-xs text-slate-500">
                Anything else that signals your interests and strengths: links to projects, a personal site, papers, GitHub, notable work, or a short description of what you're best at.
              </p>
              <TextArea
                label=""
                value={form.supplementary_materials}
                onChange={(v) => set('supplementary_materials', v)}
                placeholder="e.g. github.com/you, my fintech side project (processed $50k), a hackathon win in ML, the blog post I wrote on vector databases…"
                rows={5}
              />
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
              <h3 className="font-medium text-slate-800 text-sm">Additional Context</h3>
              <p className="text-xs text-slate-500">
                Anything else you want the AI to know: specific projects you're proud of, what you're looking for, your strengths, past internships, etc.
              </p>
              <TextArea
                label=""
                value={form.personal_context}
                onChange={(v) => set('personal_context', v)}
                placeholder="e.g. I built a fintech app that processed $50k in transactions. I'm looking for PM or SWE internships at Series A–C startups. I'm especially interested in AI infrastructure."
                rows={5}
              />
            </div>
          </>
        )}

        {/* Save button */}
        <div className="flex items-center justify-between pt-2">
          <div>
            <p className="text-xs text-slate-400">Changes are saved to your profile and used immediately by the AI</p>
            {saveError && (
              <p className="text-xs text-red-500 mt-1 font-medium">⚠ Save failed: {saveError}</p>
            )}
          </div>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            {saving ? (
              'Saving…'
            ) : saved ? (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Saved
              </>
            ) : (
              'Save Profile'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Client-side PDF text extraction (best-effort backup) ──────────────────────

async function extractPdfText(file: File): Promise<string> {
  // pdfjs is browser-only and heavy — load it on demand.
  const pdfjs = await import('pdfjs-dist')
  // Worker is fetched from a version-matched CDN so we don't have to bundle it.
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`

  const buffer = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: buffer }).promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const line = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
    pages.push(line)
  }
  return pages.join('\n\n')
}

// ── Small field components ────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, prefix }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  prefix?: string
}) {
  return (
    <div>
      {label && <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>}
      <div className="flex items-center gap-2">
        {prefix && <span className="text-sm">{prefix}</span>}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
    </div>
  )
}

function TextArea({ label, value, onChange, placeholder, rows }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  return (
    <div>
      {label && <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows ?? 4}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
      />
    </div>
  )
}
