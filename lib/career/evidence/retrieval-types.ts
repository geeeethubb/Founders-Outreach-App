// Retrieval contract — the one way agents ask "what about this user is
// relevant to X?". Implemented in retrieval.ts; consumed by People Scout,
// positioning, fit, matching, tailoring, cover letters and company research.
//
// Retrieval is deterministic (lexical scoring over canonical rows). It returns
// a bounded, ranked slice of the bank with provenance and confidence attached,
// never the whole bank (CLAUDE.md principle 5).

import type {
  EvidenceBank, EvidenceExperience, EvidenceFact, EvidenceMetric, EvidenceProject,
  EvidenceSkill, EvidenceStory, MergeStatus,
} from '@/lib/career/types'

export type RetrievalTargetKind = 'job' | 'person' | 'company' | 'generic'

export interface RetrievalTarget {
  kind: RetrievalTargetKind
  /** Job title, person's title, or a short label. */
  title?: string | null
  company?: string | null
  /** Job description, person/company context, or any free text about the target. */
  description?: string | null
  /** Extra terms the caller already knows matter (industry, tools, location). */
  keywords?: string[]
}

export interface RetrievalInput {
  bank: EvidenceBank
  /** The user's goal in plain words (job mission text, outreach mission goal). */
  mission?: string | null
  target?: RetrievalTarget | null
  maxExperiences?: number   // default 4
  maxFacts?: number         // default 8 (across all returned experiences)
  includeStories?: boolean  // default false
  includeMetrics?: boolean  // default true
  includeSkills?: boolean   // default true
}

export interface RelevantFact {
  fact: EvidenceFact
  score: number
  reasons: string[]
  /** Labels of every source that supports this fact ("Zuyu_Resume.docx ¶6", "LinkedIn export L350"). */
  sourceLabels: string[]
  support_count: number
  status: MergeStatus
}

export interface RelevantExperience {
  experience: EvidenceExperience
  organization: string       // canonical organization name
  roleTitle: string
  period: string             // "5/2026 – 8/2026" or "" when unknown
  /** canonical_summary when present, else a deterministic one-liner from its top facts. */
  summary: string
  score: number
  reasons: string[]
  facts: RelevantFact[]
  metrics: EvidenceMetric[]
  projects: EvidenceProject[]
  status: MergeStatus
  sourceLabels: string[]
}

export interface RelevantEvidence {
  experiences: RelevantExperience[]
  /** The same facts as inside `experiences`, flattened and ranked, plus unattached facts. */
  facts: RelevantFact[]
  skills: EvidenceSkill[]
  stories: EvidenceStory[]
  query: string[]
  stats: {
    experiencesConsidered: number
    factsConsidered: number
    experiencesReturned: number
    factsReturned: number
    tombstonesSkipped: number
  }
}

/** The outreach loop's proof-point shape (lib/agents/positioning/prompt.ts BackgroundItem). */
export interface BackgroundItemLike {
  id: string
  kind: 'experience' | 'project' | 'award' | 'education'
  title: string
  org: string
  period: string
  summary: string
  domains: string[]
  credibility: 'strong' | 'moderate' | 'supporting'
}
