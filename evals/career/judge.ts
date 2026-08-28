// LLM judges for the Career OS evals (docs/CAREER_OS.md §9).
//
// DELIBERATELY INDEPENDENT of the product agents, in the same way
// evals/agentic/judge.ts is independent of the scorer:
//   - a different framing ("would you tell this student to apply?", "would a
//     hiring manager who knows the company find this letter specific?")
//   - never shown component scores, totals, ranks, fit weights, the tailor's
//     reasoning or the verifier's verdicts
//   - single-shot `anthropicStructured`, no tools, no web search — a judge that
//     could research would be judging a better-informed candidate than the one
//     the pipeline produced
//
// Every judge validates COVERAGE: a batch that skips an item returns null so
// the call retries, because a silently shrunk denominator inflates precision.
// Results are cached per input content; a failure is never cached.

import { anthropicStructured } from '@/lib/providers/anthropic/client'
import { normalizeModelText } from '@/lib/agents/runtime/text'

export const JOB_JUDGE_VERSION = '1.0.0'
export const LETTER_JUDGE_VERSION = '1.0.0'
export const FAITHFULNESS_JUDGE_VERSION = '1.0.0'

// ─── Job relevance ───────────────────────────────────────────────────────────

export type JobVerdict = 'GOOD_FIT' | 'STRETCH' | 'BAD_FIT'
const JOB_VERDICTS = new Set<string>(['GOOD_FIT', 'STRETCH', 'BAD_FIT'])

export interface JudgeJobInput {
  job_id: string
  company: string
  title: string
  location: string | null
  /** The description as the pipeline saw it, trimmed by the caller. */
  description: string
}

export interface JobJudgement {
  job_id: string
  verdict: JobVerdict
  reasoning: string
}

/**
 * Judge every job, in batches of ≤10 so one truncated response loses ten
 * verdicts rather than all of them, and the caller is told how many are
 * missing.
 */
export async function judgeJobRelevance(
  mission: string,
  background: string,
  jobs: JudgeJobInput[]
): Promise<{ results: JobJudgement[]; costUsd: number; error?: string }> {
  if (jobs.length === 0) return { results: [], costUsd: 0 }

  const BATCH = 10
  if (jobs.length > BATCH) {
    const results: JobJudgement[] = []
    const errors: string[] = []
    let costUsd = 0
    for (let i = 0; i < jobs.length; i += BATCH) {
      const r = await judgeJobRelevance(mission, background, jobs.slice(i, i + BATCH))
      results.push(...r.results)
      costUsd += r.costUsd
      if (r.error) errors.push(`batch ${i / BATCH + 1}: ${r.error}`)
    }
    return {
      results,
      costUsd,
      ...(results.length < jobs.length
        ? { error: `only ${results.length}/${jobs.length} jobs judged — ${errors.join('; ') || 'unknown'}` }
        : {}),
    }
  }

  const system = `You are a university career advisor who has spent years placing engineering undergraduates in
internships. A student brings you a list of postings a search tool found. For each one, say whether
you would tell them to spend an evening applying.

  GOOD_FIT   Apply. The role is genuinely open to this student (right season, right level, they
             can meet the stated eligibility), the work maps onto things they have actually done,
             and the location and company match what they said they wanted.
  STRETCH    Worth applying, with honest odds. Eligible, but the role asks for something the
             student only partly has — a language, a lab technique, a domain — or sits at the
             edge of their stated preferences. Missing PREFERRED qualifications is a STRETCH at
             most, never a BAD_FIT.
  BAD_FIT    Do not apply. The student cannot meet a hard requirement (wrong season, wrong
             degree level, a required certification or clearance they lack, a graduation date
             they cannot satisfy, a country they cannot work in), or the work is unrelated to
             anything in their background.

Read the whole posting. The disqualifier is usually one line in the minimum qualifications or the
eligibility section, and an attractive title above it does not change the answer. Do not reward
keyword overlap; reward overlap in the actual work. Do not penalize a small or unfamiliar company.`

  const list = jobs
    .map(
      (j, i) =>
        `── JOB ${i + 1} (id: ${j.job_id})\nCompany: ${j.company}\nTitle: ${j.title}\nLocation: ${j.location ?? 'unknown'}\n${j.description}`
    )
    .join('\n\n')

  const res = await anthropicStructured<JobJudgement[]>({
    role: 'reasoning',
    system,
    messages: [
      {
        role: 'user',
        content: `WHAT THE STUDENT IS LOOKING FOR\n${mission}\n\nTHE STUDENT'S BACKGROUND\n${background}\n\nPOSTINGS\n${list}\n\nGive a verdict for every posting, by id, with one or two sentences of reasoning.`,
      },
    ],
    maxTokens: 4000,
    schemaName: 'submit_job_verdicts',
    schemaDescription: 'One verdict per posting.',
    schema: {
      properties: {
        verdicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              job_id: { type: 'string' },
              verdict: { type: 'string', enum: ['GOOD_FIT', 'STRETCH', 'BAD_FIT'] },
              reasoning: { type: 'string' },
            },
            required: ['job_id', 'verdict', 'reasoning'],
          },
        },
      },
      required: ['verdicts'],
    },
    validate: (raw) => {
      const r = raw as { verdicts?: unknown[] }
      if (!Array.isArray(r?.verdicts)) return null
      const valid = new Set(jobs.map((j) => j.job_id))
      const seen = new Set<string>()
      const out: JobJudgement[] = []
      for (const entry of r.verdicts) {
        const j = entry as Record<string, unknown>
        const id = String(j.job_id ?? '')
        const verdict = String(j.verdict ?? '').toUpperCase()
        // Invented ids and duplicates are dropped, never repaired.
        if (!valid.has(id) || seen.has(id) || !JOB_VERDICTS.has(verdict)) continue
        seen.add(id)
        out.push({ job_id: id, verdict: verdict as JobVerdict, reasoning: normalizeModelText(j.reasoning) })
      }
      return jobs.every((j) => seen.has(j.job_id)) ? out : null
    },
    cacheKeyParts: {
      v: JOB_JUDGE_VERSION,
      mission,
      background,
      jobs: jobs.map((j) => `${j.job_id}|${j.company}|${j.title}|${j.location}|${j.description}`),
    },
    cacheNamespace: 'career_judge_jobs',
  })

  return { results: res.value ?? [], costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}

