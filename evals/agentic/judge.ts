// LLM-as-judge for Precision@20 — and for the three agent-level quality evals.
//
// DELIBERATELY INDEPENDENT of the scoring agent:
//   - different system prompt, different framing, different rubric vocabulary
//   - the judge NEVER sees component scores, totals, ranks, or the scorer's prose
//   - it is asked a different question: "would I send this person a thoughtful
//     email?" rather than "score these dimensions"
//
// If the judge saw the scores it would anchor on them, and Precision@20 would
// measure self-consistency instead of quality.
//
// Runs on Anthropic like everything else in this phase, but through
// `anthropicStructured` rather than the agent loop: a judge that could search
// the web would be evaluating a different, better-informed candidate than the
// one the pipeline actually produced.

import { anthropicStructured } from '@/lib/providers/anthropic/client'

// 3.0.0 — splits GOOD into HIGH_EVIDENCE and ROLE_BASED.
//
// v2.0.0 contained a measurement bug: it told the judge "if nothing specific is
// known about someone, they cannot be GOOD". That conflated *we could not find
// much about this person* with *this person is a bad target*, and those are
// different claims. Audit of the chemical/manufacturing profile found 5 of 11
// MAYBEs where the judge explicitly praised the fit and then downgraded for a
// thin web presence — "Role template is an excellent functional fit, but there
// is zero verifiable information about this specific individual."
//
// Most directors at large manufacturers have no public footprint. Requiring one
// measures internet fame, not whether the prospect is worth an email.
//
// The standard for RELEVANCE is unchanged. All 7 BADs in that same audit were
// genuine — wrong function (CRM/sales, fragrance formulation, S&OP planning) or
// wrong geography (a plant manager in Thailand on a US-scoped mission) — and
// every one of them must still be BAD under this version.
export const JUDGE_PROMPT_VERSION = '3.0.0'

/**
 * Two GOOD tiers. Both count as GOOD for Precision@20; the split exists so the
 * report can show how much of the list rests on role fit alone, which is a real
 * property of the list worth seeing.
 */
export type JudgeVerdict = 'GOOD_HIGH_EVIDENCE' | 'GOOD_ROLE_BASED' | 'MAYBE' | 'BAD'

const VERDICTS = new Set<string>(['GOOD_HIGH_EVIDENCE', 'GOOD_ROLE_BASED', 'MAYBE', 'BAD'])

/**
 * Companies keep the simple three-way scale. The evidence-sparsity problem is
 * specific to individuals — a company with no web presence is genuinely
 * suspicious, whereas a director with none is merely ordinary.
 */
export type SimpleVerdict = 'GOOD' | 'MAYBE' | 'BAD'

export function isGood(v: JudgeVerdict): boolean {
  return v === 'GOOD_HIGH_EVIDENCE' || v === 'GOOD_ROLE_BASED'
}

export interface ProspectJudgement {
  candidate_id: string
  verdict: JudgeVerdict
  reasoning: string
}

export interface JudgeProspectInput {
  candidate_id: string
  name: string
  title: string | null
  company: string
  company_description: string
  person_summary: string
  location: string | null
}

const VERDICT_RUBRIC = `  GOOD_HIGH_EVIDENCE   You would send this person a thoughtful email, AND there is substantial
                       public confirmation of who they are and what they own — their own writing,
                       talks, projects, press, or a specific documented initiative.

  GOOD_ROLE_BASED      You would still send this person a thoughtful email, but mainly because
                       the ROLE is right: their function, seniority, company and geography all
                       match the mission and they could plausibly act on it or refer you. The
                       public record on them personally is thin.

  MAYBE                Plausible, but something MATERIAL is uncertain — not merely unpublicized.
                       Their function is adjacent rather than on-target, their scope is genuinely
                       ambiguous, or the fit rests on a partial overlap.

  BAD                  You would not send it. Wrong function, wrong geography, wrong seniority,
                       the company does not fit the mission, or they clearly could not act on it.`

/**
 * Judge one batch of prospects. Batched so the model can calibrate across a
 * spread rather than rating each candidate in isolation, where everything drifts
 * toward MAYBE.
 */
/**
 * Judge every prospect, in batches.
 *
 * Batching is not only a token-budget concern. A single 20-candidate call is one
 * all-or-nothing tool call: it once exceeded its output budget, returned nothing,
 * and the harness scored the profile 0% with every prospect defaulting to BAD —
 * a pipeline run identical to one that had scored 80%. Smaller batches fail
 * smaller, and the caller is told exactly how many verdicts are missing.
 *
 * Batches stay large enough (10) that the model still calibrates across a spread
 * rather than rating candidates in isolation, where everything drifts to MAYBE.
 */
