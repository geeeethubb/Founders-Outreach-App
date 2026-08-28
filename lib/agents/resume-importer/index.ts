// Resume Importer Agent.
//
// Judgment problem it owns: "which atomic facts, metrics, skills and
// deliverables does this résumé text actually assert, and to which experience
// does each belong?"
//
// It PROPOSES. Nothing it emits is usable by the tailor until a human approves
// it on the Evidence page (approval is a column, docs/CAREER_OS.md §4).
//
// The guarantee lives in validate(), not in the prompt. Every number in a fact
// must appear in the paragraph it cites; every skill must be named by the text;
// every paragraph index must belong to the experience it is filed under; every
// experience key must be one the code supplied. A fact that fails is DROPPED
// and counted, never repaired — a repaired fact is a fact the model did not
// assert, which is exactly what the bank must not contain.

import crypto from 'crypto'
import { runAgent } from '../runtime/loop'
import { numberTokens, numbersSupported, skillSupported } from './checks'
import { normalizeModelText } from '../runtime/text'
import type { AgentResult, ToolContext } from '../runtime/types'
import type { FactCategory, SkillCategory, ExperienceKind } from '@/lib/career/types'
import {
  resumeImporterPrompt,
  RESUME_SOURCE_LABEL,
  type ImporterExperienceInput,
  type ImporterExtraSource,
  type ImporterParagraph,
  type ResumeImporterInput,
} from './prompt'

export { resumeImporterPrompt, RESUME_SOURCE_LABEL }
export { numberTokens, numbersSupported, skillSupported }
export type { ResumeImporterInput, ImporterExperienceInput, ImporterExtraSource, ImporterParagraph }

export interface ImportedFact {
  statement: string
  category: FactCategory
  source_label: string
  paragraph_index: number
  confidence: number
}

export interface ImportedMetric {
  value: string
  unit: string | null
  context: string | null
  /** Indexes into the experience's facts[] AFTER validation. */
  fact_refs: number[]
}

export interface ImportedSkill {
  name: string
  category: SkillCategory
  fact_refs: number[]
}

export interface ImportedDeliverable {
  description: string
  fact_refs: number[]
}

export interface ImportedNewExperience {
  title: string
  organization: string
  location: string | null
  start_date: string | null
  end_date: string | null
  kind: ExperienceKind
}

export interface ImportedExperience {
  experience_key: string
  summary: string
  /** Only in text mode, where the agent proposed the block itself. */
  new_experience: ImportedNewExperience | null
  facts: ImportedFact[]
  metrics: ImportedMetric[]
  skills: ImportedSkill[]
  deliverables: ImportedDeliverable[]
}

export interface ResumeImporterOutput {
  experiences: ImportedExperience[]
  /** Facts whose numbers the cited paragraph does not contain. */
  dropped_unverifiable: number
  dropped_metrics: number
  dropped_skills: number
  /** Facts filed under an unknown experience or a paragraph outside it. */
  dropped_misfiled: number
  dropped_experiences: number
}

const FACT_CATEGORIES: FactCategory[] = [
  'responsibility', 'achievement', 'metric', 'skill', 'tool', 'context', 'award', 'education', 'scope', 'other',
]
const SKILL_CATEGORIES: SkillCategory[] = ['technical', 'tool', 'domain', 'business', 'language', 'other']
const EXPERIENCE_KINDS: ExperienceKind[] = ['experience', 'project', 'leadership', 'research', 'education', 'award', 'other']

const FACT_REFS = { type: 'array', items: { type: 'integer' }, description: 'Indexes into this experience\'s facts array.' }

export const OUTPUT_SCHEMA = {
  properties: {
    experiences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          experience_key: { type: 'string', description: 'A supplied key, copied exactly.' },
          summary: { type: 'string', description: 'One sentence.' },
          new_experience: {
            type: ['object', 'null'],
            description: 'Only when no experiences were supplied. Otherwise null.',
            properties: {
              title: { type: 'string' },
              organization: { type: 'string' },
              location: { type: ['string', 'null'] },
              start_date: { type: ['string', 'null'] },
              end_date: { type: ['string', 'null'] },
              kind: { type: 'string', enum: EXPERIENCE_KINDS },
            },
            required: ['title', 'organization', 'location', 'start_date', 'end_date', 'kind'],
          },
          facts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                statement: { type: 'string', description: 'ONE atomic claim, numbers verbatim.' },
                category: { type: 'string', enum: FACT_CATEGORIES },
                source_label: { type: 'string', description: `"${RESUME_SOURCE_LABEL}" or an additional source label.` },
                paragraph_index: { type: 'integer', description: 'The ¶ or L index shown next to the paragraph.' },
                confidence: { type: 'number', description: '0 to 1.' },
              },
              required: ['statement', 'category', 'source_label', 'paragraph_index', 'confidence'],
            },
          },
          metrics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string', description: 'Exactly as written: "$4M+", "30%", "1,600+".' },
                unit: { type: ['string', 'null'] },
                context: { type: ['string', 'null'] },
                fact_refs: FACT_REFS,
              },
              required: ['value', 'unit', 'context', 'fact_refs'],
            },
          },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string', enum: SKILL_CATEGORIES },
                fact_refs: FACT_REFS,
              },
              required: ['name', 'category', 'fact_refs'],
            },
          },
          deliverables: {
            type: 'array',
            items: {
              type: 'object',
              properties: { description: { type: 'string' }, fact_refs: FACT_REFS },
              required: ['description', 'fact_refs'],
            },
          },
        },
        required: ['experience_key', 'summary', 'new_experience', 'facts', 'metrics', 'skills', 'deliverables'],
      },
    },
  },
  required: ['experiences'],
}

