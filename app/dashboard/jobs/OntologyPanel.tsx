'use client'

// "What OutreachOS thinks you are, as things to search for."
//
// A collapsible panel over /api/career/ontology. Every row shows what the
// system decided, how sure it is, and — one click away — WHICH EVIDENCE said
// so. The four buttons are the founder's veto: boost, mute, exclude, add.
//
// Self-contained: it fetches on first expand and owns its own state, so it can
// be mounted anywhere on the Jobs page without threading props through it.

import { useCallback, useState } from 'react'
import { KIND_FIELD, ONTOLOGY_KINDS, type OntologyEntry, type OntologyKind, type SearchOntology } from '@/lib/career/ontology/types'

const KIND_LABEL: Record<OntologyKind, string> = {
  roleFamily: 'Role families',
  industry: 'Industries',
  adjacentIndustry: 'Adjacent',
  skillTerm: 'Skills',
  functionTerm: 'Functions',
  toolTerm: 'Tools',
}

const SOURCE_LABEL: Record<OntologyEntry['source'], string> = {
  evidence: 'from your evidence',
  direction: 'from your direction',
  mission: 'from your mission',
  user: 'your call',
}

interface ApiResponse {
  ontology: SearchOntology
  mission: { id: string; name: string; direction: string | null } | null
  bank?: { canonical: boolean; errors: string[]; migrationMissing: boolean }
  error?: string
}

function Bar({ value }: { value: number }) {
  return (
    <span className="inline-block h-1.5 w-12 rounded-full bg-slate-200 align-middle" title={`confidence ${value.toFixed(2)}`}>
      <span className="block h-1.5 rounded-full bg-indigo-500" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </span>
  )
}

