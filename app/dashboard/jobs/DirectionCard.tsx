'use client'

// "What I'm scouting for" — the one free-text input that leads the planner.
// The page owns the draft and the save (Scout now must be able to save first),
// so this card is presentational: a textarea, a hint, a Save button, a status.

import Link from 'next/link'
import type { DirectionMode } from '@/lib/career/types'
import { MAX_DIRECTION_CHARS } from '@/lib/career/missions/direction'
import { DIRECTION_HINT_LEAD, DIRECTION_MODE_EMPTY_HINT, DIRECTION_MODE_OPTIONS, DIRECTION_PLACEHOLDER } from './direction'

export interface DirectionStatus {
  kind: 'ok' | 'error'
  text: string
}

export default function DirectionCard({
  value,
  onChange,
  onSave,
  dirty,
  saving,
  disabled,
  status,
  mode,
  onModeChange,
}: {
  value: string
  onChange: (next: string) => void
  onSave: () => void
  dirty: boolean
  saving: boolean
  /** No mission loaded, or migration 014 missing — nothing to bind to. */
  disabled: boolean
  status: DirectionStatus | null
  /** What the direction does. Optional: a caller that has not wired it yet renders the card without the choice. */
  mode?: Exclude<DirectionMode, 'off'>
  onModeChange?: (next: Exclude<DirectionMode, 'off'>) => void
}) {
  const hasText = value.trim().length > 0
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="scout-direction" className="text-sm font-semibold text-slate-900">
          What I&apos;m scouting for
        </label>
        <div className="flex items-center gap-3 shrink-0">
          {status && (
            <span className={`text-xs ${status.kind === 'ok' ? 'text-emerald-700' : 'text-rose-700'}`} role="status">
              {status.text}
            </span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={disabled || saving || !dirty}
            className="px-3 py-1 rounded-md bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>
      <textarea
        id="scout-direction"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={MAX_DIRECTION_CHARS}
        disabled={disabled}
        placeholder={DIRECTION_PLACEHOLDER}
        className="mt-2 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 disabled:bg-slate-50"
      />
      {onModeChange && (
        <fieldset className="mt-2" disabled={disabled || !hasText}>
          <legend className="sr-only">What this direction does</legend>
          <div className={`space-y-1 ${hasText ? '' : 'opacity-50'}`}>
            {DIRECTION_MODE_OPTIONS.map((o) => (
              <label key={o.value} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="direction-mode"
                  className="mt-1"
                  checked={(mode ?? 'boost') === o.value}
                  onChange={() => onModeChange(o.value)}
                />
                <span>
                  <span className="font-medium text-slate-900">{o.label}</span>
                  <span className="block text-xs text-slate-500">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {!hasText && <p className="mt-1 text-xs text-slate-500">{DIRECTION_MODE_EMPTY_HINT}</p>}
        </fieldset>
      )}
      <p className="mt-1 text-xs text-slate-500">
        {DIRECTION_HINT_LEAD} Locations, company types and hard constraints live on the{' '}
        <Link href="/dashboard/jobs/mission" className="text-indigo-600 hover:underline">
          Mission page
        </Link>
        .
      </p>
    </section>
  )
}
