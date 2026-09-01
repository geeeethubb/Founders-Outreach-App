// Is this package finished? The pure half of one-click generation.
//
// The package pipeline always ran every safety check automatically. What it did
// NOT do was act on the result: it stopped at `resume_review`, waited for a
// human to press "approve all safe" (a DETERMINISTIC rule, not a judgement),
// waited again to build documents, waited again to approve a letter that had
// already passed its grounding gate, and waited a fourth time to finalize.
// Five clicks, four of which only confirmed that code had already said yes.
//
// This module removes the confirmations and keeps every check. Nothing here
// relaxes a gate: `safeToApprove` is the same deterministic predicate the
// button used, the Fact Verifier still rules on every rewritten bullet, the
// letter still has to pass `gateCoverLetter`, and document QA still has to
// pass. The only change is who presses the button when they all say yes.
//
// The outcome is one of two things a person can act on:
//
//   READY TO APPLY    every gate passed; download the DOCX and apply
//   NEEDS ATTENTION   a specific thing is wrong, with what/why/what-to-do
//
// Graceful degradation is the rule, not the exception. One rejected bullet
// keeps its original text and the package continues. A missing PDF is not a
// failure because the DOCX is the deliverable. A letter that fails grounding
// leaves the résumé intact and flags the letter alone.

import type { DocumentQaCheck, DocumentQaReport, JobOpportunity } from '../types'

// ─── What a human is actually being asked to look at ─────────────────────────

/**
 * One reason a package stopped short of READY TO APPLY.
 *
 * Three fields because "Package incomplete. Review 7 stages." is not an
 * instruction. `what` names the thing, `why` says why it matters, and `action`
 * is what the person does about it — and every one of these is written to be
 * read by someone who has not been staring at this pipeline.
 */
export interface AttentionItem {
  /** Stable identifier, safe to switch on in the UI. */
  code:
    | 'generation_failed'
    | 'resume_missing'
    | 'resume_qa_failed'
    | 'letter_unsupported_claim'
    | 'letter_qa_failed'
    | 'letter_row_missing'
    | 'letter_failed'
    | 'change_needs_your_yes'
    | 'no_apply_url'
  what: string
  why: string
  action: string
}

export interface PackageAssessment {
  ready: boolean
  attention: AttentionItem[]
}

/** The facts the ready/needs-attention decision is made from. Nothing else. */
export interface PackageAssessmentInput {
  /** Set when a stage threw or the orchestrator gave up. */
  hardError: string | null
  resumeDocxPath: string | null
  resumeQa: DocumentQaReport | null
  /**
   * Changes that passed every gate but that automation is not allowed to
   * approve — a Level-4 new bullet. Without this they stay `pending` forever:
   * uncounted by the summary, invisible in a finished package, and beyond
   * `reviewResumeChanges`, which refuses any status but resume_review /
   * ready_for_review / failed. The one class of change the code declines to
   * decide was the one nobody was being asked about.
   */
  pendingChanges?: number
  /** The writer produced no letter at all. The résumé is unaffected. */
  letterFailed?: boolean
  /**
   * A cover-letter DOCX exists but its row could not be read. The row is where
   * the grounding verdict lives, so without it the letter's factual gate has
   * simply not been consulted — which must never read as "no letter".
   */
  letterRowMissing?: boolean
  /** Null when no letter was requested for this package. */
  letter: {
    /** Blocking findings from `gateCoverLetter` that survived the retry. */
    blockingGrounding: number
    qa: DocumentQaReport | null
  } | null
  /** The URL the person will actually apply at. */
  applyUrl: string | null
}

function blockingFailures(qa: DocumentQaReport | null): DocumentQaCheck[] {
  if (!qa) return []
  return (qa.checks ?? []).filter((c) => c.blocking && !c.pass)
}

/**
 * READY TO APPLY has to MEAN ready: the documents exist, they passed the checks
 * that block, and there is somewhere to submit them. Anything else is named.
 *
 * Pure on purpose. This is the one decision that says whether a person's work
 * is done, so it is decided from values and tested offline rather than inferred
 * from whatever the database happened to record.
 *
 * Note what is deliberately NOT here: a rejected résumé change. The tailor
 * proposing five rewrites and the verifier refusing one is the system working —
 * the original bullet stands, the résumé is still true, and there is nothing
 * for a human to decide. Sending someone to a review queue for that is exactly
 * the friction this module exists to remove.
 */
