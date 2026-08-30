// Who the applicant is, by name. One deterministic resolver for every place a
// letter, a sign-off or a document header needs the person's name.
//
// Why this exists: the signup trigger fills profiles.name with the email
// local-part (`coalesce(full_name, split_part(email,'@',1))`), so a founder
// who signed up as zuyu.alex06@gmail.com has profiles.name = "zuyu.alex06".
// The first live package greeted and signed a cover letter with exactly that.
// Both loops (outreach sign-off, cover letter) now resolve through here.
//
// Resolution order, all pure:
//   profile   profiles.name when it LOOKS like a person's name
//   resume    the master résumé's name paragraph (paragraph_map kind 'name')
//   bank      an approved education fact "Firstname Lastname is a … student"
//   env       OUTREACH_SENDER_NAME
//   fallback  'Applicant'
// An email local-part, anything with '@' or a digit, can never come out.

import type { EvidenceBank } from './types'

export type ApplicantNameSource = 'profile' | 'resume' | 'bank' | 'env' | 'fallback'

export interface ApplicantName {
  name: string
  source: ApplicantNameSource
}

/** The last resort. Never a real name, so a wrong letter is visibly wrong rather than quietly someone else's. */
export const APPLICANT_FALLBACK = 'Applicant'

/** A person's name: two to four words, letters only (with ' - .), no '@', no digits. */
export function looksLikePersonName(value: string | null | undefined): boolean {
  const v = (value ?? '').trim()
  if (!v || !v.includes(' ') || v.includes('@') || /\d/.test(v)) return false
  const words = v.split(/\s+/)
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]*$/.test(w))
}

/**
 * An email local-part standing where a name should be: one token, no spaces,
 * only [a-z0-9._+-], carrying a dot or a digit ("zuyu.alex06", "jdoe42",
 * "first.last"). A full address counts too. A plain single word ("zuyu") does
 * not — it is not evidence of the trigger's local-part, and a mononym exists.
 */
export function isEmailLikeName(value: string | null | undefined): boolean {
  const v = (value ?? '').trim()
  if (!v) return false
  if (v.includes('@')) return true
  if (!/^[A-Za-z0-9._+-]+$/.test(v)) return false
  return /[.\d_+]/.test(v)
}

// "Zuyu Liu is a Chemical Engineering student at …" — the sentence must be
// about a student, so "Procter Gamble is a consumer goods company" (an
// organization, not a person) can never become the name.
const NAME_IN_FACT = /^([A-Z][a-zà-ÿ'-]+ [A-Z][a-zà-ÿ'-]+) (?:is|was) (?:a|an|the) [^.]*\b(?:student|undergraduate|candidate|major|majoring|studying)\b/

/** "Zuyu Liu is a Chemical Engineering student…" → "Zuyu Liu". Approved education facts only; deterministic. */
export function nameFromBank(bank: EvidenceBank | null | undefined): string | null {
  if (!bank) return null
  const candidates = bank.facts
    .filter((f) => f.approved && f.status !== 'merged' && f.category === 'education')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  for (const f of candidates) {
    const m = NAME_IN_FACT.exec(f.statement.trim())
    if (m) return m[1]
  }
  return null
}

/** The master résumé's name line — the one document the applicant wrote their own name on. */
export function nameFromResume(bank: EvidenceBank | null | undefined): string | null {
  const entry = bank?.masterDocument?.paragraph_map.find((e) => e.kind === 'name')
  const text = (entry?.text ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  return looksLikePersonName(text) ? text : null
}

export function resolveApplicantName(input: {
  profileName?: string | null
  bank?: EvidenceBank | null
  /** Defaults to process.env.OUTREACH_SENDER_NAME; tests pass their own. */
  env?: string | null
}): ApplicantName {
  if (looksLikePersonName(input.profileName)) return { name: (input.profileName as string).trim(), source: 'profile' }
  const fromResume = nameFromResume(input.bank)
  if (fromResume) return { name: fromResume, source: 'resume' }
  const fromBank = nameFromBank(input.bank)
  if (fromBank) return { name: fromBank, source: 'bank' }
  const env = ((input.env === undefined ? process.env.OUTREACH_SENDER_NAME : input.env) ?? '').trim()
  if (looksLikePersonName(env)) return { name: env, source: 'env' }
  return { name: APPLICANT_FALLBACK, source: 'fallback' }
}

/**
 * The name a document may print. A caller that already resolved a name passes
 * it through; a caller that was handed an email local-part (an old signer, an
 * eval fixture, a stale row) gets it resolved again. Never an email name.
 */
export function printableName(name: string | null | undefined, bank?: EvidenceBank | null): string {
  const v = (name ?? '').trim()
  if (v && !isEmailLikeName(v)) return v
  return resolveApplicantName({ profileName: v, bank }).name
}
