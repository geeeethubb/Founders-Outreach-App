// The evidence bank the diversity regression runs as. Chemical engineering,
// manufacturing, AI and entrepreneurship — the founder's four, in the shape the
// product's own `buildSearchOntology` reads.
//
// Written here rather than loaded from the real résumé on purpose: this suite
// must run with no key, no database and no personal document on disk, and the
// numbers it prints must be reproducible by anyone who checks the repo out. The
// résumé stays untracked; the SHAPE of the person is what the test needs.
//
// It is a fixture, not a fallback. Nothing in the product reads it.

import { emptyBank } from '@/lib/career/evidence/store'
import type { CareerMission, EvidenceBank, EvidenceExperience, EvidenceFact, EvidencePreference, EvidenceSkill } from '@/lib/career/types'
import { defaultMission } from '@/lib/career/missions/store'

const NOW = '2026-08-31T00:00:00.000Z'
const USER = 'recall-eval'

function experience(
  id: string,
  kind: EvidenceExperience['kind'],
  organization: string,
  title: string,
  description: string
): EvidenceExperience {
  return {
    id, user_id: USER, kind, organization, title,
    start_date: null, end_date: null, location: null, description,
    display_order: 0, source: 'master_resume', approved: true, created_at: NOW, updated_at: NOW,
  }
}

function fact(id: string, experienceId: string | null, statement: string, category: EvidenceFact['category']): EvidenceFact {
  return {
    id, user_id: USER, experience_id: experienceId, statement, category,
    source: 'master_resume', source_location: null, confidence: 0.9,
    approved: true, created_at: NOW, updated_at: NOW,
  }
}

function skill(id: string, name: string, category: EvidenceSkill['category']): EvidenceSkill {
  return { id, user_id: USER, name, category, evidence_fact_ids: [], approved: true, created_at: NOW }
}

function preference(id: string, category: string, value: string, weight: number): EvidencePreference {
  return { id, user_id: USER, category, value, weight, hard_constraint: false, note: null, created_at: NOW }
}

