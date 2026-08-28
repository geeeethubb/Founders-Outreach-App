// Renderers: from an EvidenceBank + a JobEvidenceMap + a job to the inputs the
// tailor and the verifier take.
//
// The tailor sees ALL experiences with their bullets — it must be able to say
// "nothing changes here" about every one — but facts are capped per experience
// and the matcher's top experiences come first, so the prompt leads with what
// matters. Only approved material is rendered: an unapproved fact is not
// evidence yet, and rendering it would let the tailor cite it.

import { stripMarkdown } from '../documents/docx-read'
import { bulletsForExperience, factsForExperience, metricsForExperience } from '../evidence/store'
import { experienceLabel } from '../evidence/render'
import { renderRules } from './rules'
import type { ResumeTailorInput, TailorExperience, TailorJob, TailorEvidenceMap } from '@/lib/agents/resume-tailor/prompt'
import type { ResumeFactVerifierInput } from '@/lib/agents/resume-fact-verifier/prompt'
import type { EditLevel, EvidenceBank, JobEvidenceMap, JobOpportunity } from '../types'

export const MAX_FACTS_PER_EXPERIENCE = 12
export const MAX_KEY_REQUIREMENTS = 15
export const MAX_RESPONSIBILITIES = 8
export const MAX_DESCRIPTION_CHARS = 2000

/** The subset of a JobEvidenceMap the tailor reads. */
export type EvidenceMapForTailor = Pick<JobEvidenceMap, 'why_i_fit' | 'emphasize' | 'do_not_claim' | 'top_experience_ids'>

/** The job fields the tailor reads, from a stored opportunity. */
export function tailorJobFromOpportunity(
  job: Pick<JobOpportunity, 'title' | 'company_name' | 'min_qualifications' | 'preferred_qualifications' | 'skills' | 'responsibilities' | 'description_text'>
): TailorJob {
  const reqs = Array.from(new Set([...job.min_qualifications, ...job.preferred_qualifications, ...job.skills]))
  return {
    title: job.title,
    company: job.company_name,
    key_requirements: reqs.slice(0, MAX_KEY_REQUIREMENTS),
    responsibilities: job.responsibilities.slice(0, MAX_RESPONSIBILITIES),
    description_excerpt: (job.description_text ?? '').slice(0, MAX_DESCRIPTION_CHARS),
  }
}

/** The job's vocabulary — what keyword stuffing would borrow from. */
export function jobTermsFor(job: TailorJob): string[] {
  const terms = new Set<string>()
  for (const s of [...job.key_requirements, ...job.responsibilities]) {
    const t = s.trim()
    if (!t) continue
    terms.add(t)
    // Short phrases are also checked word by word: "Six Sigma Black Belt"
    // stuffed as "Six Sigma" must still register.
    const words = t.split(/\s+/)
    if (words.length <= 6) {
      for (let i = 0; i < words.length; i++) {
        for (let n = 1; n <= 3 && i + n <= words.length; n++) {
          const phrase = words.slice(i, i + n).join(' ').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '')
          if (phrase.length >= 4 && /[A-Z]/.test(phrase[0])) terms.add(phrase)
        }
      }
    }
  }
  return [...terms]
}

export function renderTailorExperience(bank: EvidenceBank, experienceId: string): TailorExperience | null {
  const e = bank.experiences.find((x) => x.id === experienceId)
  if (!e) return null
  return {
    id: e.id,
    label: experienceLabel(e),
    bullets: bulletsForExperience(bank, e.id)
      .filter((b) => b.approved)
      .map((b) => ({ id: b.id, text: stripMarkdown(b.text), is_on_master: b.is_on_master, fact_ids: b.evidence_fact_ids })),
    facts: factsForExperience(bank, e.id)
      .filter((f) => f.approved)
      .slice(0, MAX_FACTS_PER_EXPERIENCE)
      .map((f) => ({ id: f.id, statement: f.statement })),
    metrics: metricsForExperience(bank, e.id)
      .filter((m) => m.approved)
      .map((m) => ({ id: m.id, value: m.value, unit: m.unit, context: m.context })),
  }
}

export function buildTailorInput(bank: EvidenceBank, job: TailorJob, map: EvidenceMapForTailor): ResumeTailorInput {
  const top = map.top_experience_ids.filter((id) => bank.experiences.some((e) => e.id === id))
  const rest = bank.experiences
    .filter((e) => e.approved && !top.includes(e.id))
    .sort((a, b) => a.display_order - b.display_order)
    .map((e) => e.id)
  const experiences = [...top, ...rest]
    .map((id) => renderTailorExperience(bank, id))
    .filter((e): e is TailorExperience => e !== null)
  const evidenceMap: TailorEvidenceMap = {
    why_i_fit: map.why_i_fit,
    emphasize: map.emphasize,
    do_not_claim: map.do_not_claim,
    top_experience_ids: top,
  }
  return { job, evidenceMap, experiences, rules: renderRules() }
}

/**
 * The verifier's input for one proposed text. Deliberately narrow: no reason,
 * no job, no requirement. Facts here are NOT capped — the audit must see every
 * approved fact, or an honest clause fails for lack of the one fact the tailor
 * saw and the verifier did not.
 */
export function buildVerifierInput(
  bank: EvidenceBank,
  experienceId: string,
  original: string | null,
  proposed: string,
  editLevel: EditLevel
): ResumeFactVerifierInput | null {
  const e = bank.experiences.find((x) => x.id === experienceId)
  if (!e) return null
  return {
    experience_label: experienceLabel(e),
    original_text: original ? stripMarkdown(original) : null,
    proposed_text: stripMarkdown(proposed),
    edit_level: editLevel,
    facts: factsForExperience(bank, e.id).filter((f) => f.approved).map((f) => ({ id: f.id, statement: f.statement })),
    metrics: metricsForExperience(bank, e.id)
      .filter((m) => m.approved)
      .map((m) => ({ id: m.id, value: m.value, unit: m.unit, context: m.context })),
    other_bullets: bulletsForExperience(bank, e.id).filter((b) => b.approved).map((b) => stripMarkdown(b.text)),
    skills: bank.skills.filter((s) => s.approved).map((s) => s.name),
  }
}
