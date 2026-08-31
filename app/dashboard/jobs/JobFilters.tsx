'use client'

// The inbox's controls, arranged around the question that now matters most.
//
// At 40 postings the first question was "is it still open?". At 400 it is "is
// this even the right subject?" — so relevance leads, and the rest of the
// filters move to a second row. Every control maps to one query parameter and
// nothing is remembered between sessions: what the URL and the header say is
// what the list is.

import { APPLICATION_STATES } from '@/lib/career/types'
import { stateLabel } from '@/components/career/StateBadge'

export interface JobFilterState {
  /** How sure we are the posting is open. `open` = everything not known closed. */
  freshness: 'verified' | 'likely' | 'open' | 'any'
  /** How close to the stated direction. `possible` = strong + possible. */
  relevance: 'strong' | 'possible' | 'any'
  /** `needs_look` = relevant postings no model has read yet. */
  view: 'all' | 'needs_look'
  tier: string
  role_family: string
  disposition: string
  state: string
  hasWarmPath: boolean
  minFit: string
  search: string
  sort: 'best' | 'fit' | 'recent' | 'deadline'
  /** One line per posting instead of a card. Display only — never sent to the server. */
  dense: boolean
}

/**
 * Relevance-first, and open rather than verified.
 *
 * The previous defaults (freshness=likely, sort=fit) hid two different things
 * at once: every UNVERIFIED posting, and — because a fit sort puts nulls last —
 * every posting no model had ranked yet. Between them, half the inventory was
 * below the fold with nothing on screen saying so.
 */
export const DEFAULT_FILTERS: JobFilterState = {
  freshness: 'open',
  relevance: 'possible',
  view: 'all',
  tier: '',
  role_family: '',
  disposition: 'new,saved',
  state: '',
  hasWarmPath: false,
  minFit: '',
  search: '',
  sort: 'best',
  dense: false,
}

/** True when nothing has been narrowed — so the empty state can say "no jobs yet" instead of "no matches". */
export function isDefaultFilters(f: JobFilterState): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof JobFilterState)[]).every((k) => k === 'dense' || f[k] === DEFAULT_FILTERS[k])
}

/** Query string for GET /api/career/jobs from the filter state. `dense` is a display choice and never sent. */
export function filtersToQuery(f: JobFilterState, limit: number, offset: number): string {
  const p = new URLSearchParams()
  p.set('freshness', f.freshness)
  p.set('relevance', f.relevance)
  if (f.view !== 'all') p.set('view', f.view)
  if (f.tier) p.set('tier', f.tier)
  if (f.role_family) p.set('role_family', f.role_family)
  if (f.disposition) p.set('disposition', f.disposition)
  if (f.state) p.set('state', f.state)
  if (f.hasWarmPath) p.set('hasWarmPath', '1')
  if (f.minFit) p.set('minFit', f.minFit)
  if (f.search.trim()) p.set('search', f.search.trim())
  p.set('sort', f.sort)
  p.set('limit', String(limit))
  p.set('offset', String(offset))
  return p.toString()
}

const sel = 'rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700'

export default function JobFilters({
  value,
  onChange,
  roleFamilies,
  tiers,
  needsLook,
  direction,
}: {
  value: JobFilterState
  onChange: (next: JobFilterState) => void
  roleFamilies: string[]
  tiers: number[]
  /** How many relevant postings nobody has read yet — the badge on the queue. */
  needsLook?: number
  /** What the founder said they are scouting for, so the relevance control can say what it is judging against. */
  direction?: string | null
}) {
  const set = <K extends keyof JobFilterState>(k: K, v: JobFilterState[K]) => onChange({ ...value, [k]: v })
  const judging = direction ? `Scored against: ${direction}` : 'No direction stated — nothing is scored off-direction'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${sel} font-medium`}
          value={value.relevance}
          onChange={(e) => onChange({ ...value, relevance: e.target.value as JobFilterState['relevance'] })}
          title={judging}
        >
          <option value="strong">Strong matches only</option>
          <option value="possible">Strong + possible</option>
          <option value="any">Everything, including off-direction</option>
        </select>
        <button
          type="button"
          onClick={() => set('view', value.view === 'needs_look' ? 'all' : 'needs_look')}
          aria-pressed={value.view === 'needs_look'}
          title="Relevant postings nobody has read yet — only the board listing is known"
          className={`rounded-md border px-2 py-1 text-xs ${
            value.view === 'needs_look' ? 'border-amber-300 bg-amber-50 text-amber-800 font-medium' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          Needs a look{typeof needsLook === 'number' ? ` (${needsLook})` : ''}
        </button>
        <input
          value={value.search}
          onChange={(e) => set('search', e.target.value)}
          placeholder="Search every posting"
          title="Searches the whole inventory, not the page"
          className="rounded-md border border-slate-200 px-2 py-1 text-xs w-52"
        />
        <select className={sel} value={value.sort} onChange={(e) => set('sort', e.target.value as JobFilterState['sort'])}>
          <option value="best">Sort: best first</option>
          <option value="fit">Sort: fit</option>
          <option value="recent">Sort: recent</option>
          <option value="deadline">Sort: deadline</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input type="checkbox" checked={value.dense} onChange={(e) => set('dense', e.target.checked)} />
          compact
        </label>
        <button type="button" onClick={() => onChange({ ...DEFAULT_FILTERS, dense: value.dense })} className="ml-auto text-xs text-slate-500 hover:text-slate-900">
          Reset
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className={sel} value={value.freshness} onChange={(e) => set('freshness', e.target.value as JobFilterState['freshness'])} title="How sure we are the posting is open">
          <option value="verified">Verified open</option>
          <option value="likely">Verified or likely open</option>
          <option value="open">Open — not known closed</option>
          <option value="any">Any status</option>
        </select>
        <select className={sel} value={value.tier} onChange={(e) => set('tier', e.target.value)} title="Location tier from the mission">
          <option value="">All tiers</option>
          {(tiers.length ? tiers : [1, 2, 3]).map((t) => (
            <option key={t} value={String(t)}>
              Tier {t}
            </option>
          ))}
        </select>
        <select className={sel} value={value.role_family} onChange={(e) => set('role_family', e.target.value)}>
          <option value="">All role families</option>
          {roleFamilies.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select className={sel} value={value.disposition} onChange={(e) => set('disposition', e.target.value)}>
          <option value="new,saved">New + saved</option>
          <option value="new">New only</option>
          <option value="saved">Saved only</option>
          <option value="dismissed">Dismissed</option>
          <option value="">Everything</option>
        </select>
        <select className={sel} value={value.state} onChange={(e) => set('state', e.target.value)}>
          <option value="">Any application state</option>
          {APPLICATION_STATES.map((s) => (
            <option key={s} value={s}>
              {stateLabel(s)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input type="checkbox" checked={value.hasWarmPath} onChange={(e) => set('hasWarmPath', e.target.checked)} />
          warm path
        </label>
        <select className={sel} value={value.minFit} onChange={(e) => set('minFit', e.target.value)} title="Only postings a fit evaluation has already scored">
          <option value="">Any fit</option>
          <option value="0.75">Strong (≥75%)</option>
          <option value="0.62">Good+ (≥62%)</option>
          <option value="0.48">Maybe+ (≥48%)</option>
        </select>
      </div>
    </div>
  )
}