// ─── Validation ──────────────────────────────────────────────────────────────

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 1
  return Math.min(1, Math.max(0, v))
}

function refs(v: unknown, max: number): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    const n = typeof x === 'number' ? x : Number(x)
    if (Number.isInteger(n) && n >= 0 && n < max && !out.includes(n)) out.push(n)
  }
  return out
}

/** Every line the code supplied, addressable by (label, index). */
function buildSourceIndex(input: ResumeImporterInput): {
  byExperience: Map<string, Map<number, string>>
  extra: Map<string, Map<number, string>>
  headerOf: Map<string, string>
} {
  const byExperience = new Map<string, Map<number, string>>()
  const headerOf = new Map<string, string>()
  for (const e of input.experiences) {
    byExperience.set(e.key, new Map(e.bullets.map((b) => [b.paragraph_index, b.text])))
    headerOf.set(e.key, [e.title, e.organization, e.location, e.start_date, e.end_date].filter(Boolean).join(' '))
  }
  const extra = new Map<string, Map<number, string>>()
  for (const s of input.extra_sources) extra.set(s.label, new Map(s.lines.map((l) => [l.paragraph_index, l.text])))
  return { byExperience, extra, headerOf }
}

/**
 * Pure. Exported so the deterministic test can feed it a fake model output
 * with an invented experience key and an invented metric and watch both fall.
 */