// ─── Cover letter quality ────────────────────────────────────────────────────

export const LETTER_DIMENSIONS = [
  'company_specificity',
  'truthfulness',
  'growth_narrative',
  'professionalism',
  'non_repetition',
  'filler_absence',
] as const
export type LetterDimension = (typeof LETTER_DIMENSIONS)[number]

export interface LetterJudgement {
  scores: Record<LetterDimension, number>
  justifications: Record<LetterDimension, string>
  /** Sentences the judge believes are not supported by the résumé or the grounded points. */
  suspect_claims: string[]
}

/**
 * Judge one cover letter. `groundedPoints` are the company facts the writer
 * was allowed to use, so truthfulness is judged against a known pool rather
 * than against the judge's own beliefs about the company.
 */
export async function judgeCoverLetter(
  letter: string,
  jobSummary: string,
  resumeText: string,
  groundedPoints: string[]
): Promise<{ result: LetterJudgement | null; costUsd: number; error?: string }> {
  const system = `You are a hiring manager at the company described below, reading a cover letter from an
undergraduate applying for an internship. You have the applicant's résumé and the short list of
facts about your company that the applicant could legitimately have known. Score the letter on
six dimensions from 0 to 1, each with a one-sentence justification.

  company_specificity  Could this letter only have been written to THIS company and role? 1.0 means
                       it names specific problems, products or facts from the provided list and
                       connects them to the applicant; 0.0 means the company name could be swapped
                       without changing a sentence.
  truthfulness         Does every claim about the applicant appear in the résumé, and every claim
                       about the company appear in the provided facts? Deduct for each claim that
                       does not, and list those sentences in suspect_claims. 1.0 only when nothing
                       is unsupported.
  growth_narrative     Does the letter say what the applicant wants to learn and become, and why
                       this role is the next step, rather than only listing what they have done?
  professionalism      Tone, structure, length, no errors, no sycophancy.
  non_repetition       Does the letter avoid restating the résumé line by line or saying the same
                       thing twice in different words?
  filler_absence       Absence of empty phrases ("I am passionate about", "fast-paced environment",
                       "I believe I would be a great fit") and of generic praise for the company.

Be strict. A polished letter that could go to any company scores low on company_specificity no
matter how well written. A letter that invents a company detail not in the list scores low on
truthfulness even if the detail happens to be true.`

  const user = `THE ROLE
${jobSummary}

FACTS ABOUT THE COMPANY THE APPLICANT WAS GIVEN
${groundedPoints.length ? groundedPoints.map((p) => `- ${p}`).join('\n') : '(none)'}

THE APPLICANT'S RÉSUMÉ
${resumeText}

THE COVER LETTER
${letter}`

  const res = await anthropicStructured<LetterJudgement>({
    role: 'reasoning',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2500,
    schemaName: 'submit_letter_scores',
    schemaDescription: 'Six 0–1 scores with justifications, plus suspect claims.',
    schema: {
      properties: {
        scores: {
          type: 'object',
          properties: Object.fromEntries(LETTER_DIMENSIONS.map((d) => [d, { type: 'number' }])),
          required: [...LETTER_DIMENSIONS],
        },
        justifications: {
          type: 'object',
          properties: Object.fromEntries(LETTER_DIMENSIONS.map((d) => [d, { type: 'string' }])),
          required: [...LETTER_DIMENSIONS],
        },
        suspect_claims: { type: 'array', items: { type: 'string' } },
      },
      required: ['scores', 'justifications', 'suspect_claims'],
    },
    validate: (raw) => {
      const r = raw as { scores?: Record<string, unknown>; justifications?: Record<string, unknown>; suspect_claims?: unknown }
      if (!r?.scores || !r?.justifications) return null
      const scores = {} as Record<LetterDimension, number>
      const justifications = {} as Record<LetterDimension, string>
      for (const d of LETTER_DIMENSIONS) {
        const s = r.scores[d]
        // A missing or out-of-range dimension is a rejected response, not a
        // clamped one: the retry costs less than a silently wrong number.
        if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1) return null
        scores[d] = s
        justifications[d] = normalizeModelText(r.justifications[d])
      }
      const suspect = Array.isArray(r.suspect_claims)
        ? r.suspect_claims.map((c) => normalizeModelText(c)).filter(Boolean)
        : []
      return { scores, justifications, suspect_claims: suspect }
    },
    cacheKeyParts: { v: LETTER_JUDGE_VERSION, letter, jobSummary, resumeText, groundedPoints },
    cacheNamespace: 'career_judge_letter',
  })

  return { result: res.value, costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}

