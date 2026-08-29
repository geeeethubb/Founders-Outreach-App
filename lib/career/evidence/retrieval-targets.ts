// Adapters from the shapes the Career OS already has (a stored job, a tailor
// job, a cover-letter job) to a RetrievalTarget. Pure.

import type { RetrievalTarget } from './retrieval-types'
import type { JobOpportunity } from '../types'

type JobLike = Pick<JobOpportunity, 'title' | 'company_name'> &
  Partial<Pick<JobOpportunity, 'description_text' | 'skills' | 'responsibilities' | 'min_qualifications' | 'preferred_qualifications' | 'industry'>>

/** A stored job: title + company, the posting as description, skills/industry as keywords. */
export function retrievalTargetForJob(job: JobLike): RetrievalTarget {
  const description = [
    job.description_text ?? '',
    ...(job.responsibilities ?? []),
    ...(job.min_qualifications ?? []),
    ...(job.preferred_qualifications ?? []),
  ].filter((s) => s.trim()).join('\n')
  const keywords = [...(job.skills ?? []), ...(job.industry ? [job.industry] : [])]
  return { kind: 'job', title: job.title, company: job.company_name, description, keywords }
}

/** The tailor's job shape. */
export function retrievalTargetForTailorJob(job: { title: string; company: string; key_requirements: string[]; responsibilities: string[]; description_excerpt: string }): RetrievalTarget {
  return {
    kind: 'job',
    title: job.title,
    company: job.company,
    description: [job.description_excerpt, ...job.responsibilities].filter(Boolean).join('\n'),
    keywords: job.key_requirements,
  }
}

/** The cover-letter job shape. */
export function retrievalTargetForLetterJob(job: { title: string; company: string; summary: string; postingText?: string | null }): RetrievalTarget {
  return { kind: 'job', title: job.title, company: job.company, description: [job.summary, job.postingText ?? ''].filter(Boolean).join('\n') }
}
