// Warm-path candidate retrieval. Deterministic, free, inspectable.
//
// Six signals, all arithmetic on rows that already exist, each recorded as a
// `retrieval_basis` so "why is this person on the slate?" is answerable
// without a model:
//
//   company_match    contacts.company_id = companyId, or the normalized company name matches
//   index_company    contact_index.company_norm matches
//   index_search     search_contact_index() over the company name + domain root
//   alumni_signal    index text mentions UIUC / University of Illinois AND a company match
//   prior_outreach   an outreach row exists for this contact (at this company when known)
//   (history)        loadRelationshipHistory() for status + note — a property, not a basis
//
// Nothing here judges anyone. The Network Pathfinder reads the slate.
//
// DEGRADES: contact_index is migration 013. Without it, company_match and
// prior_outreach still work from `contacts` and `outreach`; the index-backed
// signals report `degraded` and contribute nothing.

import { createServiceClient } from '@/lib/supabase/server'
import { normalizeCompanyName, normalizeDomain } from '@/lib/providers/apollo/normalize'
import { searchNetwork } from '@/lib/network/search'
import { loadRelationshipHistory, type RelationshipStatus } from '@/lib/network/relationship'
import { isMissingSchema } from '@/lib/career/evidence/store'
import type { PathfinderCandidate } from '@/lib/agents/network-pathfinder/prompt'

export interface WarmPathQuery {
  companyName: string
  companyId: string | null
  domain: string | null
  industry: string | null
  jobTitle: string
}

export interface WarmPathCandidates {
  candidates: PathfinderCandidate[]
  /** Signals that could not run, with why. Empty on a full run. */
  degraded: string[]
  /** How many contacts each signal contributed before dedupe. */
  counts: Record<string, number>
}

export const WARM_PATH_CAP = 15

const ALUMNI_PATTERNS = ['UIUC', 'University of Illinois']

/** Warmest first. Mirrors the precedence in lib/network/relationship.ts. */
const WARMTH: Record<RelationshipStatus, number> = {
  met: 6,
  referred: 6,
  replied_positive: 5,
  in_conversation: 4,
  never_contacted: 2,
  contacted_no_reply: 1,
  replied_negative: 0,
}

const EVIDENCE: Record<string, number> = { rich: 3, moderate: 2, thin: 1 }

interface ContactRow {
  id: string
  name: string
  company: string | null
  role: string | null
  location: string | null
  company_id: string | null
  tags: string[] | null
}

interface IndexRow {
  contact_id: string
  headline: string | null
  tags_text: string | null
  body_text: string | null
  company_name: string | null
  company_norm: string | null
  tags: string[] | null
  relationship_status: string | null
  relationship_note: string | null
  evidence_level: string | null
  industry: string | null
}

interface Working {
  contact: ContactRow | null
  index: IndexRow | null
  basis: Set<string>
}

/** "acme.com" → "acme"; the token most likely to appear in a profile that mentions the company. */
function domainRoot(domain: string | null): string | null {
  const d = normalizeDomain(domain)
  if (!d) return null
  const root = d.split('.')[0]
  return root && root.length >= 3 ? root : null
}

/**
 * Alumni is a fact about THEM, and the index body is full of sentences about
 * the USER: V1 research writes "Hooks: … UIUC …", "Shared: both connected to
 * UIUC", "Suggested ask: … Founders at UIUC …" for nearly every contact. On the
 * real database the first version of this check flagged 27 of 27 Fervo
 * contacts as alumni. So: identity fields (headline, tags) count as-is, and a
 * body line counts only when it reads like an education statement about the
 * person and is not one of the user-side research lines.
 */
const USER_SIDE_LINE = /^(hooks|shared|suggested ask|company):/i
const EDUCATION_NEAR_SCHOOL = new RegExp(
  `(alum|alumn|graduat|studied|attended|degree|b\\.?s\\.?|m\\.?s\\.?|mba|ph\\.?d)[^.\\n]{0,80}(${ALUMNI_PATTERNS.join('|')})|(${ALUMNI_PATTERNS.join('|')})[^.\\n]{0,80}(alum|alumn|graduat|studied|attended|degree)`,
  'i'
)

