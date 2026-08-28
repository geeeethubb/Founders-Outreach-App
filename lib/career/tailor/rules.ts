// The tailoring rules, as constants and pure checks.
//
// These are the parts of "minimal, truthful edit" that need no model at all:
// how many changes a patch may carry, which change types map to which edit
// level, which verb substitutions inflate ownership, and which fields the
// tailor is structurally unable to touch. Everything here is read by the
// prompt (rendered as text), by the tailor's validate(), and by the pipeline —
// one source, so the model is told exactly what the code will enforce.

import type { ChangeType, EditLevel, ProposedChange } from '../types'

/** Ordering changes are free; everything else is rationed. */
export const MAX_NON_REORDER_CHANGES = 6

/** Level 4 (a new bullet) is rare by design and verified strictly. */
export const MAX_LEVEL4 = 1

/** Reword no more than roughly this share of a bullet's words unless swapping. */
export const MAX_REWORD_FRACTION = 0.25

const LEVEL_BY_TYPE: Record<ChangeType, EditLevel> = {
  keep: 0,
  reorder: 1,
  remove: 1,
  reword: 2,
  swap: 3,
  new: 4,
}

export function editLevelFor(changeType: ChangeType): EditLevel {
  return LEVEL_BY_TYPE[changeType]
}

export const CHANGE_TYPES: ChangeType[] = ['keep', 'reorder', 'reword', 'swap', 'new', 'remove']

export function isChangeType(v: unknown): v is ChangeType {
  return typeof v === 'string' && (CHANGE_TYPES as string[]).includes(v)
}

/**
 * Verb substitutions that turn a contribution into an ownership claim. Each is
 * a WARNING for the verifier to rule on, not a block: "led" is sometimes the
 * honest word and the facts decide. Both the past and the base form are listed
 * so "built" → "architected" and "build" → "architect" both register.
 */
export const OWNERSHIP_ESCALATION: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'built', to: 'architected' },
  { from: 'build', to: 'architect' },
  { from: 'supported', to: 'led' },
  { from: 'support', to: 'lead' },
  { from: 'assisted', to: 'owned' },
  { from: 'assist', to: 'own' },
  { from: 'contributed', to: 'drove' },
  { from: 'contribute', to: 'drive' },
  { from: 'participated', to: 'managed' },
  { from: 'participate', to: 'manage' },
  { from: 'helped', to: 'led' },
  { from: 'help', to: 'lead' },
  { from: 'member', to: 'leader' },
]

/**
 * Fields the tailor cannot change. There is no field for them in
 * ProposedChange — the lock is the schema, and this list exists so the prompt
 * and the UI can say so in words.
 */
export const TITLE_LOCK: ReadonlyArray<string> = ['title', 'organization', 'start_date', 'end_date', 'location']

/** What validateChangeShape needs to know about the bank, without the bank. */
export interface ChangeShapeContext {
  experienceIds: Set<string>
  /** bullet id → experience id, for every approved bullet. */
  bulletExperience: Map<string, string>
  /** Approved alternates (is_on_master = false) — the only legal swap sources. */
  alternateBulletIds: Set<string>
  /**
   * Citable evidence id → experience id: approved facts AND approved metrics.
   * The first live run cited a metric's id for a bold-the-number change and was
   * rejected for it; a metric is evidence of exactly the kind a Level 2 emphasis
   * change rests on.
   */
  factExperience: Map<string, string>
}

const MIN_NEW_FACTS = 2

/**
 * Is this change structurally legal? Ids, required fields, level, and the
 * fact-id rule. Pure and exhaustive on purpose: a change that fails here never
 * existed, so nothing downstream has to handle it.
 */
