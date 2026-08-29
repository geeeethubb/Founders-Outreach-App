// Who is writing. The outreach agents need a sender name for the sign-off and
// a short "who I am" for the signature line; both used to be literals.
//
// Resolution order, all deterministic:
//   name     profiles.name when it LOOKS like a person's name (a space, no
//            '@', no digits — "zuyu.alex06", which the signup trigger derives
//            from the email local-part, is rejected) → a bank education/other
//            fact of the form "Firstname Lastname is a …" → OUTREACH_SENDER_NAME
//            → the last-resort literal.
//   signoff  profiles.major + the bank's education title → "undergraduate,
//            chemical engineering"; falls back to the historical literal.

import { createServiceClient } from '@/lib/supabase/server'
import type { EvidenceBank } from '@/lib/career/types'

/** Last-resort fallback: the founder's name, kept only so an empty profile still signs. */
const FALLBACK_NAME = 'Zuyu Liu'
const FALLBACK_SIGNOFF = 'undergraduate, chemical engineering'

export interface Sender {
  name: string
  signoffContext: string
  /** Where the name came from, for the trace. */
  nameSource: 'profile' | 'bank' | 'env' | 'fallback'
}

/** A person's name: at least two words, letters only (with ' - .), no '@', no digits. */
export function looksLikePersonName(value: string | null | undefined): boolean {
  const v = (value ?? '').trim()
  if (!v || !v.includes(' ') || v.includes('@') || /\d/.test(v)) return false
  const words = v.split(/\s+/)
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]*$/.test(w))
}

// "Zuyu Liu is a Chemical Engineering student at …" — the sentence must be
// about a student, so "Procter Gamble is a consumer goods company" (an
// organization, not a person) can never become the sender's name.
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
  if (looksLikePersonName(profile?.name)) return { name: profile!.name!.trim(), signoffContext, nameSource: 'profile' }
  const fromBank = nameFromBank(bank)
  if (fromBank) return { name: fromBank, signoffContext, nameSource: 'bank' }
  const env = (process.env.OUTREACH_SENDER_NAME ?? '').trim()
  if (looksLikePersonName(env)) return { name: env, signoffContext, nameSource: 'env' }
  return { name: FALLBACK_NAME, signoffContext, nameSource: 'fallback' }
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
