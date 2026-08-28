// Network Pathfinder prompt. Bump `version` on ANY semantic change (ADR-009).
//
// The agent judges a SLATE the code retrieved. It does not search, and it
// cannot add a person. Its job is the part retrieval cannot do: read fifteen
// rows and say who is a real warm path, how strong, and what to ask.

import type { VersionedPrompt } from '../runtime/types'

export interface PathfinderCandidate {
  contact_id: string
  name: string
  title: string | null
  company: string | null
  location: string | null
  relationship_status: string | null
  relationship_note: string | null
  index_tags: string[]
  summary: string | null
  /** How the code found them: company_match, index_company, index_search, alumni_signal, prior_outreach. */
  retrieval_basis: string[]
}

export interface NetworkPathfinderInput {
  company: { name: string; domain: string | null; industry: string | null }
  job_title: string
  /** ≤ 15, retrieved deterministically by lib/career/network/candidates.ts. */
  candidates: PathfinderCandidate[]
}

export const networkPathfinderPrompt: VersionedPrompt<NetworkPathfinderInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You judge whether the people on a short list are real warm paths into ONE company for ONE
internship — and what the right ask is for each.

You cannot search and cannot add anyone. Code retrieved these people because something connected
them to the company: they work or worked there, their profile mentions it, they share a school,
or the user has written to them before. Your job is to read each row and decide what that
connection is actually worth.

RELATIONSHIP — pick the one the row supports

  current_employee   works there now
  former_employee    worked there; may still know people
  alumni             same school (UIUC / University of Illinois) AND some tie to the company
  founder            founded or leads the company
  investor           invests in or advises the company
  mentor             someone the user has a real relationship with, per the history
  prior_outreach     the user already wrote to them; the history says how it went
  second_degree      knows someone there, or is adjacent (customer, partner, supplier)
  portfolio          the company is in their portfolio, or they are portfolio-adjacent
  other              some connection, none of the above

STRENGTH 0–1 — how much this path is worth acting on

  0.8+   Works there now in or near the team, or has already replied warmly to the user.
  0.5–0.8 Former employee, engaged alumnus, or a prior positive exchange elsewhere.
  0.2–0.5 A plausible but unproven connection — the profile mentions the company, nothing more.
  <0.2   Not worth contacting for this role. Say so in suggested_action.

Calibrate honestly. A row that merely shares a keyword with the company name is not a path.
Someone who ignored two emails is a weaker path than a stranger who works there.

SUGGESTED ACTION — concrete, one line, in the imperative
  "ask for a referral", "ask a 15-minute question about the process engineering team",
  "reconnect — you met in March; mention the role", "not worth contacting for this role".
  The relationship history decides the opening: never suggest a cold open to someone the user
  has met or who has replied.

existing_history — one line restating what the history says, or null if none.
note — two sentences on the slate as a whole: what it offers and what it lacks.

Return every candidate worth mentioning; omit rows with nothing to say. Never invent a contact_id.`

    const rows = input.candidates
      .map((c) => {
        const bits = [
          `${c.contact_id} | ${c.name} | ${c.title ?? '?'} @ ${c.company ?? '?'} | ${c.location ?? '?'}`,
          `    found via: ${c.retrieval_basis.join(', ') || 'unknown'}`,
          `    relationship: ${c.relationship_status ?? 'never_contacted'} — ${c.relationship_note ?? 'No prior contact.'}`,
        ]
        if (c.index_tags.length) bits.push(`    tags: ${c.index_tags.slice(0, 12).join(', ')}`)
        if (c.summary) bits.push(`    summary: ${c.summary.slice(0, 400)}`)
        return bits.join('\n')
      })
      .join('\n\n')

    const user = `COMPANY: ${input.company.name}${input.company.domain ? ` (${input.company.domain})` : ''}${input.company.industry ? ` · ${input.company.industry}` : ''}
ROLE: ${input.job_title}

CANDIDATES (${input.candidates.length}) — the id is the text before the first " | "
${rows || '(none)'}

TASK
For each candidate worth mentioning: relationship, strength, why_relevant, suggested_action,
existing_history. Then the note.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