export function mentionsAlumni(row: Pick<IndexRow, 'headline' | 'tags_text' | 'tags' | 'body_text'> | null): boolean {
  if (!row) return false
  const identity = `${row.headline ?? ''} ${row.tags_text ?? ''} ${(row.tags ?? []).join(' ')}`.toLowerCase()
  if (ALUMNI_PATTERNS.some((p) => identity.includes(p.toLowerCase()))) return true
  for (const line of (row.body_text ?? '').split('\n')) {
    if (USER_SIDE_LINE.test(line.trim())) continue
    if (EDUCATION_NEAR_SCHOOL.test(line)) return true
  }
  return false
}

export async function findWarmPathCandidates(userId: string, q: WarmPathQuery): Promise<WarmPathCandidates> {
  const supabase = createServiceClient()
  const degraded: string[] = []
  const counts: Record<string, number> = {}
  const pool = new Map<string, Working>()
  const bump = (id: string) => {
    let w = pool.get(id)
    if (!w) {
      w = { contact: null, index: null, basis: new Set() }
      pool.set(id, w)
    }
    return w
  }
  const tally = (basis: string, n: number) => {
    counts[basis] = (counts[basis] ?? 0) + n
  }

  const nameNorm = normalizeCompanyName(q.companyName)
  const root = domainRoot(q.domain)

  // ─── (a) contacts by company_id or normalized company name ───
  {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, company, role, location, company_id, tags')
      .eq('user_id', userId)
      .limit(5000)
    if (error) {
      degraded.push(`contacts: ${error.message.slice(0, 80)}`)
    } else {
      let n = 0
      for (const c of (data ?? []) as ContactRow[]) {
        const byId = Boolean(q.companyId && c.company_id === q.companyId)
        const byName = Boolean(nameNorm && normalizeCompanyName(c.company) === nameNorm)
        if (!byId && !byName) continue
        const w = bump(c.id)
        w.contact = c
        w.basis.add('company_match')
        n++
      }
      tally('company_match', n)
    }
  }

  // ─── (b) + (d) contact_index by company_norm, with the alumni check ───
  let indexAvailable = true
  if (nameNorm) {
    const { data, error } = await supabase
      .from('contact_index')
      .select('contact_id, headline, tags_text, body_text, company_name, company_norm, tags, relationship_status, relationship_note, evidence_level, industry')
      .eq('user_id', userId)
      .eq('company_norm', nameNorm)
      .limit(100)
    if (error) {
      indexAvailable = !isMissingSchema(error.message)
      degraded.push(`index_company: ${indexAvailable ? error.message.slice(0, 80) : 'contact_index missing (migration 013)'}`)
    } else {
      let n = 0
      let alumni = 0
      for (const row of (data ?? []) as IndexRow[]) {
        const w = bump(row.contact_id)
        w.index = row
        w.basis.add('index_company')
        n++
        if (mentionsAlumni(row)) {
          w.basis.add('alumni_signal')
          alumni++
        }
      }
      tally('index_company', n)
      tally('alumni_signal', alumni)
    }
  }

  // ─── (c) ranked full-text search: quoted company name + domain root ───
  if (indexAvailable) {
    const query = [`"${q.companyName}"`, root].filter(Boolean).join(' ')
    const res = await searchNetwork({ userId, query, limit: 30 })
    if (res.error) {
      if (res.migrationMissing) indexAvailable = false
      degraded.push(`index_search: ${res.migrationMissing ? 'contact_index missing (migration 013)' : res.error.slice(0, 80)}`)
    } else {
      let n = 0
      for (const c of res.candidates) {
        // The search matches loosely by design (terms are OR-ed). Require the
        // company name or domain root to actually appear in the row's own text,
        // or the slate fills with everyone who shares one word with the name.
        const text = `${c.company ?? ''} ${c.summary ?? ''} ${(c.tags ?? []).join(' ')}`.toLowerCase()
        const hit =
          (nameNorm && normalizeCompanyName(c.company) === nameNorm) ||
          text.includes(q.companyName.toLowerCase()) ||
          (root ? text.includes(root) : false)
        if (!hit) continue
        const w = bump(c.contact_id)
        w.basis.add('index_search')
        if (!w.index) {
          w.index = {
            contact_id: c.contact_id,
            headline: `${c.name} · ${c.title ?? ''} · ${c.company ?? ''}`,
            tags_text: null,
            body_text: null,
            company_name: c.company,
            company_norm: normalizeCompanyName(c.company),
            tags: c.tags,
            relationship_status: c.relationship_status,
            relationship_note: c.relationship_note,
            evidence_level: c.evidence_level,
            industry: c.industry,
          }
        }
        if (!w.contact) {
          w.contact = { id: c.contact_id, name: c.name, company: c.company, role: c.title, location: c.location, company_id: null, tags: c.tags }
        }
        n++
      }
      tally('index_search', n)
    }
  }

  // ─── (f) prior outreach — at this company when the id is known, else any ───
  {
    let query = supabase.from('outreach').select('contact_id, company_id, state').eq('user_id', userId).limit(2000)
    if (q.companyId) query = query.eq('company_id', q.companyId)
    const { data, error } = await query
    if (error) {
      if (!isMissingSchema(error.message)) degraded.push(`prior_outreach: ${error.message.slice(0, 80)}`)
    } else {
      let n = 0
      for (const o of (data ?? []) as { contact_id: string; company_id: string | null; state: string }[]) {
        // Without a company id, only contacts ALREADY on the slate get the
        // basis — a prior email to someone unrelated is not a path here.
        if (!q.companyId && !pool.has(o.contact_id)) continue
        bump(o.contact_id).basis.add('prior_outreach')
        n++
      }
      tally('prior_outreach', n)
    }
  }

  if (pool.size === 0) return { candidates: [], degraded, counts }

  // ─── fill in missing contact rows for ids that arrived from the index/outreach ───
  const missingContacts = Array.from(pool.entries()).filter(([, w]) => !w.contact).map(([id]) => id)
  if (missingContacts.length) {
    const { data } = await supabase
      .from('contacts')
      .select('id, name, company, role, location, company_id, tags')
      .eq('user_id', userId)
      .in('id', missingContacts)
    for (const c of (data ?? []) as ContactRow[]) bump(c.id).contact = c
  }

  // ─── (e) relationship history, and the index's own status as a floor ───
  const history = await loadRelationshipHistory(userId)
  if (history.degraded.length) degraded.push(...history.degraded.map((d) => `history: ${d}`))

  const rows = Array.from(pool.entries())
    .filter(([, w]) => w.contact)
    .map(([id, w]) => {
      const h = history.byContact.get(id)
      const status = (h?.status ?? (w.index?.relationship_status as RelationshipStatus | null) ?? 'never_contacted') as RelationshipStatus
      const note = h?.note ?? w.index?.relationship_note ?? 'No prior contact.'
      const c = w.contact!
      const candidate: PathfinderCandidate = {
        contact_id: id,
        name: c.name,
        title: c.role,
        company: c.company ?? w.index?.company_name ?? null,
        location: c.location,
        relationship_status: status,
        relationship_note: note,
        index_tags: Array.from(new Set([...(w.index?.tags ?? []), ...(c.tags ?? [])])).slice(0, 16),
        summary: w.index?.body_text ? w.index.body_text.slice(0, 400) : w.index?.headline ?? null,
        retrieval_basis: Array.from(w.basis),
      }
      return {
        candidate,
        warmth: WARMTH[status] ?? 2,
        evidence: EVIDENCE[w.index?.evidence_level ?? ''] ?? 0,
        signals: w.basis.size,
      }
    })
    // Warmth, then how much we know, then how many signals agreed.
    .sort((a, b) => b.warmth - a.warmth || b.evidence - a.evidence || b.signals - a.signals)

  return { candidates: rows.slice(0, WARM_PATH_CAP).map((r) => r.candidate), degraded, counts }
}
