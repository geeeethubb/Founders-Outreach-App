// Job Verifier Agent.
//
// Judgment problem it owns: "does this page say the job is still open?" —
// and ONLY for pages where deterministic signals are ambiguous
// (docs/CAREER_OS.md §3, §5). ATS API presence is VERIFIED_OPEN and a 404 or an
// explicit closed banner is CLOSED without a model in the loop; this agent is
// the tie-breaker for a 200 with unclear text. One cheap forced-tool call,
// cached on the page text so a re-verify of an unchanged page is free.

import crypto from 'crypto'
import { anthropicStructured, anthropicUsage } from '@/lib/providers/anthropic/client'
import { modelForTier } from '@/lib/ai/models'
import { normalizeModelText } from '../runtime/text'
import type { AgentResult, ToolContext } from '../runtime/types'
import { jobVerifierPrompt, PAGE_TEXT_CAP, type JobVerifierInput } from './prompt'

export { jobVerifierPrompt }
export type { JobVerifierInput }

export type VerifierVerdict = 'OPEN' | 'CLOSED' | 'UNCLEAR'
const VERDICTS: VerifierVerdict[] = ['OPEN', 'CLOSED', 'UNCLEAR']

export interface JobVerification {
  verdict: VerifierVerdict
  reasoning: string
  /** Phrases quoted from the page that indicate closure. Empty when OPEN. */
  closed_signals: string[]
}

export const OUTPUT_SCHEMA = {
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    reasoning: { type: 'string', description: 'At most two sentences.' },
    closed_signals: { type: 'array', items: { type: 'string' }, description: 'Exact phrases from the page. Empty if none.' },
  },
  required: ['verdict', 'reasoning', 'closed_signals'],
}

/** Rejects (null) rather than repairs. Exported for the offline test. */
export function validate(raw: unknown): JobVerification | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const verdict = r.verdict as VerifierVerdict
  if (!VERDICTS.includes(verdict)) return null
  if (!Array.isArray(r.closed_signals) || r.closed_signals.some((s) => typeof s !== 'string')) return null
  const reasoning = normalizeModelText(r.reasoning)
  if (!reasoning) return null
  return {
    verdict,
    reasoning,
    closed_signals: (r.closed_signals as string[]).map((s) => normalizeModelText(s)).filter(Boolean).slice(0, 8),
  }
}

const AGENT_ID = 'job_verifier'
const TIER = 'cheap' as const

export async function runJobVerifier(input: JobVerifierInput, _ctx: ToolContext): Promise<AgentResult<JobVerification>> {
  const started = Date.now()
  const pageText = input.page_text.length > PAGE_TEXT_CAP ? input.page_text.slice(0, PAGE_TEXT_CAP) : input.page_text
  const { system, user } = jobVerifierPrompt.build({ ...input, page_text: pageText })
  const cachedBefore = anthropicUsage().cachedCalls

  const res = await anthropicStructured<JobVerification>({
    role: 'fast',
    tier: TIER,
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 800,
    schemaName: 'verify_job_open',
    schemaDescription: 'Whether the page shows the job as open.',
    schema: OUTPUT_SCHEMA,
    validate,
    // Keyed on the page as fetched, plus the job identity — the same careers
    // listing page is asked about different roles.
    cacheKeyParts: {
      page: crypto.createHash('sha256').update(pageText).digest('hex').slice(0, 32),
      url: input.url,
      title: input.title,
      status: input.fetched_status,
      prompt_version: jobVerifierPrompt.version,
    },
    cacheNamespace: `agent_${AGENT_ID}`,
  })

  // A replayed StructuredResult keeps its original usage; the cachedCalls
  // counter is the only signal. A replay must read zero cost (ADR-015).
  const fromCache = anthropicUsage().cachedCalls > cachedBefore

  return {
    output: res.value,
    status: res.value ? 'succeeded' : /schema validation/i.test(res.error ?? '') ? 'invalid_output' : 'failed',
    error: res.value ? null : (res.error ?? 'verification failed'),
    evidence: [],
    trace: {
      agent_id: AGENT_ID,
      prompt_version: jobVerifierPrompt.version,
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