export async function judgeProspects(
  missionGoal: string,
  backgroundSummary: string,
  prospects: JudgeProspectInput[]
): Promise<{ results: ProspectJudgement[]; costUsd: number; error?: string }> {
  if (prospects.length === 0) return { results: [], costUsd: 0 }

  const BATCH = 10
  if (prospects.length > BATCH) {
    const results: ProspectJudgement[] = []
    const errors: string[] = []
    let costUsd = 0
    for (let i = 0; i < prospects.length; i += BATCH) {
      const slice = prospects.slice(i, i + BATCH)
      const r = await judgeProspects(missionGoal, backgroundSummary, slice)
      results.push(...r.results)
      costUsd += r.costUsd
      if (r.error) errors.push(`batch ${i / BATCH + 1}: ${r.error}`)
    }
    return {
      results,
      costUsd,
      ...(results.length < prospects.length
        ? { error: `only ${results.length}/${prospects.length} prospects judged — ${errors.join('; ') || 'unknown'}` }
        : {}),
    }
  }

  const system = `You are an experienced career advisor reviewing a list of people that a research assistant
assembled for a student's outreach campaign. Your job is to say, bluntly, which of these you would
actually let them email.

${VERDICT_RUBRIC}

CALIBRATION

Be demanding about RELEVANCE. This list is supposed to read as though a careful human researcher
spent hours on it.

THE ONE THING NOT TO PENALIZE: a thin public record.

Most directors and senior managers at large manufacturers have almost no public web presence. That
is normal and says nothing about whether they are the right person to contact. Do not treat
"nothing specific is known about this individual" as a reason to downgrade. If their function,
seniority, company and geography all fit the mission and they could plausibly act on it, that is
GOOD_ROLE_BASED — a real target, correctly identified, about whom the internet is simply quiet.

Ask yourself the operative question: *would the student be right to spend an hour writing to this
person?* If yes, it is one of the two GOOD tiers, and which tier depends only on how much public
confirmation exists.

MAYBE is for MATERIAL uncertainty, not for missing publicity. Use it when the function is adjacent
rather than on-target, when the scope is genuinely ambiguous, or when the fit rests on a partial
overlap that may not hold.

Four errors to avoid in yourself:

  1. Do not reward seniority for its own sake. An executive vice-president at a 100,000-person
     company who would never read a cold email from an undergraduate is not a GOOD target. A
     director who owns the exact relevant function is.
  2. Do not reward keyword overlap. "AI" appearing in both the company description and the
     student's background is not a reason. A real overlap in the actual work is.
  3. Do not reward a famous company with the wrong person inside it. A right-sounding employer
     does not redeem a commercial, sales, IT, HR, or unrelated-R&D function.
  4. Do not confuse an unpublicized person with an unsuitable one.

Geography, function, seniority and decision influence remain hard requirements. A plant manager on
the wrong continent, a CRM/sales owner, or a product-formulation scientist is BAD for a mission
about industrial digital transformation — regardless of how impressive the company is.

You are judging fit for the mission, not the student's overall quality.`

    const list = prospects
      .map(
        (p, i) =>
          `── CANDIDATE ${i + 1} (id: ${p.candidate_id})
Name: ${p.name}
Title: ${p.title ?? 'unknown'}
Company: ${p.company}
Location: ${p.location ?? 'unknown'}
About the company: ${p.company_description}
What is known about the person:
${p.person_summary}`
      )
      .join('\n\n')

  const user = `MISSION
${missionGoal}

THE STUDENT'S BACKGROUND
${backgroundSummary}

CANDIDATES TO JUDGE
${list}

Give a verdict for every candidate, using their id. One or two sentences of reasoning each.`

  const res = await anthropicStructured<ProspectJudgement[]>({
    role: 'reasoning',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4000,
    schemaName: 'submit_judgements',
    schemaDescription: 'One verdict per candidate.',
    schema: {
      properties: {
        judgements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              candidate_id: { type: 'string' },
              verdict: { type: 'string', enum: ['GOOD_HIGH_EVIDENCE', 'GOOD_ROLE_BASED', 'MAYBE', 'BAD'] },
              reasoning: { type: 'string' },
            },
            required: ['candidate_id', 'verdict', 'reasoning'],
          },
        },
      },
      required: ['judgements'],
    },
    validate: (raw) => {
      const r = raw as { judgements?: unknown[] }
      if (!Array.isArray(r?.judgements)) return null
      const valid = new Set(prospects.map((p) => p.candidate_id))
      const out: ProspectJudgement[] = []
      for (const entry of r.judgements) {
        const j = entry as Record<string, unknown>
        const id = String(j.candidate_id ?? '')
        const verdict = String(j.verdict ?? '').toUpperCase()
        if (!valid.has(id)) continue
        if (!VERDICTS.has(verdict)) continue
        out.push({ candidate_id: id, verdict: verdict as JudgeVerdict, reasoning: String(j.reasoning ?? '') })
      }
      // A judge that skipped candidates would silently shrink the denominator
      // and inflate precision. Demand a verdict for every one.
      return out.length === prospects.length ? out : null
    },
    cacheKeyParts: {
      v: JUDGE_PROMPT_VERSION,
      mission: missionGoal,
      background: backgroundSummary,
      prospects: prospects.map((p) => `${p.candidate_id}|${p.title}|${p.company}|${p.person_summary}`),
    },
    cacheNamespace: 'agentic_judge',
  })

  return {
    results: res.value ?? [],
    costUsd: res.usage.costUsd,
    ...(res.error ? { error: res.error } : {}),
  }
}

