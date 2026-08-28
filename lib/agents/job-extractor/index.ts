// Job Extractor Agent.
//
// Judgment problem it owns: "what does this posting actually require, and is
// it a Summer 2027 internship?" (docs/CAREER_OS.md §3). Interpretation of
// unstructured JD text into structured fields — a classification, not a tool
// loop, so it is one forced-tool call through anthropicStructured on the cheap
// tier, cached by the hash of the text. The same posting is never paid for
// twice; a prompt bump re-extracts everything, which is what you want.
//
// It returns an AgentResult so recordAgentRun works on it unchanged: the trace
// is built here the way runtime/loop.ts builds it, with steps = 1 and no tools.

import crypto from 'crypto'
import { anthropicStructured, anthropicUsage } from '@/lib/providers/anthropic/client'
import { modelForTier } from '@/lib/ai/models'
import { normalizeModelText } from '../runtime/text'
import type { AgentResult, ToolContext } from '../runtime/types'
import type { EmploymentType, ExtractedJobFields, SeasonRelevance, WorkMode } from '@/lib/career/types'
import { jobExtractorPrompt, TEXT_CAP, type JobExtractorInput } from './prompt'

export { jobExtractorPrompt }
export type { JobExtractorInput }

export interface JobExtraction extends ExtractedJobFields {
  /** Two sentences: what the role is and who it is for. */
  summary: string
}

const EMPLOYMENT_TYPES: EmploymentType[] = ['internship', 'co_op', 'full_time', 'part_time', 'contract', 'other', 'unknown']
const SEASONS: SeasonRelevance[] = ['summer_2027', 'other_season', 'unspecified', 'unknown']
const WORK_MODES: WorkMode[] = ['remote', 'hybrid', 'onsite', 'unknown']

const LIST_CAP = 12

export const OUTPUT_SCHEMA = {
  properties: {
    employment_type: { type: 'string', enum: EMPLOYMENT_TYPES },
    season_relevance: { type: 'string', enum: SEASONS },
    work_mode: { type: 'string', enum: WORK_MODES },
    role_family: { type: ['string', 'null'] },
    location_raw: { type: ['string', 'null'] },
    deadline: { type: ['string', 'null'], description: 'As written.' },
    compensation: { type: ['string', 'null'], description: 'As written.' },
    min_qualifications: { type: 'array', items: { type: 'string' }, description: 'Required. Short phrases, ≤12.' },
    preferred_qualifications: { type: 'array', items: { type: 'string' }, description: 'Nice to have. Short phrases, ≤12.' },
    graduation_eligibility: { type: ['string', 'null'], description: 'VERBATIM sentence about the graduation / enrollment window.' },
    work_authorization: { type: ['string', 'null'], description: 'VERBATIM sentence about visas, sponsorship, citizenship, or authorization.' },
    skills: { type: 'array', items: { type: 'string' } },
    responsibilities: { type: 'array', items: { type: 'string' } },
    industry: { type: ['string', 'null'] },
    appears_closed: { type: 'boolean' },
    confidence: { type: 'number', description: '0-1.' },
    summary: { type: 'string', description: 'Two sentences.' },
  },
  required: [
    'employment_type', 'season_relevance', 'work_mode', 'role_family', 'location_raw', 'deadline',
    'compensation', 'min_qualifications', 'preferred_qualifications', 'graduation_eligibility',
    'work_authorization', 'skills', 'responsibilities', 'industry', 'appears_closed', 'confidence', 'summary',
  ],
}

function shortStrings(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return null
    const s = normalizeModelText(x)
    if (s) out.push(s.length > 160 ? s.slice(0, 160) : s)
  }
  return out.slice(0, LIST_CAP)
}

function nullableText(v: unknown): string | null | undefined {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = normalizeModelText(v)
  return s ? s : null
}

/**
 * Rejects (null) rather than repairs. Enums must be exact — a misspelled
 * season is a retry, never a coercion to "unknown", because "unknown" is a
 * real answer with real downstream consequences. Exported for the offline test.
 */
