// Resume Tailor Agent.
//
// Judgment problem it owns: "what, if anything, should change on this résumé
// for this job, and at what edit level?"
//
// It proposes. It never decides. Everything it emits passes the shape rules in
// lib/career/tailor/rules.ts here, at the schema boundary — a change that cites
// a fact from another experience, names a bullet that does not exist, or picks
// a swap source that is on the master is dropped and COUNTED, never repaired.
// Then the deterministic pre-check and the independent fact verifier run in
// lib/career/tailor/pipeline.ts. This file is only the first gate.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import {
  CHANGE_TYPES,
  MAX_LEVEL4,
  MAX_NON_REORDER_CHANGES,
  editLevelFor,
  isChangeType,
  validateChangeShape,
  type ChangeShapeContext,
} from '@/lib/career/tailor/rules'
import type { ProposedChange } from '@/lib/career/types'
import type { AgentResult, ToolContext } from '../runtime/types'
import { resumeTailorPrompt, type ResumeTailorInput } from './prompt'

export type { ResumeTailorInput, TailorJob, TailorExperience, TailorBullet, TailorEvidenceMap } from './prompt'

export interface RejectedChange {
  change: ProposedChange
  reason: string
}

export interface ResumeTailorOutput {
  changes: ProposedChange[]
  /** What the tailor tried and validation refused, so the UI can say so. */
  rejected: RejectedChange[]
  no_change_reason: string | null
  summary: string
  /** Changes dropped because they named an id the code never supplied. */
  dropped_unknown_ids: number
  /** Changes dropped to respect MAX_NON_REORDER_CHANGES / MAX_LEVEL4. */
  truncated: number
}