// ─── Company-level judging ───────────────────────────────────────────────────

export interface CompanyJudgement {
  company: string
  verdict: SimpleVerdict
  reasoning: string
}

/**
 * Used for two evals at once:
 *   - Market Discovery Precision: of the companies we passed into Apollo, how
 *     many were GOOD targets?
 *   - Company Rejection Accuracy: of the companies we rejected, how many
 *     SHOULD have been rejected?
 *
 * `mode` changes the question asked, so a rejection is judged on whether the
 * rejection was right rather than on whether the company was good.
 */
export async function judgeCompanies(
  missionGoal: string,
  companies: { name: string; description: string; note: string }[],
  mode: 'targets' | 'rejections'
): Promise<{ results: CompanyJudgement[]; costUsd: number; error?: string }> {
  if (companies.length === 0) return { results: [], costUsd: 0 }

  const system =
    mode === 'targets'
      ? `You review a list of companies a research assistant selected as targets for a student's outreach
mission, and say which were worth selecting.

  GOOD   A genuinely appropriate target: the company really operates in the intended space and
         could plausibly host the work the mission describes.
  MAYBE  Defensible but marginal — adjacent to the intended space, or too far from it to be a
         priority.
  BAD    Should not have been selected. Wrong industry, not a real operating company, an
         organization that talks about the sector rather than working in it, or an obvious
         misidentification.

Be demanding, but do not require the company to be famous, large, or to advertise buzzwords. An
established chemicals manufacturer is a perfectly good target for a mission about applying AI in
industry, even if its website never says "AI".`
      : `You review companies a research assistant REJECTED from a student's outreach mission, and say
whether each rejection was correct.

  GOOD   The rejection was correct — this company genuinely does not belong.
  MAYBE  Arguable. The company is marginal; rejecting it is defensible but so was keeping it.
  BAD    The rejection was WRONG — this is a company the student should have been shown.

The most costly error is rejecting a real operator because it does not advertise the mission's
buzzwords. A chemicals or manufacturing company with no visible AI programme is still a valid
target for an AI-in-industry mission. Judge the rejection, not the company.`

  const list = companies
    .map((c, i) => `── ${i + 1}. ${c.name}\nWhat they do: ${c.description}\nThe assistant's note: ${c.note}`)
    .join('\n\n')

  const res = await anthropicStructured<CompanyJudgement[]>({
    role: 'reasoning',
    system,
    messages: [
      {
        role: 'user',
        content: `MISSION\n${missionGoal}\n\nCOMPANIES\n${list}\n\nGive a verdict for every company, by name.`,
      },
    ],
    maxTokens: 3000,
    schemaName: 'submit_company_judgements',
    schemaDescription: 'One verdict per company.',
    schema: {
      properties: {
        judgements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              verdict: { type: 'string', enum: ['GOOD', 'MAYBE', 'BAD'] },
              reasoning: { type: 'string' },
            },
            required: ['company', 'verdict', 'reasoning'],
          },
        },
      },
      required: ['judgements'],
    },
    validate: (raw) => {
      const r = raw as { judgements?: unknown[] }
      if (!Array.isArray(r?.judgements)) return null
      const out: CompanyJudgement[] = []
      for (const entry of r.judgements) {
        const j = entry as Record<string, unknown>
        const verdict = String(j.verdict ?? '').toUpperCase()
        if (verdict !== 'GOOD' && verdict !== 'MAYBE' && verdict !== 'BAD') continue
        out.push({
          company: String(j.company ?? ''),
          verdict: verdict as SimpleVerdict,
          reasoning: String(j.reasoning ?? ''),
        })
      }
      return out.length > 0 ? out : null
    },
    cacheKeyParts: { v: JUDGE_PROMPT_VERSION, mode, mission: missionGoal, companies },
    cacheNamespace: 'agentic_judge_companies',
  })

  return { results: res.value ?? [], costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}