export function validate(raw: unknown): JobExtraction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const employment = r.employment_type as EmploymentType
  const season = r.season_relevance as SeasonRelevance
  const mode = r.work_mode as WorkMode
  if (!EMPLOYMENT_TYPES.includes(employment) || !SEASONS.includes(season) || !WORK_MODES.includes(mode)) return null
  if (typeof r.appears_closed !== 'boolean') return null
  if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) return null

  const minQ = shortStrings(r.min_qualifications)
  const prefQ = shortStrings(r.preferred_qualifications)
  const skills = shortStrings(r.skills)
  const resp = shortStrings(r.responsibilities)
  if (!minQ || !prefQ || !skills || !resp) return null

  const fields = {
    role_family: nullableText(r.role_family),
    location_raw: nullableText(r.location_raw),
    deadline: nullableText(r.deadline),
    compensation: nullableText(r.compensation),
    graduation_eligibility: nullableText(r.graduation_eligibility),
    work_authorization: nullableText(r.work_authorization),
    industry: nullableText(r.industry),
  }
  for (const v of Object.values(fields)) if (v === undefined) return null

  const summary = normalizeModelText(r.summary)
  if (!summary) return null

  return {
    employment_type: employment,
    season_relevance: season,
    work_mode: mode,
    role_family: fields.role_family as string | null,
    location_raw: fields.location_raw as string | null,
    deadline: fields.deadline as string | null,
    compensation: fields.compensation as string | null,
    min_qualifications: minQ,
    preferred_qualifications: prefQ,
    graduation_eligibility: fields.graduation_eligibility as string | null,
    work_authorization: fields.work_authorization as string | null,
    skills,
    responsibilities: resp,
    industry: fields.industry as string | null,
    appears_closed: r.appears_closed,
    confidence: r.confidence,
    summary,
  }
}

export function textHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
}

const AGENT_ID = 'job_extractor'
const TIER = 'cheap' as const

export async function runJobExtractor(input: JobExtractorInput, _ctx: ToolContext): Promise<AgentResult<JobExtraction>> {
  const started = Date.now()
  const text = input.text.length > TEXT_CAP ? input.text.slice(0, TEXT_CAP) : input.text
  const { system, user } = jobExtractorPrompt.build({ ...input, text })

  // The cache is keyed on the text, not the request. Two sources handing us
  // the same description share one extraction, and a title tweak on the
  // aggregator copy does not re-pay.
  const key = { text: textHash(text), prompt_version: jobExtractorPrompt.version }
  const cachedBefore = anthropicUsage().cachedCalls

  const res = await anthropicStructured<JobExtraction>({
    role: 'fast',
    tier: TIER,
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 3000,
    schemaName: 'extract_job_fields',
    schemaDescription: 'Structured fields extracted from one job posting.',
    schema: OUTPUT_SCHEMA,
    validate,
    cacheKeyParts: key,
    cacheNamespace: `agent_${AGENT_ID}`,
  })

  // A replayed StructuredResult still carries its ORIGINAL usage; the only
  // signal anthropicStructured gives is the cachedCalls counter. A replay must
  // read zero cost here or every cost-per-job figure inflates on re-run.
  const fromCache = anthropicUsage().cachedCalls > cachedBefore

  return {
    output: res.value,
    status: res.value ? 'succeeded' : /schema validation/i.test(res.error ?? '') ? 'invalid_output' : 'failed',
    error: res.value ? null : (res.error ?? 'extraction failed'),
    evidence: [],
    trace: {
      agent_id: AGENT_ID,
      prompt_version: jobExtractorPrompt.version,
      model: res.model || modelForTier(TIER),
      model_role: 'fast',
      provider_id: 'anthropic',
      tools_called: [],
      web_searches: 0,
      tokens_in: fromCache ? 0 : res.usage.inputTokens,
      tokens_out: fromCache ? 0 : res.usage.outputTokens,
      cost_usd: fromCache ? 0 : res.usage.costUsd,
      latency_ms: Date.now() - started,
      steps: 1,
      ...(fromCache ? { from_cache: true } : {}),
    },
  }
}