export function assessPackage(input: PackageAssessmentInput): PackageAssessment {
  const attention: AttentionItem[] = []

  if (input.hardError) {
    attention.push({
      code: 'generation_failed',
      what: 'Package generation did not finish.',
      why: input.hardError,
      action: 'Retry generation. If it fails again the run log on this package has the failing stage.',
    })
    // A run that failed has nothing downstream worth reporting on.
    return { ready: false, attention }
  }

  if (!input.resumeDocxPath) {
    attention.push({
      code: 'resume_missing',
      what: 'No résumé DOCX was produced.',
      why: 'The résumé is the document you submit; without it there is no package.',
      action: 'Retry generation, or generate using the master résumé without tailoring.',
    })
  } else {
    const failed = blockingFailures(input.resumeQa)
    if (failed.length) {
      attention.push({
        code: 'resume_qa_failed',
        what: `The résumé DOCX failed ${failed.length} document check${failed.length === 1 ? '' : 's'}: ${failed.map((c) => c.name).join(', ')}.`,
        why: failed.map((c) => `${c.name}: ${c.detail}`).join(' · '),
        action: 'Regenerate the résumé. If it fails the same way, use the master résumé for this application.',
      })
    }
  }

  if (input.letter) {
    if (input.letter.blockingGrounding > 0) {
      attention.push({
        code: 'letter_unsupported_claim',
        what: `The cover letter makes ${input.letter.blockingGrounding} claim${input.letter.blockingGrounding === 1 ? '' : 's'} the evidence does not support.`,
        why: 'A letter that states something unverifiable about you or the company is the one thing that can cost you the application outright.',
        action: 'Regenerate the letter, edit the flagged sentence, or apply with the résumé only.',
      })
    }
    const letterFailed = blockingFailures(input.letter.qa)
    if (letterFailed.length) {
      attention.push({
        code: 'letter_qa_failed',
        what: `The cover-letter DOCX failed ${letterFailed.length} document check${letterFailed.length === 1 ? '' : 's'}.`,
        why: letterFailed.map((c) => `${c.name}: ${c.detail}`).join(' · '),
        action: 'Regenerate the cover letter, or apply with the résumé only.',
      })
    }
  }

  if (input.letterFailed) {
    attention.push({
      code: 'letter_failed',
      what: 'The cover letter could not be written.',
      why: 'The writer stopped before producing one. Your tailored résumé is complete and unaffected.',
      action: 'Most applications do not need a cover letter — apply with the résumé, or regenerate to try the letter again.',
    })
  }

  if (input.letterRowMissing) {
    attention.push({
      code: 'letter_row_missing',
      what: 'A cover letter was produced but its record could not be read.',
      why: 'The grounding check lives on that record. Without it there is no evidence the letter’s claims were verified.',
      action: 'Regenerate the cover letter, or apply with the résumé only.',
    })
  }

  if ((input.pendingChanges ?? 0) > 0) {
    const n = input.pendingChanges as number
    attention.push({
      code: 'change_needs_your_yes',
      what: `${n} proposed résumé change${n === 1 ? '' : 's'} passed verification but need${n === 1 ? 's' : ''} your decision.`,
      why: 'Adding a bullet that is not on your master résumé is a judgement about what to say about yourself, so the system will not make it for you — even though the facts check out.',
      action: 'Open the résumé changes below and approve or reject it. The document you have now simply omits it.',
    })
  }

  if (!input.applyUrl) {
    attention.push({
      code: 'no_apply_url',
      what: 'This job has no application link.',
      why: 'READY TO APPLY means you can open the posting and submit; without a URL there is nowhere to go.',
      action: 'Add the application URL on the job, or find the posting on the company’s careers page.',
    })
  }

  return { ready: attention.length === 0, attention }
}

/**
 * The apply URL, in the order a person would want it: the employer's own apply
 * link, then the canonical posting. Blank strings are not URLs.
 */
export function applyUrlFor(job: Pick<JobOpportunity, 'apply_url' | 'canonical_url'>): string | null {
  for (const u of [job.apply_url, job.canonical_url]) {
    const t = (u ?? '').trim()
    if (t) return t
  }
  return null
}

// ─── What happened, in one line a person can read ────────────────────────────

export interface AutoPackageCounts {
  proposed: number
  applied: number
  /** Refused by a gate. The original bullet stands; this is not a failure. */
  rejected: number
  /** Passed every gate, but only a human may say yes — a Level-4 new bullet. */
  pending?: number
}

/**
 * "4 of 5 proposed changes applied; 1 unsupported change omitted." — the
 * sentence the founder asked for, built once so the UI, the CLI and the batch
 * report cannot word it three different ways.
 */
export function resumeChangeSummary(counts: AutoPackageCounts): string {
  if (counts.proposed === 0) return 'No résumé changes were proposed; the master résumé is used as written.'
  const clauses: string[] = []
  if (counts.rejected > 0) clauses.push(`${counts.rejected} unsupported change${counts.rejected === 1 ? '' : 's'} omitted, original wording kept`)
  // Every proposal is accounted for. A pending change is neither applied nor
  // rejected, and leaving it out of the sentence is how one silently vanished.
  if ((counts.pending ?? 0) > 0) {
    const p = counts.pending as number
    clauses.push(`${p} awaiting your decision`)
  }
  const applied = `${counts.applied} of ${counts.proposed} proposed change${counts.proposed === 1 ? '' : 's'} applied`
  return clauses.length ? `${applied}; ${clauses.join('; ')}.` : `${applied}.`
}

/**
 * Blocking grounding findings on a stored letter's `grounding` column.
 *
 * Here rather than in letter.ts because the package UI needs it and letter.ts
 * reaches the database — importing it from a client component drags Supabase
 * into the browser bundle and fails the build. Unknown shapes and nulls count
 * as zero: this answers "did the gate find something", and a missing gate
 * result is not a finding.
 */
export function letterBlockingCount(g: unknown): number {
  const b = (g as { blocking?: unknown[] } | null)?.blocking
  return Array.isArray(b) ? b.length : 0
}