export function validateImporterOutput(raw: unknown, input: ResumeImporterInput): ResumeImporterOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.experiences)) return null

  const src = buildSourceIndex(input)
  const supplied = new Set(input.experiences.map((e) => e.key))
  const seenKeys = new Set<string>()

  let droppedUnverifiable = 0
  let droppedMetrics = 0
  let droppedSkills = 0
  let droppedMisfiled = 0
  let droppedExperiences = 0

  const experiences: ImportedExperience[] = []

  for (const entry of r.experiences) {
    if (!entry || typeof entry !== 'object') continue
    const x = entry as Record<string, unknown>
    const key = normalizeModelText(x.experience_key)
    if (!key || seenKeys.has(key)) {
      droppedExperiences++
      continue
    }

    let newExperience: ImportedNewExperience | null = null
    if (!supplied.has(key)) {
      // An unknown key is a hallucinated experience — unless this is text mode,
      // where proposing blocks is the job, and the block must at least name
      // who and what.
      const ne = x.new_experience
      if (!input.allow_new_experiences || !ne || typeof ne !== 'object') {
        droppedExperiences++
        continue
      }
      const n = ne as Record<string, unknown>
      const title = normalizeModelText(n.title)
      const organization = normalizeModelText(n.organization)
      if (!title || !organization) {
        droppedExperiences++
        continue
      }
      const kind = String(n.kind ?? '') as ExperienceKind
      newExperience = {
        title,
        organization,
        location: normalizeModelText(n.location) || null,
        start_date: normalizeModelText(n.start_date) || null,
        end_date: normalizeModelText(n.end_date) || null,
        kind: EXPERIENCE_KINDS.includes(kind) ? kind : 'other',
      }
    }
    seenKeys.add(key)

    const paragraphs = src.byExperience.get(key) ?? new Map<number, string>()
    const header = src.headerOf.get(key) ?? ''
    // The header carries the dates, so "since 9/2024" in a fact is not a
    // fabricated number even though no bullet repeats it.
    const experienceText = [header, ...paragraphs.values()].join('\n')

    // Facts first; everything else refers into them by index, so the index
    // map from the model's positions to the surviving positions is needed.
    const facts: ImportedFact[] = []
    const factIndexMap = new Map<number, number>()
    const rawFacts = Array.isArray(x.facts) ? x.facts : []
    rawFacts.forEach((rf, i) => {
      if (!rf || typeof rf !== 'object') return
      const f = rf as Record<string, unknown>
      const statement = normalizeModelText(f.statement)
      if (!statement) return
      const label = normalizeModelText(f.source_label) || RESUME_SOURCE_LABEL
      const idx = typeof f.paragraph_index === 'number' ? f.paragraph_index : Number(f.paragraph_index)

      let sourceText: string | null = null
      if (label === RESUME_SOURCE_LABEL) {
        // (b) the paragraph must belong to THIS experience.
        const p = paragraphs.get(idx)
        sourceText = p === undefined ? null : `${header}\n${p}`
      } else {
        const p = src.extra.get(label)?.get(idx)
        sourceText = p === undefined ? null : p
      }
      if (sourceText === null) {
        droppedMisfiled++
        return
      }
      // (c) every number must be in the cited text.
      if (!numbersSupported(statement, sourceText).ok) {
        droppedUnverifiable++
        return
      }
      const cat = String(f.category ?? '') as FactCategory
      factIndexMap.set(i, facts.length)
      facts.push({
        statement,
        category: FACT_CATEGORIES.includes(cat) ? cat : 'other',
        source_label: label,
        paragraph_index: idx,
        confidence: clamp01(f.confidence),
      })
    })

    const remap = (v: unknown): number[] =>
      refs(v, rawFacts.length)
        .map((i) => factIndexMap.get(i))
        .filter((i): i is number => i !== undefined)

    const extraText = input.extra_sources.map((s) => s.lines.map((l) => l.text).join('\n')).join('\n')
    const skillText = `${experienceText}\n${extraText}`

    const metrics: ImportedMetric[] = []
    for (const rm of Array.isArray(x.metrics) ? x.metrics : []) {
      if (!rm || typeof rm !== 'object') continue
      const m = rm as Record<string, unknown>
      const value = normalizeModelText(m.value)
      // (d) the metric's value is checked against the same text as the facts.
      if (!value || numberTokens(value).length === 0 || !numbersSupported(value, skillText).ok) {
        droppedMetrics++
        continue
      }
      metrics.push({
        value,
        unit: normalizeModelText(m.unit) || null,
        context: normalizeModelText(m.context) || null,
        fact_refs: remap(m.fact_refs),
      })
    }

    const skills: ImportedSkill[] = []
    const seenSkills = new Set<string>()
    for (const rs of Array.isArray(x.skills) ? x.skills : []) {
      if (!rs || typeof rs !== 'object') continue
      const s = rs as Record<string, unknown>
      const name = normalizeModelText(s.name)
      // (e) the text must actually name the skill.
      if (!name || seenSkills.has(name.toLowerCase()) || !skillSupported(name, skillText)) {
        droppedSkills++
        continue
      }
      seenSkills.add(name.toLowerCase())
      const cat = String(s.category ?? '') as SkillCategory
      skills.push({ name, category: SKILL_CATEGORIES.includes(cat) ? cat : 'other', fact_refs: remap(s.fact_refs) })
    }

    const deliverables: ImportedDeliverable[] = []
    for (const rd of Array.isArray(x.deliverables) ? x.deliverables : []) {
      if (!rd || typeof rd !== 'object') continue
      const d = rd as Record<string, unknown>
      const description = normalizeModelText(d.description)
      if (!description) continue
      deliverables.push({ description, fact_refs: remap(d.fact_refs) })
    }

    experiences.push({
      experience_key: key,
      summary: normalizeModelText(x.summary),
      new_experience: newExperience,
      facts,
      metrics,
      skills,
      deliverables,
    })
  }

  // Supplied experiences and none of them recognized is a misunderstanding of
  // the task, which the loop can correct. Text mode with nothing proposed is
  // the same failure.
  if (experiences.length === 0) return null

  return {
    experiences,
    dropped_unverifiable: droppedUnverifiable,
    dropped_metrics: droppedMetrics,
    dropped_skills: droppedSkills,
    dropped_misfiled: droppedMisfiled,
    dropped_experiences: droppedExperiences,
  }
}

export function importerInputHash(input: ResumeImporterInput): string {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)
}

export async function runResumeImporter(
  input: ResumeImporterInput,
  ctx: ToolContext,
  opts: { onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<ResumeImporterOutput>> {
  return runAgent<ResumeImporterInput, ResumeImporterOutput>({
    agentId: 'resume_importer',
    // Standard, not cheap: decomposition into atomic claims is where a cheaper
    // model merges two bullets into one fact and the number check drops both.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: resumeImporterPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: (raw) => validateImporterOutput(raw, input),
    ctx,
    // Reads only what it was given. A web search here would be a way to
    // "verify" the résumé against the internet, which is the wrong question.
    webSearch: false,
    maxSteps: 4,
    // Measured on the real master résumé (14 bullets, 4 identity lines): 8000
    // truncated twice, the loop's max_tokens branch recovered it on the third
    // turn at $0.40 with a shortened fact list. 12000 fits in one turn.
    maxTokens: 12000,
    onStep: opts.onStep,
    cacheKeyParts: {
      input_hash: importerInputHash(input),
      // validate() post-processes and the cache replays its output, so a fix
      // to the number check must invalidate cached results. Bump on any change
      // to numberTokens, numbersSupported or skillSupported.
      validate_logic: 1,
    },
  })
}
