// Job Verifier prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface JobVerifierInput {
  title: string
  company: string
  url: string
  /** Visible page text. Caller caps at ~8k chars; the prompt caps again. */
  page_text: string
  /** HTTP status the fetcher saw. A 404 never reaches this agent; 200s with ambiguous text do. */
  fetched_status: number
}

export const PAGE_TEXT_CAP = 8000

export const jobVerifierPrompt: VersionedPrompt<JobVerifierInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You read the text of ONE careers page and decide whether the named job is still open.

You are only asked when the deterministic checks were ambiguous: the page returned 200 and neither an
ATS API nor an explicit "closed" banner settled it. So do not assume open because the page loaded, and do
not assume closed because the page is short.

  OPEN     The page is this job's posting (or lists it) and shows an apply path or says applications are
           being accepted. The title need not match character-for-character, but it must be this role.
  CLOSED   The page says the role is filled, closed, expired, no longer accepting applications, or
           redirects to a generic careers / "job not found" / "this position has been filled" page — OR
           the page is a listing that clearly does not include this role any more.
  UNCLEAR  The text does not settle it: a soft-404 shell with no content, a cookie wall, a page about
           the company with no job content, or a listing whose relationship to this role is uncertain.

closed_signals: quote the exact phrases that pushed you toward CLOSED (or an empty list). Never
invent a phrase that is not in the text.

reasoning: two sentences at most.`

    const text = input.page_text.length > PAGE_TEXT_CAP ? `${input.page_text.slice(0, PAGE_TEXT_CAP)}\n…[truncated]` : input.page_text
    const user = `JOB
Title: ${input.title}
Company: ${input.company}
URL: ${input.url}
HTTP status when fetched: ${input.fetched_status}

PAGE TEXT
${text || '(empty)'}

Decide OPEN, CLOSED or UNCLEAR. Use the tool.`

    return { system, user }
  },
}