// ─── Best-person judging ─────────────────────────────────────────────────────

export interface BestPersonJudgement {
  company: string
  /** True when the person we picked is among the best plausible choices there. */
  hit: boolean
  better_person_role: string | null
  reasoning: string
}

/**
 * Best-Person Hit Rate: within a GOOD company, did we find one of the best
 * plausible people, or merely an acceptable one?
 *
 * The judge sees who we chose and every other person Apollo surfaced at that
 * company, so "best" is judged against the real, available alternatives rather
 * than an imaginary ideal.
 */
export async function judgeBestPerson(
  missionGoal: string,
  cases: { company: string; company_description: string; chosen: string; alternatives: string[] }[]
): Promise<{ results: BestPersonJudgement[]; costUsd: number; error?: string }> {
  if (cases.length === 0) return { results: [], costUsd: 0 }

  const system = `You assess whether a research assistant picked the RIGHT PERSON inside each company.

For each company you see who the assistant chose, and the other people it could have chosen from
the same company. Decide whether the chosen person is among the best plausible entry points for
this mission.

  hit = true   The chosen person is one of the best available options here.
  hit = false  A materially better option was available, or the chosen person is clearly wrong
               for this mission.

Judge against the ALTERNATIVES SHOWN, not against an ideal person who may not exist at this
company. If the alternatives are all worse, the choice was correct even if imperfect.

Remember that the best entry point is rarely the most senior name. It is the person who owns the
relevant work and would plausibly read and answer a thoughtful message from a student.

When hit is false, name the role that should have been chosen instead.`

  const list = cases
    .map(
      (c, i) =>
        `── ${i + 1}. ${c.company}\nAbout: ${c.company_description}\nCHOSEN: ${c.chosen}\nALTERNATIVES AVAILABLE:\n${
          c.alternatives.length ? c.alternatives.map((a) => `  - ${a}`).join('\n') : '  (none — this was the only person found)'
        }`
    )
    .join('\n\n')

  const res = await anthropicStructured<BestPersonJudgement[]>({
    role: 'reasoning',
    system,
    messages: [{ role: 'user', content: `MISSION\n${missionGoal}\n\nCASES\n${list}` }],
    maxTokens: 3000,
    schemaName: 'submit_best_person',
    schemaDescription: 'One judgement per company.',
    schema: {
      properties: {
        judgements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              hit: { type: 'boolean' },
              better_person_role: { type: ['string', 'null'] },
              reasoning: { type: 'string' },
            },
            required: ['company', 'hit', 'better_person_role', 'reasoning'],
          },
        },
      },
      required: ['judgements'],
    },
    validate: (raw) => {
      const r = raw as { judgements?: unknown[] }
      if (!Array.isArray(r?.judgements)) return null
      const out: BestPersonJudgement[] = []
      for (const entry of r.judgements) {
        const j = entry as Record<string, unknown>
        if (typeof j.hit !== 'boolean') continue
        out.push({
          company: String(j.company ?? ''),
          hit: j.hit,
          better_person_role: typeof j.better_person_role === 'string' ? j.better_person_role : null,
          reasoning: String(j.reasoning ?? ''),
        })
      }
      return out.length > 0 ? out : null
    },
    cacheKeyParts: { v: JUDGE_PROMPT_VERSION, mission: missionGoal, cases },
    cacheNamespace: 'agentic_judge_bestperson',
  })

  return { results: res.value ?? [], costUsd: res.usage.costUsd, ...(res.error ? { error: res.error } : {}) }
}
