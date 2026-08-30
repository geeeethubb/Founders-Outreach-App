// Who is writing. The outreach agents need a sender name for the sign-off and
// a short "who I am" for the signature line; both used to be literals.
//
// Resolution order, all deterministic:
//   name     lib/career/identity.ts resolveApplicantName: profiles.name when
//            it LOOKS like a person's name ("zuyu.alex06", which the signup
//            trigger derives from the email local-part, is rejected) → the
//            master résumé's name line → a bank education fact of the form
//            "Firstname Lastname is a … student" → OUTREACH_SENDER_NAME
//            → the last-resort literal.
//   signoff  profiles.major + the bank's education title → "undergraduate,
//            chemical engineering"; falls back to the historical literal.

import { createServiceClient } from '@/lib/supabase/server'
import type { EvidenceBank } from '@/lib/career/types'
import { looksLikePersonName, nameFromBank, resolveApplicantName, type ApplicantNameSource } from '@/lib/career/identity'

// The name rules live in lib/career/identity.ts so the cover letter and the
// outreach sign-off can never disagree. Re-exported: callers import from here.
export { looksLikePersonName, nameFromBank }

/** Last-resort fallback: the founder's name, kept only so an empty profile still signs. */
const FALLBACK_NAME = 'Zuyu Liu'
const FALLBACK_SIGNOFF = 'undergraduate, chemical engineering'

export interface Sender {
  name: string
  signoffContext: string
  /** Where the name came from, for the trace. */
  nameSource: ApplicantNameSource
}

function degreeLevel(title: string): string | null {
  if (/\b(b\.?s\.?|b\.?a\.?|bachelor|undergrad)/i.test(title)) return 'undergraduate'
  if (/\b(m\.?s\.?|m\.?eng|master)/i.test(title)) return "master's student"
  if (/\b(ph\.?d|doctora)/i.test(title)) return 'PhD student'
  if (/student/i.test(title)) return 'undergraduate'
  return null
}

function fieldFromEducationTitle(title: string): string | null {
  const stripped = title
    .replace(/\b(b\.?s\.?|b\.?a\.?|m\.?s\.?|ph\.?d\.?|bachelor(?:'s)?|master(?:'s)?)\b\.?/gi, '')
    .replace(/\b(in|of|student|candidate)\b/gi, '')
    .replace(/[,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length >= 4 ? stripped.toLowerCase() : null
}

export function signoffFrom(major: string | null | undefined, bank: EvidenceBank | null | undefined): string {
  const education = (bank?.experiences ?? [])
    .filter((e) => e.approved && e.status !== 'merged' && e.kind === 'education')
    .sort((a, b) => a.display_order - b.display_order)
  const titles = education.map((e) => e.title)
  const level = titles.map(degreeLevel).find((l): l is string => l !== null) ?? (major ? 'undergraduate' : null)
  const field =
    (major ?? '').trim().toLowerCase().replace(/\bengineer\b/, 'engineering') ||
    titles.map(fieldFromEducationTitle).find((f): f is string => f !== null) ||
    null
  if (!level && !field) return FALLBACK_SIGNOFF
  return [level, field].filter(Boolean).join(', ')
}

/** Pure part, so tests and the benchmark can run without a database. */
export function resolveSenderFrom(profile: { name?: string | null; major?: string | null } | null, bank?: EvidenceBank | null): Sender {
  const signoffContext = signoffFrom(profile?.major ?? null, bank)
  const resolved = resolveApplicantName({ profileName: profile?.name ?? null, bank })
  // The outreach loop keeps its historical literal as the last resort; the
  // letter loop signs 'Applicant' instead, so a wrong letter is visibly wrong.
  if (resolved.source === 'fallback') return { name: FALLBACK_NAME, signoffContext, nameSource: 'fallback' }
  return { name: resolved.name, signoffContext, nameSource: resolved.source }
}

export async function resolveSender(userId: string, bank?: EvidenceBank | null): Promise<Sender> {
  let profile: { name: string | null; major: string | null } | null = null
  try {
    const db = createServiceClient()
    const { data } = await db.from('profiles').select('name, major').eq('id', userId).maybeSingle()
    profile = (data as { name: string | null; major: string | null } | null) ?? null
  } catch {
    // A profile read failure must not stop a draft; the fallbacks below still sign it.
  }
  return resolveSenderFrom(profile, bank)
}
