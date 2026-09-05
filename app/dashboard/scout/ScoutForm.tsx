'use client'

// The mission form. It holds no run state: the page owns whether a run is
// going, and passes down only what the form needs to know — can a run start,
// and why not.

import type { ScoutFormPrefs } from './scout-run-view'

export interface CampaignOption {
  id: string
  name: string
  hasReference: boolean
  words: number | null
}

const SEARCH_MODES: { value: string; label: string; hint: string }[] = [
  {
    value: 'internal_first',
    label: 'Existing network first',
    hint: 'Search the people you already have. Only pay for discovery if they are not enough.',
  },
  {
    value: 'internal_only',
    label: 'Existing network only',
    hint: 'Never spend on discovery. Returns fewer people rather than padding.',
  },
  {
    value: 'both',
    label: 'Existing + new',
    hint: 'Search your network and discover new people regardless.',
  },
  {
    value: 'external_only',
    label: 'New contacts only',
    hint: 'Skip your network entirely. The most expensive option.',
  },
]

export default function ScoutForm({
  value,
  onChange,
  campaigns,
  locked,
  canStart,
  startLabel,
  onStart,
}: {
  value: ScoutFormPrefs
  onChange: (next: ScoutFormPrefs) => void
  campaigns: CampaignOption[]
  /** A run is starting or going: inputs are frozen. */
  locked: boolean
  /** Readiness said yes, nothing is in flight, and the goal is not empty. */
  canStart: boolean
  startLabel: string
  onStart: () => void
}) {
  const set = <K extends keyof ScoutFormPrefs>(key: K, v: ScoutFormPrefs[K]) => onChange({ ...value, [key]: v })
  const input = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50'

  return (
    <div className="mt-6 bg-white border border-slate-200 rounded-lg p-5">
      <label className="block text-sm font-medium text-slate-700">Mission</label>
      <textarea
        value={value.goal}
        onChange={(e) => set('goal', e.target.value)}
        rows={4}
        disabled={locked}
        className={`${input} focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500`}
      />

      <div className="grid grid-cols-3 gap-4 mt-4">
        <div>
          <label className="block text-sm font-medium text-slate-700">Geography</label>
          <input value={value.geography} onChange={(e) => set('geography', e.target.value)} disabled={locked} className={input} />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Market segments</label>
          <input type="number" min={1} max={3} value={value.segments} onChange={(e) => set('segments', Number(e.target.value))} disabled={locked} className={input} />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">People to research deeply</label>
          <input type="number" min={2} max={15} value={value.depth} onChange={(e) => set('depth', Number(e.target.value))} disabled={locked} className={input} />
          <p className="text-xs text-slate-500 mt-1">The main cost driver.</p>
        </div>
      </div>

      {/* ─── Where prospects may come from ─────────────────────────────── */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <label className="block text-sm font-medium text-slate-700">Search mode</label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {SEARCH_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              disabled={locked}
              onClick={() => set('searchMode', m.value)}
              aria-pressed={value.searchMode === m.value}
              className={`text-left rounded-md border px-3 py-2 transition-colors disabled:opacity-60 ${
                value.searchMode === m.value ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <div className="text-sm font-medium text-slate-900">
                {m.label}
                {m.value === 'internal_first' && <span className="ml-1.5 text-xs font-normal text-indigo-600">default</span>}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">{m.hint}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ─── The campaign whose voice drafts should match ───────────────── */}
      <div className="mt-4">
        <label className="block text-sm font-medium text-slate-700">Write drafts in the voice of</label>
        <select value={value.campaignId} onChange={(e) => set('campaignId', e.target.value)} disabled={locked} className={input}>
          <option value="">Default voice (no campaign reference)</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.hasReference}>
              {c.name}
              {c.hasReference ? ` — reference email, ${c.words} words` : ' — no reference email yet'}
            </option>
          ))}
        </select>
        <p className="text-xs text-slate-500 mt-1">
          Paste a real email on a campaign and every draft here is written to match it. Set one on the campaign page.
        </p>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        A run executes on the server in passes, saving where it got to after each one, and survives a refresh or a closed tab. A deeper
        sweep is also available from the command line: <code className="text-slate-700">npm run scout</code>.
      </p>

      <button
        type="button"
        onClick={onStart}
        disabled={!canStart}
        className="mt-5 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:bg-slate-300"
      >
        {startLabel}
      </button>
    </div>
  )
}
