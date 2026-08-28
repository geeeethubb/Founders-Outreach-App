// Hard constraints — the mission's non-negotiables, applied by code.
//
// A constraint is data on the mission row (`hard_constraints`), so "US only"
// or "internships only" is an edit, not a deploy. Failures are returned with
// the constraint's label so the UI can say WHICH rule excluded a job — a
// filter that hides its reasons trains the operator to distrust it.

import type { HardConstraint, JobOpportunity } from '../types'
import type { NormalizedJob } from './normalize'

type FilterableJob = Pick<
  JobOpportunity,
  'employment_type' | 'season_relevance' | 'location_country' | 'location_tier' | 'work_mode' | 'role_family' | 'company_name' | 'title'
>

export interface ConstraintResult {
  pass: boolean
  failed: { label: string; reason: string }[]
}

function valueFor(job: FilterableJob, dimension: string): string {
  switch (dimension) {
    case 'employment_type': return job.employment_type ?? ''
    case 'season': case 'season_relevance': return job.season_relevance ?? ''
    case 'location_country': case 'country': return job.location_country ?? ''
    case 'location_tier': case 'tier': return job.location_tier == null ? '' : String(job.location_tier)
    case 'work_mode': return job.work_mode ?? ''
    case 'role_family': return job.role_family ?? ''
    case 'company_name': case 'company': return job.company_name ?? ''
    case 'title': return job.title ?? ''
    default: return ''
  }
}

const norm = (s: string) => s.trim().toLowerCase()

function asList(v: string | string[]): string[] {
  return (Array.isArray(v) ? v : [v]).map(norm)
}

/** Evaluate one constraint. Unknown dimensions PASS: a constraint we cannot read must not silently drop jobs. */
export function evaluateConstraint(job: FilterableJob, c: HardConstraint): { pass: boolean; reason: string } {
  const known = ['employment_type', 'season', 'season_relevance', 'location_country', 'country', 'location_tier', 'tier', 'work_mode', 'role_family', 'company_name', 'company', 'title']
  if (!known.includes(c.dimension)) return { pass: true, reason: `dimension "${c.dimension}" is not evaluated by code` }
  const actual = norm(valueFor(job, c.dimension))
  const wanted = asList(c.value)
  const shown = actual || '(empty)'
  switch (c.operator) {
    case 'equals': return { pass: actual === wanted[0], reason: `${c.dimension} is ${shown}, wanted ${wanted[0]}` }
    case 'not_equals': return { pass: actual !== wanted[0], reason: `${c.dimension} is ${shown}` }
    case 'in': return { pass: wanted.includes(actual), reason: `${c.dimension} is ${shown}, not one of ${wanted.join('/')}` }
    case 'not_in': return { pass: !wanted.includes(actual), reason: `${c.dimension} is ${shown}` }
    case 'contains': return { pass: wanted.some((w) => actual.includes(w)), reason: `${c.dimension} "${shown}" does not contain ${wanted.join('/')}` }
    case 'before': case 'after': {
      // Only meaningful for numeric tiers here; dates belong to the fit evaluator.
      const a = Number(actual)
      const b = Number(wanted[0])
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { pass: true, reason: `${c.dimension} not comparable` }
      const ok = c.operator === 'before' ? a < b : a > b
      return { pass: ok, reason: `${c.dimension} is ${a}, not ${c.operator} ${b}` }
    }
    default: return { pass: true, reason: 'unknown operator' }
  }
}

export function applyHardConstraints(job: FilterableJob | NormalizedJob, constraints: HardConstraint[]): ConstraintResult {
  const failed: { label: string; reason: string }[] = []
  for (const c of constraints) {
    const r = evaluateConstraint(job, c)
    if (!r.pass) failed.push({ label: c.label, reason: r.reason })
  }
  return { pass: failed.length === 0, failed }
}

/** Internship, co-op, or a title/season that says so — the cheap "is this even the right kind of job" check. */
export function isInternshipLike(job: Pick<JobOpportunity, 'employment_type' | 'title'>): boolean {
  if (job.employment_type === 'internship' || job.employment_type === 'co_op') return true
  if (job.employment_type === 'full_time' || job.employment_type === 'contract' || job.employment_type === 'part_time') return false
  return /\b(intern|internship|co-?op|summer analyst)\b/i.test(job.title)
}
