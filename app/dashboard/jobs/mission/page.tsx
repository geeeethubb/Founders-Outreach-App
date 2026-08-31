'use client'

// The mission editor. Everything the planner and the fit evaluator read about
// what the user wants lives on one row; this page edits it. Saving weights
// re-ranks stored evaluations with no model call (fit/recompute is arithmetic).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { CareerMission, CareerMissionPreferences, DirectionMode, FitWeights, HardConstraint, LocationMode } from '@/lib/career/types'
import { FIT_DIMENSIONS, missionDirectionMode, missionLocations } from '@/lib/career/types'
import { api } from '@/components/career/api'
import InlineNotice, { MigrationNotice } from '@/components/career/InlineNotice'
import ListEditor from './ListEditor'
import WeightsEditor from './WeightsEditor'
import ConstraintsEditor from './ConstraintsEditor'
import {
  DIRECTION_HINT,
  DIRECTION_MODE_EMPTY_HINT,
  DIRECTION_MODE_OPTIONS,
  DIRECTION_PLACEHOLDER,
  LOCATION_MODE_OPTIONS,
  LOCATION_EMPTY_WARNING,
  locationChoiceIncomplete,
  locationsPatch,
} from '../direction'

interface MissionsResponse {
  missions: CareerMission[]
  activeId: string | null
  defaults: { weights: FitWeights; labels: Record<string, string>; questions: Record<string, string> }
}

// Season and status are not edited here: the season is Summer 2027 by construction
// (docs/CAREER_OS.md §5) and the only mission is the active one whatever its status.
const WORK_MODES: CareerMissionPreferences['work_modes'] = ['remote', 'hybrid', 'onsite']


function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {hint && <p className="text-xs text-slate-500 mt-0.5 mb-3">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  )
}