// ─── Bullet faithfulness ─────────────────────────────────────────────────────

export interface FaithfulnessJudgement {
  faithful: boolean
  /** Each issue names the unsupported or distorted piece of the proposed text. */
  issues: string[]
}

/**
 * A second, independent check on a tailored bullet, used by the factuality
 * eval to catch verifier misses. It is asked a blunter question than the
 * verifier ("would you let a student put this on their résumé, given only
 * these facts?") and sees only the two texts and the raw fact statements —
 * never fact ids, clauses, or the verifier's output.
 */
export async function judgeBulletFaithfulness(
  original: string,
  proposed: string,
  facts: string[]
): Promise<{ result: FaithfulnessJudgement | null; costUsd: number; error?: string }> {
  const system = `You are a careful résumé reviewer at a university career center. A student's résumé bullet was
rewritten to target a job. You have the original bullet, the rewritten bullet, and the complete list
of facts the student has documented about that experience. Nothing outside that list is known to be
true.

Decide whether the rewritten bullet is FAITHFUL: every number, tool, title, scope of responsibility,
outcome and claim of ownership in it is directly supported by the facts or by the original bullet.

It is NOT faithful if it:
  - introduces a number, percentage, dollar figure or count that appears in neither
  - names a tool, software, standard or certification that appears in neither
  - changes a title or upgrades a role (coordinator → manager, intern → engineer)
  - turns coordination or contribution into ownership or leadership
  - merges two separate efforts into one
  - states a business result (revenue, savings realized, a closed deal) that the facts only
    describe as projected, targeted or in progress
  - adds a skill the facts never demonstrate

Rewording, reordering, tightening and emphasizing existing material are all fine. List every
issue you find as a short phrase quoting the offending words. If there are none, faithful is true
and issues is empty.`

  const user = `DOCUMENTED FACTS
${facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(none)'}

ORIGINAL BULLET
${original}

REWRITTEN BULLET
${proposed}`

  const res = await anthropicStructured<FaithfulnessJudgement>({
    role: 'reasoning',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 1200,
    schemaName: 'submit_faithfulness',
    schemaDescription: 'Whether the rewritten bullet is faithful, and each issue if not.',
    schema: {
      properties: {
        faithful: { type: 'boolean' },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['faithful', 'issues'],
    },
    validate: (raw) => {
      const r = raw as { faithful?: unknown; issues?: unknown }
      if (typeof r?.faithful !== 'boolean' || !Array.isArray(r.issues)) return null
      const issues = r.issues.map((i) => normalizeModelText(i)).filter(Boolean)
      // "Not faithful" with nothing to point at is an unusable verdict: the eval
      // reports issues, and an empty list would read as a pass.
      if (!r.faithful && issues.length === 0) return null
      return { faithful: r.faithful, issues }
    },
    cacheKeyParts: { v: FAITHFULNESS_JUDGE_VERSION, original, proposed, facts },
    cacheNamespace: 'career_judge_faithfulness',
  })

  return { result: res.value, costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}