function Row({
  entry, kind, busy, onAct,
}: {
  entry: OntologyEntry
  kind: OntologyKind
  busy: boolean
  onAct: (action: string, entry: OntologyEntry, kind: OntologyKind) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className={`px-3 py-2 ${entry.override === 'mute' ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-slate-900">{entry.label}</span>
            <Bar value={entry.confidence} />
            <span className="text-[11px] text-slate-500">{SOURCE_LABEL[entry.source]}</span>
            {entry.override === 'boost' && <span className="text-[11px] rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">boosted</span>}
            {entry.override === 'mute' && <span className="text-[11px] rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">muted</span>}
          </div>
          {entry.titleVariants.length > 0 && (
            <p className="mt-0.5 text-xs text-slate-500 truncate">{entry.titleVariants.slice(0, 5).join(' · ')}</p>
          )}
          <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-[11px] text-indigo-600 hover:underline">
            {open ? 'hide why' : 'why?'}
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5 border-l-2 border-slate-200 pl-2">
              {entry.why.map((w, i) => (
                <li key={i} className="text-[11px] text-slate-600">{w}</li>
              ))}
              {entry.evidenceIds.length > 0 && (
                <li className="text-[11px] text-slate-400">{entry.evidenceIds.length} evidence row(s) cited</li>
              )}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {(entry.override || entry.source === 'user' ? ['reset'] : []).concat(['boost', 'mute', 'exclude']).map((action) => (
            <button
              key={action}
              type="button"
              disabled={busy}
              onClick={() => onAct(action === 'reset' ? 'clear' : action, entry, kind)}
              className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              title={
                action === 'boost' ? 'Search this harder'
                  : action === 'mute' ? 'Keep it, search it last'
                    : action === 'exclude' ? 'Never search this' : 'Forget my override'
              }
            >
              {action}
            </button>
          ))}
        </div>
      </div>
    </li>
  )
}

export default function OntologyPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<OntologyKind>('roleFamily')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/career/ontology')
      const json = (await res.json()) as ApiResponse
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && !data && !loading) void load()
  }

  const act = useCallback(async (action: string, entry: { id: string; label: string }, entryKind: OntologyKind) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/career/ontology', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: entryKind, id: entry.id, label: entry.label, action }),
      })
      const json = (await res.json()) as ApiResponse
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
      setData((prev) => (prev ? { ...prev, ontology: json.ontology } : json))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }, [])

  const add = async () => {
    const label = draft.trim()
    if (!label) return
    await act('add', { id: '', label }, kind)
    setDraft('')
  }

  const ontology = data?.ontology ?? null
  const entries = ontology ? ontology[KIND_FIELD[kind]] : []
  const familyCount = ontology?.roleFamilies.length ?? 0

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between gap-3 p-4 text-left">
        <div>
          <span className="text-sm font-semibold text-slate-900">Roles I&apos;m searching for</span>
          <p className="mt-0.5 text-xs text-slate-500">
            {ontology
              ? `${familyCount} role families, ${ontology.industries.length} industries — derived from your Evidence Bank, yours to correct.`
              : 'Role families and industries derived from your Evidence Bank — open to see why, and to correct them.'}
          </p>
        </div>
        <span className="shrink-0 text-xs text-slate-400">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 p-4 pt-3">
          {loading && <p className="text-xs text-slate-500">Reading your Evidence Bank…</p>}
          {error && <p className="mb-2 text-xs text-rose-700" role="status">{error}</p>}

          {ontology && (
            <>
              {ontology.disciplines.length > 0 && (
                <p className="mb-3 text-xs text-slate-600">
                  <span className="font-medium text-slate-900">Because your evidence shows:</span>{' '}
                  {ontology.disciplines.slice(0, 6).map((d) => `${d.label} (${d.confidence.toFixed(2)})`).join(' · ')}
                </p>
              )}
              {ontology.stats.directionMode === 'exclusive' && (
                <p className="mb-3 rounded-md bg-indigo-50 px-2 py-1.5 text-xs text-indigo-800">
                  Your direction is set to <strong>only this</strong>, so the search is narrowed to what it names
                  {ontology.stats.narrowedByDirection > 0
                    ? ` — ${ontology.stats.narrowedByDirection} other discipline${ontology.stats.narrowedByDirection === 1 ? '' : 's'} your evidence supports ${ontology.stats.narrowedByDirection === 1 ? 'is' : 'are'} out of scope.`
                    : '.'}
                </p>
              )}
              {ontology.stats.usedTitleFallback && (
                <p className="mb-3 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                  Nothing in the discipline table matched your bank, so these are your own job titles. Add or boost
                  families below and the search widens.
                </p>
              )}
              {ontology.stats.bankEmpty && (
                <p className="mb-3 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                  Your Evidence Bank is empty, so this comes from your mission alone. Seed the bank to search wider.
                </p>
              )}

              <div className="mb-2 flex flex-wrap gap-1">
                {ONTOLOGY_KINDS.map((k) => {
                  const n = ontology[KIND_FIELD[k]].length
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      className={`rounded-md px-2 py-1 text-xs ${k === kind ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                    >
                      {KIND_LABEL[k]} {n}
                    </button>
                  )
                })}
              </div>

              {entries.length === 0 ? (
                <p className="px-1 py-3 text-xs text-slate-500">Nothing here yet. Add one below, or add evidence.</p>
              ) : (
                <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
                  {entries.map((e) => (
                    <Row key={e.id} entry={e} kind={kind} busy={busy} onAct={act} />
                  ))}
                </ul>
              )}

              <div className="mt-2 flex gap-2">
                <input
                  value={draft}
                  onChange={(ev) => setDraft(ev.target.value)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void add() } }}
                  placeholder={`Add a ${KIND_LABEL[kind].toLowerCase().replace(/s$/, '')} to search for…`}
                  className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => void add()}
                  disabled={busy || !draft.trim()}
                  className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  Add
                </button>
              </div>

              {ontology.excluded.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-slate-700">Excluded ({ontology.excluded.length})</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {ontology.excluded.map((e) => (
                      <button
                        key={`${e.kind}:${e.id}`}
                        type="button"
                        disabled={busy}
                        onClick={() => void act('clear', { id: e.id, label: e.label }, e.kind)}
                        className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                        title="Restore"
                      >
                        {e.label} ✕
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-3 text-[11px] text-slate-400">
                Ontology v{ontology.version} · {ontology.stats.experiencesConsidered} experiences, {ontology.stats.factsConsidered} facts,{' '}
                {ontology.stats.skillsConsidered} skills read · rebuilt every time the bank changes.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  )
}