export const OUTPUT_SCHEMA = {
  properties: {
    changes: {
      type: 'array',
      description: 'Only non-keep changes. Empty is a valid answer.',
      items: {
        type: 'object',
        properties: {
          bullet_id: { type: ['string', 'null'], description: 'Required for reorder/reword/swap/remove. Null for new.' },
          experience_id: { type: 'string' },
          change_type: { type: 'string', enum: CHANGE_TYPES.filter((t) => t !== 'keep') },
          edit_level: { type: 'integer', minimum: 1, maximum: 4, description: 'reorder=1 remove=1 reword=2 swap=3 new=4' },
          proposed_text: { type: ['string', 'null'], description: 'Required for reword/new; for swap, the alternate text verbatim.' },
          source_bullet_id: { type: ['string', 'null'], description: 'swap only: the approved alternate bullet.' },
          position: { type: 'integer', minimum: 0, description: 'Order within the experience after the patch.' },
          reason: { type: 'string' },
          job_requirement: { type: 'string', description: 'The requirement this change serves.' },
          evidence_fact_ids: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: [
          'bullet_id', 'experience_id', 'change_type', 'edit_level', 'proposed_text', 'source_bullet_id',
          'position', 'reason', 'job_requirement', 'evidence_fact_ids', 'confidence',
        ],
      },
    },
    no_change_reason: { type: ['string', 'null'], description: 'Set when changes is empty.' },
    summary: { type: 'string' },
  },
  required: ['changes', 'no_change_reason', 'summary'],
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
}

/**
 * Long prose fields sometimes arrive with the model's own tool-call markup
 * leaking in: a trailing "</summary>", or "</no_change_reason>
<parameter
 * name="summary">…" glued onto the previous field. Seen on two of the first
 * three live runs. Everything from the first tag onward is not prose.
 */
export function prose(v: unknown): string {
  const s = normalizeModelText(v)
  const cut = s.search(/<\/?[a-z_]+(?:\s[^>]*)?>/i)
  return (cut >= 0 ? s.slice(0, cut) : s).replace(/["\s]+$/, '').trim()
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Coerce a raw change into the shape; ids are kept as strings for the shape check. */
function coerce(raw: unknown, index: number): ProposedChange | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const changeType = String(r.change_type ?? '')
  if (!isChangeType(changeType)) return null
  const text = r.proposed_text === null || r.proposed_text === undefined ? null : normalizeModelText(r.proposed_text)
  const level = num(r.edit_level, -1)
  return {
    bullet_id: typeof r.bullet_id === 'string' && r.bullet_id.trim() ? r.bullet_id.trim() : null,
    experience_id: String(r.experience_id ?? '').trim(),
    change_type: changeType,
    // Cast is deliberate: validateChangeShape rejects a level that does not match.
    edit_level: level as ProposedChange['edit_level'],
    original_text: null,
    proposed_text: text && text.length ? text : null,
    source_bullet_id:
      typeof r.source_bullet_id === 'string' && r.source_bullet_id.trim() ? r.source_bullet_id.trim() : null,
    position: Math.max(0, Math.round(num(r.position, index))),
    reason: prose(r.reason),
    job_requirement: normalizeModelText(r.job_requirement),
    evidence_fact_ids: Array.from(new Set(strings(r.evidence_fact_ids))),
    confidence: Math.min(1, Math.max(0, num(r.confidence, 0.5))),
  }
}

export function shapeContextFrom(input: ResumeTailorInput): ChangeShapeContext {
  const experienceIds = new Set<string>()
  const bulletExperience = new Map<string, string>()
  const alternateBulletIds = new Set<string>()
  const factExperience = new Map<string, string>()
  for (const e of input.experiences) {
    experienceIds.add(e.id)
    for (const b of e.bullets) {
      bulletExperience.set(b.id, e.id)
      if (!b.is_on_master) alternateBulletIds.add(b.id)
    }
    for (const f of e.facts) factExperience.set(f.id, e.id)
    for (const m of e.metrics) factExperience.set(m.id, e.id)
  }
  return { experienceIds, bulletExperience, alternateBulletIds, factExperience }
}

/**
 * Exported so the offline test can drive it without a model. Returns null only
 * when the envelope itself is unusable; a bad CHANGE is dropped and counted,
 * because rejecting the whole answer for one bad change would throw away the
 * good ones (ADR-007's lesson, applied here).
 */
export function validateTailorOutput(raw: unknown, input: ResumeTailorInput): ResumeTailorOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.changes)) return null

  const ctx = shapeContextFrom(input)
  const bulletText = new Map<string, string>()
  for (const e of input.experiences) for (const b of e.bullets) bulletText.set(b.id, b.text)

  const accepted: ProposedChange[] = []
  const rejected: RejectedChange[] = []
  let droppedUnknown = 0
  // One change per bullet. finalBulletsFor resolves a bullet to a single
  // change, so a reorder and a reword on the same bullet would silently lose
  // one of them; every change carries its own position, so the second is
  // redundant at best. First one wins (the model's own order).
  const touched = new Set<string>()

  r.changes.forEach((rawChange, i) => {
    const c = coerce(rawChange, i)
    if (!c) {
      droppedUnknown++
      return
    }
    // A swap carries its source's text, whatever the model wrote — the whole
    // point of Level 3 is that the words are already approved.
    if (c.change_type === 'swap' && c.source_bullet_id && bulletText.has(c.source_bullet_id)) {
      c.proposed_text = bulletText.get(c.source_bullet_id) ?? c.proposed_text
    }
    const shape = validateChangeShape(c, ctx)
    if (!shape.ok) {
      if (/unknown|not an approved|different experience/.test(shape.reason)) droppedUnknown++
      rejected.push({ change: c, reason: shape.reason })
      return
    }
    if (c.bullet_id) {
      if (touched.has(c.bullet_id)) {
        rejected.push({ change: c, reason: `bullet ${c.bullet_id} already has a change in this patch; one change per bullet` })
        return
      }
      touched.add(c.bullet_id)
    }
    c.original_text = c.bullet_id ? bulletText.get(c.bullet_id) ?? null : null
    accepted.push(c)
  })

  // Enforce the caps by confidence. Reorders and removes are free.
  let truncated = 0
  const free = accepted.filter((c) => c.change_type === 'reorder' || c.change_type === 'remove')
  const rationed = accepted
    .filter((c) => c.change_type !== 'reorder' && c.change_type !== 'remove')
    .sort((a, b) => b.confidence - a.confidence)
  const kept: ProposedChange[] = []
  let level4 = 0
  for (const c of rationed) {
    if (kept.length >= MAX_NON_REORDER_CHANGES) {
      truncated++
      rejected.push({ change: c, reason: `over the cap of ${MAX_NON_REORDER_CHANGES} non-reorder changes (lowest confidence dropped)` })
      continue
    }
    if (c.change_type === 'new') {
      if (level4 >= MAX_LEVEL4) {
        truncated++
        rejected.push({ change: c, reason: `over the cap of ${MAX_LEVEL4} new bullet` })
        continue
      }
      level4++
    }
    kept.push(c)
  }

  const changes = [...free, ...kept].sort((a, b) => a.position - b.position)
  const noChange = r.no_change_reason === null || r.no_change_reason === undefined ? null : prose(r.no_change_reason)

  return {
    changes,
    rejected,
    no_change_reason:
      changes.length === 0
        ? noChange || (rejected.length ? `The tailor proposed ${rejected.length} change(s); none passed validation.` : 'The tailor proposed no changes.')
        : null,
    summary: prose(r.summary),
    dropped_unknown_ids: droppedUnknown,
    truncated,
  }
}

/** Identity of the tailor's input, for the cache. */
export function tailorCacheParts(input: ResumeTailorInput): Record<string, unknown> {
  return {
    job: [input.job.title, input.job.company, ...input.job.key_requirements],
    experiences: input.experiences.map((e) => [
      e.id,
      e.bullets.map((b) => `${b.id}:${b.text}`),
      e.facts.map((f) => `${f.id}:${f.statement}`),
      // Metrics are citable ids; a cached answer citing a metric that has
      // since changed would carry a stale id into the patch.
      e.metrics.map((m) => `${m.id}:${m.value}${m.unit ?? ''}`),
    ]),
    map: input.evidenceMap,
    rules: input.rules,
    // Deterministic post-processing version: a cached AgentResult replays the
    // already-validated output, so a change to validateTailorOutput (id rules,
    // tag stripping, caps) does not reach cached patches unless this bumps.
    post_processing: 4,
  }
}

export async function runResumeTailor(
  input: ResumeTailorInput,
  ctx: ToolContext,
  opts: { onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<ResumeTailorOutput>> {
  return runAgent<ResumeTailorInput, ResumeTailorOutput>({
    agentId: 'resume_tailor',
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: resumeTailorPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: (raw) => validateTailorOutput(raw, input),
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 7000,
    cacheKeyParts: tailorCacheParts(input),
    onStep: opts.onStep,
  })
}

export { editLevelFor }