export default function MissionPage() {
  const [loaded, setLoaded] = useState<MissionsResponse | null>(null)
  const [draft, setDraft] = useState<CareerMission | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)

  const load = useCallback(async () => {
    const r = await api<MissionsResponse>('/api/career/missions')
    if (!r.ok || !r.data) {
      setMigrationMissing(r.migrationMissing)
      setError(r.error)
      return
    }
    setLoaded(r.data)
    setDraft(r.data.missions.find((m) => m.id === r.data!.activeId) ?? r.data.missions[0] ?? null)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function patch(p: Partial<CareerMission>) {
    setDraft((d) => (d ? { ...d, ...p } : d))
  }
  function patchPrefs(p: Partial<CareerMissionPreferences>) {
    setDraft((d) => (d ? { ...d, preferences: { ...d.preferences, ...p } } : d))
  }
  // The dial and the ranking table it drives are written together, so the two
  // can never disagree about what was asked for (see locationsPatch).
  function patchLocations(next: { mode?: LocationMode; regions?: string[] }) {
    if (!draft) return
    const current = missionLocations(draft.preferences)
    patchPrefs(locationsPatch({ mode: next.mode ?? current.mode, regions: next.regions ?? current.regions }))
  }

  async function save() {
    if (!draft || !loaded) return
    setSaving(true)
    setNotice(null)
    const before = loaded.missions.find((m) => m.id === draft.id)
    const weightsChanged = JSON.stringify(before?.fit_weights ?? null) !== JSON.stringify(draft.fit_weights ?? null)
    const body: Partial<CareerMission> = {
      name: draft.name,
      objective: draft.objective,
      preferences: draft.preferences,
      hard_constraints: draft.hard_constraints.filter((c) => c.dimension.trim()),
      fit_weights: draft.fit_weights,
      ...(draft.mission_migration_notes ? { mission_migration_notes: draft.mission_migration_notes } : {}),
    }
    const r = await api<{ mission: CareerMission }>(`/api/career/missions/${draft.id}`, { method: 'PATCH', json: body })
    if (!r.ok || !r.data) {
      setSaving(false)
      setNotice({ kind: 'error', text: r.error ?? 'Save failed' })
      return
    }
    setLoaded({ ...loaded, missions: loaded.missions.map((m) => (m.id === r.data!.mission.id ? r.data!.mission : m)) })
    setDraft(r.data.mission)
    if (weightsChanged) {
      const rr = await api<{ updated: number; errors: string[] }>('/api/career/fit/recompute', { json: {} })
      setSaving(false)
      if (!rr.ok) setNotice({ kind: 'warn', text: `Saved, but re-ranking failed: ${rr.error}` })
      else setNotice({ kind: 'ok', text: `Saved. Re-ranked ${rr.data?.updated ?? 0} job${rr.data?.updated === 1 ? '' : 's'} with the new weights${rr.data?.errors?.length ? ` (${rr.data.errors.length} errors)` : ''}.` })
    } else {
      setSaving(false)
      setNotice({ kind: 'ok', text: 'Saved.' })
    }
  }

  const back = (
    <Link href="/dashboard/jobs" className="text-sm text-slate-500 hover:text-slate-900">
      ← Jobs
    </Link>
  )

  if (migrationMissing) {
    return (
      <div className="p-8 max-w-4xl space-y-4">
        {back}
        <MigrationNotice />
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-8 max-w-4xl space-y-4">
        {back}
        <InlineNotice kind="error">{error}</InlineNotice>
      </div>
    )
  }
  if (!draft || !loaded) return <p className="p-8 text-sm text-slate-500">Loading…</p>

  const prefs = draft.preferences
  // The RAW draft dial, not the resolved one: `missionLocations` collapses a
  // regionless "prefer"/"only" to "anywhere", which would snap the radio back
  // before the user has typed the first place. It resolves only for a pre-017
  // row that has no dial stored yet.
  const locations = prefs.locations ?? missionLocations(prefs)
  const hasDirection = (prefs.direction ?? '').trim().length > 0
  const directionMode = missionDirectionMode(prefs) === 'exclusive' ? 'exclusive' : 'boost'
  const notes = draft.mission_migration_notes ?? []
  // A place choice with nowhere to point is a 400 at the API. Refuse it here,
  // in front of the person, rather than letting them press Save and be told no.
  const placeIncomplete = locationChoiceIncomplete(locations)
  const weights: FitWeights = { ...loaded.defaults.weights, ...(draft.fit_weights ?? {}) }
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded.missions.find((m) => m.id === draft.id))

  return (
    <div className="p-8 max-w-4xl">
      {back}
      <div className="mt-2 mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">Mission</span>
            <input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              aria-label="Mission name"
              className="mt-0.5 w-full max-w-xl text-2xl font-semibold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none"
            />
          </label>
          <p className="text-sm text-slate-500 mt-1">What you are looking for. The planner reads all of it; the fit evaluator reads the preferences and answers ten questions weighted below.</p>
        </div>
        <button type="button" onClick={save} disabled={saving || !dirty || placeIncomplete} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 shrink-0">
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>

      {notice && (
        <div className="mb-4">
          <InlineNotice kind={notice.kind}>{notice.text}</InlineNotice>
        </div>
      )}
      {/* Written by a migration that changed something, or declined to change
          something, rather than overwriting a preference in silence. */}
      {notes.length > 0 && (
        <div className="mb-4 space-y-2">
          {notes.map((n, i) => (
            <InlineNotice key={`${n.kind}-${i}`} kind="warn">
              <span className="flex items-start justify-between gap-3">
                <span>{n.message}</span>
                <button
                  type="button"
                  onClick={() => patch({ mission_migration_notes: notes.filter((_, j) => j !== i) })}
                  className="shrink-0 text-xs underline hover:no-underline"
                >
                  Dismiss
                </button>
              </span>
            </InlineNotice>
          ))}
        </div>
      )}
      <div className="space-y-4">
        <Section title="Goal">
          <label className="block text-xs font-semibold text-slate-600">
            Objective
            <textarea value={draft.objective} onChange={(e) => patch({ objective: e.target.value })} rows={2} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm font-normal" />
          </label>
          <label className="block mt-3 text-xs font-semibold text-slate-600">
            What I&apos;m scouting for (direction)
            <textarea
              value={prefs.direction ?? ''}
              onChange={(e) => patchPrefs({ direction: e.target.value })}
              rows={3}
              placeholder={DIRECTION_PLACEHOLDER}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm font-normal"
            />
            <span className="block mt-1 text-xs font-normal text-slate-500">{DIRECTION_HINT} Also editable on the Jobs page — it is one value.</span>
          </label>
          <fieldset className="mt-3" disabled={!hasDirection}>
            <legend className="text-xs font-semibold text-slate-600">What this direction does</legend>
            <div className={`mt-1 space-y-1 ${hasDirection ? '' : 'opacity-50'}`}>
              {DIRECTION_MODE_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="direction-mode"
                    className="mt-1"
                    checked={directionMode === o.value}
                    onChange={() => patchPrefs({ direction_mode: o.value as DirectionMode })}
                  />
                  <span>
                    <span className="font-medium text-slate-900">{o.label}</span>
                    <span className="block text-xs font-normal text-slate-500">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {!hasDirection && <p className="mt-1 text-xs font-normal text-slate-500">{DIRECTION_MODE_EMPTY_HINT}</p>}
          </fieldset>
        </Section>

        <Section title="Where" hint="Three different things, and only one of them hides jobs from you.">
          <div className="space-y-3">
            <fieldset>
              <legend className="sr-only">Where I will go</legend>
              <div className="space-y-1">
                {LOCATION_MODE_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="radio" name="location-mode" className="mt-1" checked={locations.mode === o.value} onChange={() => patchLocations({ mode: o.value })} />
                    <span>
                      <span className="font-medium text-slate-900">{o.label}</span>
                      <span className="block text-xs text-slate-500">{o.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {locations.mode !== 'anywhere' && (
              <>
                <ListEditor
                  label={locations.mode === 'only' ? 'Only these places' : 'Preferred places'}
                  value={locations.regions}
                  onChange={(v) => patchLocations({ regions: v })}
                  placeholder="Houston, Texas, the Midwest…"
                />
                {locationChoiceIncomplete(locations) && <InlineNotice kind="warn">{LOCATION_EMPTY_WARNING[locations.mode as 'prefer' | 'only']}</InlineNotice>}
              </>
            )}
            <div>
              <span className="block text-xs font-semibold text-slate-600 mb-1">Work modes</span>
              <div className="flex gap-3">
                {WORK_MODES.map((m) => (
                  <label key={m} className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={prefs.work_modes.includes(m)}
                      onChange={(e) => patchPrefs({ work_modes: e.target.checked ? [...prefs.work_modes, m] : prefs.work_modes.filter((x) => x !== m) })}
                    />
                    {m}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <Section title="What" hint="Role families are seeds only — the planner infers them from your Evidence Bank when the list is empty.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ListEditor label="Company types" value={prefs.company_types} onChange={(v) => patchPrefs({ company_types: v })} placeholder="high-quality startups…" />
            <ListEditor label="Industries" value={prefs.industries} onChange={(v) => patchPrefs({ industries: v })} placeholder="energy / oil & gas…" />
            <ListEditor label="Role families (seed)" value={prefs.role_families} onChange={(v) => patchPrefs({ role_families: v })} placeholder="process engineering…" />
            <ListEditor label="Optimize for (priority order)" ordered value={prefs.optimize_for} onChange={(v) => patchPrefs({ optimize_for: v })} placeholder="learning, ownership…" />
          </div>
          <label className="block mt-3 text-xs font-semibold text-slate-600">
            Notes (read verbatim by the planner and the fit evaluator)
            <textarea value={prefs.notes ?? ''} onChange={(e) => patchPrefs({ notes: e.target.value })} rows={3} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm font-normal" />
          </label>
        </Section>

        <Section title="Hard constraints" hint="Filters, not preferences. A posting failing one is rejected before fit is judged; the rejection reason shows the label.">
          <ConstraintsEditor value={draft.hard_constraints} onChange={(v: HardConstraint[]) => patch({ hard_constraints: v })} />
        </Section>

        <Section title="Fit weights" hint="Changing these re-ranks every evaluated job on save — arithmetic over stored component scores, no model call.">
          <WeightsEditor
            value={weights}
            defaults={loaded.defaults.weights}
            labels={loaded.defaults.labels}
            questions={loaded.defaults.questions}
            onChange={(next) => {
              if (!next) return patch({ fit_weights: null })
              const w: Partial<FitWeights> = {}
              for (const d of FIT_DIMENSIONS) w[d] = next[d]
              patch({ fit_weights: w })
            }}
          />
        </Section>
      </div>

      <div className="mt-5 flex justify-end">
        <button type="button" onClick={save} disabled={saving || !dirty || placeIncomplete} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>
    </div>
  )
}