/** The founder, as evidence: chemical engineering + manufacturing + AI + entrepreneurship. */
export function recallEvidenceBank(): EvidenceBank {
  const experiences: EvidenceExperience[] = [
    experience(
      'exp-process', 'experience', 'Specialty Chemicals Plant', 'Process Engineering Intern',
      'Ran mass and energy balances on a continuous reactor train, sized a heat exchanger for a debottlenecking study, and wrote the standard operating procedure for a catalyst changeover.'
    ),
    experience(
      'exp-mfg', 'experience', 'Contract Manufacturer', 'Manufacturing Operations Co-op',
      'Owned yield and scrap reporting for two production lines, ran a lean changeover kaizen, and stood up a statistical process control chart the line operators actually used.'
    ),
    experience(
      'exp-materials', 'research', 'University Materials Laboratory', 'Undergraduate Researcher',
      'Synthesised and characterised polymer electrolyte membranes; ran electrochemical impedance spectroscopy and thermogravimetric analysis; co-authored the group’s coatings durability report.'
    ),
    experience(
      'exp-ai', 'project', 'Industrial AI Side Project', 'Founder and Engineer',
      'Built a Python and PyTorch model that predicted batch quality from process historian data, and shipped it as a small web tool plant engineers used at shift handover.'
    ),
    experience(
      'exp-venture', 'leadership', 'Student Venture Program', 'Co-founder',
      'Co-founded a hardware venture around waste-heat recovery, ran customer discovery with twenty industrial sites, and raised a small university grant.'
    ),
  ]

  const facts: EvidenceFact[] = [
    fact('f-1', 'exp-process', 'Debottlenecked a continuous reactor train and recovered 8% of lost throughput.', 'achievement'),
    fact('f-2', 'exp-process', 'Wrote the catalyst changeover SOP now used on every turnaround.', 'responsibility'),
    fact('f-3', 'exp-mfg', 'Cut changeover time on two production lines by 22% through a lean kaizen.', 'achievement'),
    fact('f-4', 'exp-mfg', 'Owned daily yield, scrap and OEE reporting for the plant.', 'responsibility'),
    fact('f-5', 'exp-materials', 'Characterised polymer electrolyte membranes by EIS and TGA.', 'skill'),
    fact('f-6', 'exp-ai', 'Trained a PyTorch model on process historian data to predict batch quality.', 'achievement'),
    fact('f-7', 'exp-venture', 'Ran customer discovery with twenty industrial sites for a waste-heat venture.', 'context'),
  ]

  const skills: EvidenceSkill[] = [
    skill('s-1', 'process engineering', 'technical'),
    skill('s-2', 'mass and energy balances', 'technical'),
    skill('s-3', 'heat transfer', 'technical'),
    skill('s-4', 'reaction engineering', 'technical'),
    skill('s-5', 'statistical process control', 'technical'),
    skill('s-6', 'lean manufacturing', 'domain'),
    skill('s-7', 'polymer characterisation', 'technical'),
    skill('s-8', 'electrochemistry', 'technical'),
    skill('s-9', 'Python', 'tool'),
    skill('s-10', 'PyTorch', 'tool'),
    skill('s-11', 'Aspen Plus', 'tool'),
    skill('s-12', 'machine learning', 'technical'),
    skill('s-13', 'customer discovery', 'business'),
  ]

  const preferences: EvidencePreference[] = [
    preference('p-1', 'industry', 'chemicals, materials, energy and advanced manufacturing', 1),
    preference('p-2', 'work', 'technical work close to a plant or a lab', 0.9),
    preference('p-3', 'work', 'applying AI to industrial processes', 0.8),
    preference('p-4', 'environment', 'small teams with real ownership', 0.7),
  ]

  return { ...emptyBank(), experiences, facts, skills, preferences }
}

/**
 * The founder's stated direction, in their own words, from the audit
 * (docs/JOB_DISCOVERY_V2_AUDIT.md §0). Location is deliberately absent: the
 * audit's finding was that the system's built-in geography outranked the user's
 * stated intent, and a benchmark that re-introduces it would grade the bug as
 * correct.
 */
export const RECALL_DIRECTION =
  'Chemical and process engineering internships — plant, process development, materials, ' +
  'energy and manufacturing roles, including AI applied to industrial processes. ' +
  'I do not care about location or which company.'

/**
 * The mission the suite runs as.
 *
 * IT KEEPS THE SHIPPED HARD CONSTRAINTS, deliberately and with the consequence
 * stated: `defaultMission` carries `DEFAULT_HARD_CONSTRAINTS` (lib/career/
 * missions/store.ts) — internships only, not a different season, and
 * `location_country in ['US','United States','']`. Recall is measured on what
 * discovery FOUND, so those filters cannot flatter it; but they do decide what
 * reaches the top 50, and on the current corpus they drop five entries
 * discovery found (three outside the US, one whose season parses as another
 * term, one whose country does not resolve).
 *
 * Those five are printed BY NAME with the constraint that removed them on every
 * run, because "found 42, retained 37" is exactly the shape a filter regression
 * hides inside. This is not a contradiction of RECALL_DIRECTION below: the
 * direction is what the user says they want, and it stays free of geography
 * because the audit's finding was that built-in geography outranked stated
 * intent. The hard constraints are the product's own defaults, kept so the
 * suite measures the product as it ships rather than a friendlier variant of
 * it. Pass `hard_constraints: []` in the overrides to measure without them.
 */
export function recallMission(overrides: Partial<CareerMission> = {}): CareerMission {
  const base = defaultMission(USER)
  return {
    ...base,
    id: 'recall-mission',
    created_at: NOW,
    updated_at: NOW,
    preferences: { ...base.preferences, direction: RECALL_DIRECTION },
    ...overrides,
  }
}
