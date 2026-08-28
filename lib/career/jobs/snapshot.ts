// Job snapshots — the description as it was when we saw it.
//
// An application points at one snapshot forever (docs/CAREER_OS.md §4): if the
// company edits the posting after you apply, the package you built still
// matches what you read. The sha is over the description text alone so a
// re-fetch that changes nothing writes nothing.

import crypto from 'crypto'
import type { JobOpportunity } from '../types'
import type { NormalizedJob } from './normalize'

export interface SnapshotInput {
  title: string
  company_name: string
  location_raw: string | null
  canonical_url: string | null
  description_text: string | null
  structured: Record<string, unknown>
  sha256: string
}

type SnapshotSource = Pick<
  JobOpportunity,
  | 'title' | 'company_name' | 'location_raw' | 'canonical_url' | 'description_text' | 'employment_type' | 'season_relevance'
  | 'work_mode' | 'role_family' | 'min_qualifications' | 'preferred_qualifications' | 'graduation_eligibility'
  | 'work_authorization' | 'skills' | 'responsibilities' | 'compensation' | 'deadline' | 'industry'
>

export function descriptionSha(text: string | null | undefined): string {
  return crypto.createHash('sha256').update((text ?? '').replace(/\s+/g, ' ').trim()).digest('hex')
}

export function buildSnapshot(job: SnapshotSource | NormalizedJob): SnapshotInput {
  return {
    title: job.title,
    company_name: job.company_name,
    location_raw: job.location_raw,
    canonical_url: job.canonical_url,
    description_text: job.description_text,
    structured: {
      employment_type: job.employment_type,
      season_relevance: job.season_relevance,
      work_mode: job.work_mode,
      role_family: job.role_family,
      min_qualifications: job.min_qualifications,
      preferred_qualifications: job.preferred_qualifications,
      graduation_eligibility: job.graduation_eligibility,
      work_authorization: job.work_authorization,
      skills: job.skills,
      responsibilities: job.responsibilities,
      compensation: job.compensation,
      deadline: job.deadline,
      industry: job.industry,
    },
    sha256: descriptionSha(job.description_text),
  }
}
