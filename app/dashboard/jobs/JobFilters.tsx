'use client'

import { APPLICATION_STATES } from '@/lib/career/types'
import { stateLabel } from '@/components/career/StateBadge'

export interface JobFilterState {
  freshness: 'verified' | 'likely' | 'any'
  tier: string
  role_family: string
  disposition: string
  state: string
  hasWarmPath: boolean
  minFit: string
  search: string
  sort: 'fit' | 'recent' | 'deadline'
}

export const DEFAULT_FILTERS: JobFilterState = {
  freshness: 'likely',
  tier: '',
  role_family: '',
  disposition: 'new,saved',
  state: '',
  hasWarmPath: false,
  minFit: '',
  search: '',
  sort: 'fit',
}

/** Query string for GET /api/career/jobs from the filter state. Empty values are omitted so the route applies its defaults. */
export function filtersToQuery(f: JobFilterState, limit: number, offset: number): string {
  const p = new URLSearchParams()
  p.set('freshness', f.freshness)
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
}: {
  value: JobFilterState
  onChange: (next: JobFilterState) => void
  roleFamilies: string[]
  tiers: number[]
}) {
  const set = <K extends keyof JobFilterState>(k: K, v: JobFilterState[K]) => onChange({ ...value, [k]: v })
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={sel} value={value.freshness} onChange={(e) => set('freshness', e.target.value as JobFilterState['freshness'])} title="How sure we are the posting is open">
        <option value="verified">Verified open</option>
        <option value="likely">Verified or likely open</option>
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
      <select className={sel} value={value.minFit} onChange={(e) => set('minFit', e.target.value)}>
        <option value="">Any fit</option>
        <option value="0.75">Strong (≥75%)</option>
        <option value="0.62">Good+ (≥62%)</option>
        <option value="0.48">Maybe+ (≥48%)</option>
      </select>
      <input
        value={value.search}
        onChange={(e) => set('search', e.target.value)}
        placeholder="Search title / company"
        className="rounded-md border border-slate-200 px-2 py-1 text-xs w-44"
      />
      <select className={sel} value={value.sort} onChange={(e) => set('sort', e.target.value as JobFilterState['sort'])}>
        <option value="fit">Sort: fit</option>
        <option value="recent">Sort: recent</option>
        <option value="deadline">Sort: deadline</option>
      </select>
      <button type="button" onClick={() => onChange(DEFAULT_FILTERS)} className="text-xs text-slate-500 hover:text-slate-900">
        Reset
      </button>
    </div>
  )
}