export function validateChangeShape(change: ProposedChange, ctx: ChangeShapeContext): { ok: boolean; reason: string } {
  const t = change.change_type
  if (!isChangeType(t)) return { ok: false, reason: `unknown change_type "${String(t)}"` }
  if (t === 'keep') return { ok: false, reason: 'keep is implicit; do not submit it' }
  if (!ctx.experienceIds.has(change.experience_id)) {
    return { ok: false, reason: `unknown experience_id "${change.experience_id}"` }
  }
  if (change.edit_level !== editLevelFor(t)) {
    return {
      ok: false,
      reason: `edit_level ${change.edit_level} does not match change_type ${t} (expected ${editLevelFor(t)})`,
    }
  }

  const needsBullet = t === 'reorder' || t === 'reword' || t === 'swap' || t === 'remove'
  if (needsBullet) {
    if (!change.bullet_id) return { ok: false, reason: `${t} requires bullet_id` }
    const owner = ctx.bulletExperience.get(change.bullet_id)
    if (!owner) return { ok: false, reason: `unknown bullet_id "${change.bullet_id}"` }
    if (owner !== change.experience_id) {
      return { ok: false, reason: `bullet ${change.bullet_id} belongs to a different experience` }
    }
  }
  if (t === 'new' && change.bullet_id) return { ok: false, reason: 'new must not name a bullet_id' }

  if (t === 'swap') {
    if (!change.source_bullet_id) return { ok: false, reason: 'swap requires source_bullet_id' }
    if (!ctx.alternateBulletIds.has(change.source_bullet_id)) {
      return { ok: false, reason: `source_bullet_id ${change.source_bullet_id} is not an approved alternate` }
    }
    if (ctx.bulletExperience.get(change.source_bullet_id) !== change.experience_id) {
      return { ok: false, reason: 'swap source belongs to a different experience' }
    }
  }

  const needsText = t === 'reword' || t === 'new' || t === 'swap'
  if (needsText) {
    const text = (change.proposed_text ?? '').trim()
    if (!text) return { ok: false, reason: `${t} requires proposed_text` }
    if ((text.match(/\*\*/g) ?? []).length % 2 !== 0) return { ok: false, reason: 'unbalanced ** in proposed_text' }
  }

  if (t === 'reword' || t === 'new') {
    const ids = change.evidence_fact_ids
    if (ids.length === 0) return { ok: false, reason: `${t} must cite evidence_fact_ids` }
    if (t === 'new' && ids.length < MIN_NEW_FACTS) {
      return { ok: false, reason: `new requires at least ${MIN_NEW_FACTS} evidence_fact_ids` }
    }
    for (const id of ids) {
      const owner = ctx.factExperience.get(id)
      if (!owner) return { ok: false, reason: `evidence id ${id} is not an approved fact or metric` }
      if (owner !== change.experience_id) return { ok: false, reason: `fact ${id} belongs to a different experience` }
    }
  }

  return { ok: true, reason: '' }
}

/** The rules as the tailor reads them. Rendered from the constants so the two cannot drift. */
export function renderRules(): string {
  const pairs = OWNERSHIP_ESCALATION.filter((p) => /ed$|^member$/.test(p.from))
    .map((p) => `${p.from}→${p.to}`)
    .join(', ')
  return [
    `- At most ${MAX_NON_REORDER_CHANGES} changes other than reorder/remove. At most ${MAX_LEVEL4} new bullet.`,
    '- Edit levels are fixed by change_type: keep=0, reorder=1, remove=1, reword=2, swap=3, new=4.',
    '- reorder/reword/swap/remove name the bullet_id being changed. new names none.',
    '- swap names source_bullet_id: an approved ALTERNATE bullet (not on the master) of the SAME experience, and proposed_text is that alternate text verbatim.',
    '- reword cites at least 1 evidence_fact_id; new cites at least 2. Fact ids and metric ids are both citable. Every cited id must belong to the change\'s experience.',
    `- Reword at most ~${Math.round(MAX_REWORD_FRACTION * 100)}% of a bullet's words. If more must change, swap instead.`,
    `- Locked and not yours to change: ${TITLE_LOCK.join(', ')}. There is no field for them.`,
    `- Ownership words are audited. Do not upgrade: ${pairs}.`,
    '- Every number, tool, system, acronym and proper noun in proposed text must already appear in that experience\'s facts, metrics or bullets. Nothing new.',
  ].join('\n')
}
