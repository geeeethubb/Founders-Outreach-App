// Persistence for the approve -> send -> track loop.
//
// Everything here is deterministic: upserts, compare-and-swap, status
// arithmetic. No agent touches this file (CLAUDE.md principle 1).
//
// Service-role client throughout — these writes happen from route handlers that
// have already authenticated the user, and the RLS policy on `outreach` is
// keyed to auth.uid() which the service client bypasses. Every function
// therefore takes userId explicitly and filters on it. Forgetting that filter
// is the one way to leak across accounts, so it is never optional here.

import { createServiceClient } from '@/lib/supabase/server'
import { canTransition, isOutreachState, type OutreachState, type Outcome } from './states'
import type { GroundingResult } from './grounding'

export interface OutreachRow {
  id: string
  user_id: string
  contact_id: string
  company_id: string | null
  run_id: string | null
  mission_goal: string | null
  state: OutreachState
  positioning: Record<string, unknown> | null
  positioning_version: string | null
  proof_point_ids: string[]
  angle: string | null
  subject: string | null
  body: string | null
  body_edited: string | null
  edited_at: string | null
  word_count: number | null
  cta: string | null
  draft_version: string | null
  allowed_claims: string[] | null
  grounding: GroundingResult | null
  email_id: string | null
  sent_at: string | null
  send_error: string | null
  send_attempts: number
  gmail_thread_id: string | null
  rfc822_message_id: string | null
  conversation_id: string | null
  replied_at: string | null
  reply_classification: string | null
  reply_action: string | null
  reply_summary: string | null
  suggested_reply: Record<string, unknown> | null
  followup_count: number
  followup_suggestion: Record<string, unknown> | null
  followup_due_at: string | null
  outcome: Outcome | null
  outcome_at: string | null
  outcome_note: string | null
  segment: string | null
  company_type: string | null
  recipient_role: string | null
  score: number | null
  created_at: string
  updated_at: string
}

export class MigrationMissingError extends Error {
  constructor() {
    super('Migration 012_outreach.sql has not been applied — run it in the Supabase SQL editor.')
    this.name = 'MigrationMissingError'
  }
}

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache/i.test(message)
}

function raise(message: string): never {
  if (isMissingSchema(message)) throw new MigrationMissingError()
  throw new Error(message)
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export interface ProspectIdentity {
  name: string
  email: string | null
  title: string | null
  company: string
  linkedin: string | null
  location: string | null
}

/**
 * Find the stored contact for a scouted prospect, creating one if the scouting
 * run did not persist it (migration 010 missing at the time, or a run predating
 * persistence). Matching order mirrors lib/scouting/persist.ts so the two never
 * disagree about who is who.
 */
export async function resolveContactId(
  userId: string,
  p: ProspectIdentity
): Promise<string> {
  const supabase = createServiceClient()

  const attempts: Array<{ column: string; value: string }> = []
  if (p.linkedin) attempts.push({ column: 'linkedin_url', value: p.linkedin })
  if (p.email) attempts.push({ column: 'email', value: p.email })

  for (const a of attempts) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id')
      .eq('user_id', userId)
      .eq(a.column, a.value)
      .maybeSingle()
    if (error) raise(error.message)
    if (data) return data.id
  }

  // Name + company is the last resort: weaker, but two people with the same
  // name at the same company is rarer than a prospect with no LinkedIn URL.
  const { data: byName, error: nameErr } = await supabase
    .from('contacts')
    .select('id')
    .eq('user_id', userId)
    .eq('name', p.name)
    .eq('company', p.company)
    .maybeSingle()
  if (nameErr) raise(nameErr.message)
  if (byName) return byName.id

  const { data: created, error: insertErr } = await supabase
    .from('contacts')
    .insert({
      user_id: userId,
      name: p.name,
      email: p.email,
      linkedin_url: p.linkedin,
      company: p.company,
      role: p.title,
      location: p.location,
      source: 'apollo',
      discovery_source: 'apollo',
      status: 'discovered',
    })
    .select('id')
    .maybeSingle()
  if (insertErr) raise(insertErr.message)
  if (!created) throw new Error(`Could not create a contact for ${p.name}`)
  return created.id
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getOutreach(userId: string, id: string): Promise<OutreachRow | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('outreach')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) raise(error.message)
  return (data as OutreachRow) ?? null
}

export async function getOutreachByContact(
  userId: string,
  contactId: string
): Promise<OutreachRow | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('outreach')
    .select('*')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (error) raise(error.message)
  return (data as OutreachRow) ?? null
}

export interface OutreachListItem extends OutreachRow {
  contact: { name: string; email: string | null; role: string | null; company: string | null } | null
}

export async function listOutreach(
  userId: string,
  opts: { states?: OutreachState[]; limit?: number } = {}
): Promise<OutreachListItem[]> {
  const supabase = createServiceClient()
  let q = supabase
    .from('outreach')
    .select('*, contact:contacts(name, email, role, company)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200)
  if (opts.states?.length) q = q.in('state', opts.states)
  const { data, error } = await q
  if (error) raise(error.message)
  return (data ?? []) as unknown as OutreachListItem[]
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface DraftInput {
  contactId: string
  companyId?: string | null
  runId?: string | null
  missionGoal?: string | null
  positioning: Record<string, unknown>
  positioningVersion: string
  proofPointIds: string[]
  angle: string
  subject: string
  body: string
  wordCount: number
  cta: string | null
  draftVersion: string
  allowedClaims: string[]
  grounding: GroundingResult
  segment?: string | null
  companyType?: string | null
  recipientRole?: string | null
  score?: number | null
  /** Migration 013. Which campaign's reference email wrote this. */
  campaignId?: string | null
  /** 'reference' when a campaign reference drove the voice, else 'brief'. */
  draftMode?: 'brief' | 'reference' | null
  /** 'existing' | 'new' | 'existing_rediscovered'. */
  prospectSource?: string | null
}

/**
 * Create or replace the draft for a person.
 *
 * Regenerating is allowed right up until the email leaves. After that the row is
 * frozen: the stored draft must keep matching what the recipient actually read,
 * or every downstream answer about "what did we say to them" becomes a guess.
 */
export async function saveDraft(userId: string, input: DraftInput): Promise<OutreachRow> {
  const supabase = createServiceClient()
  const existing = await getOutreachByContact(userId, input.contactId)

  if (existing && !['draft', 'ready_for_review', 'approved', 'skipped', 'failed'].includes(existing.state)) {
    throw new Error(
      `This outreach is already ${existing.state} — a sent email cannot be redrafted.`
    )
  }

  const row = {
    user_id: userId,
    contact_id: input.contactId,
    company_id: input.companyId ?? null,
    run_id: input.runId ?? null,
    mission_goal: input.missionGoal ?? null,
    // A fresh draft always lands in review, never carrying an old approval
    // forward: approving text A must never approve text B.
    state: (input.grounding.ok ? 'ready_for_review' : 'draft') as OutreachState,
    positioning: input.positioning,
    positioning_version: input.positioningVersion,
    proof_point_ids: input.proofPointIds,
    angle: input.angle,
    subject: input.subject,
    body: input.body,
    body_edited: null,
    edited_at: null,
    word_count: input.wordCount,
    cta: input.cta,
    draft_version: input.draftVersion,
    allowed_claims: input.allowedClaims,
    grounding: input.grounding,
    segment: input.segment ?? null,
    company_type: input.companyType ?? null,
    recipient_role: input.recipientRole ?? null,
    score: input.score ?? null,
    campaign_id: input.campaignId ?? null,
    draft_mode: input.draftMode ?? null,
    prospect_source: input.prospectSource ?? null,
  }

  // Columns added by migration 013. Dropping them on a schema error keeps
  // Phase 9's approve → send → track loop working on a database where 013 has
  // not been applied yet — additive migrations must never break what shipped.
  const stripV13 = (r: typeof row) => {
    const { campaign_id: _a, draft_mode: _b, prospect_source: _c, ...rest } = r
    return rest
  }

  if (existing) {
    let { data, error } = await supabase
      .from('outreach')
      .update(row)
      .eq('id', existing.id)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle()
    if (error && isMissingSchema(error.message)) {
      ;({ data, error } = await supabase
        .from('outreach')
        .update(stripV13(row))
        .eq('id', existing.id)
        .eq('user_id', userId)
        .select('*')
        .maybeSingle())
    }
    if (error) raise(error.message)
    await recordEvent(existing.id, existing.state, row.state, 'system', { reason: 'redrafted' })
    return data as OutreachRow
  }

  let { data, error } = await supabase.from('outreach').insert(row).select('*').maybeSingle()
  if (error && isMissingSchema(error.message)) {
    ;({ data, error } = await supabase.from('outreach').insert(stripV13(row)).select('*').maybeSingle())
  }
  if (error) raise(error.message)
  const created = data as OutreachRow
  await recordEvent(created.id, null, created.state, 'system', { reason: 'drafted' })
  return created
}

/**
 * Append the (generated → final) pair when the user edits a draft.
 *
 * Best-effort and non-blocking: losing a learning signal must never fail the
 * edit that produced it.
 *
 * Nothing reads this yet, deliberately. One edit is not evidence of a style
 * preference, and rewriting global rules from it is exactly the overfitting the
 * campaign-reference design replaces. What it buys is the ability to answer
 * "what does this user CONSISTENTLY change?" later, from real data rather than
 * from a remembered impression.
 */
export async function recordEdit(
  userId: string,
  row: OutreachRow,
  finalBody: string,
  finalSubject: string | null
): Promise<void> {
  const supabase = createServiceClient()
  await supabase.from('outreach_edits').insert({
    user_id: userId,
    outreach_id: row.id,
    campaign_id: (row as unknown as { campaign_id?: string | null }).campaign_id ?? null,
    generated_subject: row.subject,
    generated_body: row.body,
    final_subject: finalSubject ?? row.subject,
    final_body: finalBody,
    draft_version: row.draft_version,
    style_version: (row as unknown as { positioning_version?: string | null }).positioning_version ?? null,
  })
}

/** Store the user's edit. Never overwrites the agent's original. */
export async function saveEdit(
  userId: string,
  id: string,
  bodyEdited: string,
  subject: string | null,
  grounding: GroundingResult
): Promise<OutreachRow> {
  const supabase = createServiceClient()
  const current = await getOutreach(userId, id)
  if (!current) throw new Error('Outreach not found')
  if (!['draft', 'ready_for_review', 'approved', 'failed'].includes(current.state)) {
    throw new Error(`Cannot edit an outreach in state ${current.state}.`)
  }

  // An edit invalidates a prior approval. This is the exact hole the gate exists
  // to close: approve clean text, then paste in an unsupported figure.
  const state: OutreachState = grounding.ok ? 'ready_for_review' : 'draft'

  const { data, error } = await supabase
    .from('outreach')
    .update({
      body_edited: bodyEdited,
      edited_at: new Date().toISOString(),
      ...(subject ? { subject } : {}),
      word_count: bodyEdited.trim().split(/\s+/).filter(Boolean).length,
      grounding,
      state,
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()
  if (error) raise(error.message)
  await recordEvent(id, current.state, state, 'user', { reason: 'edited' })
  // The generated-vs-final pair, kept before `current` goes out of scope.
  await recordEdit(userId, current, bodyEdited, subject)
  return data as OutreachRow
}

/** Move state with the transition table enforced server-side. */
export async function transition(
  userId: string,
  id: string,
  to: OutreachState,
  actor: 'user' | 'system' | 'agent' = 'user',
  patch: Record<string, unknown> = {}
): Promise<OutreachRow> {
  const supabase = createServiceClient()
  const current = await getOutreach(userId, id)
  if (!current) throw new Error('Outreach not found')
  if (current.state === to && Object.keys(patch).length === 0) return current
  if (!canTransition(current.state, to)) {
    throw new Error(`Cannot go from ${current.state} to ${to}.`)
  }

  const { data, error } = await supabase
    .from('outreach')
    .update({ state: to, ...patch })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()
  if (error) raise(error.message)
  await recordEvent(id, current.state, to, actor, patch)
  return data as OutreachRow
}

/**
 * Claim an approved outreach for sending — the idempotency primitive.
 *
 * A single conditional UPDATE. Postgres serialises row updates, so of two
 * concurrent requests exactly one sees a row come back and the other sees none.
 * Checking-then-updating in two statements would let both through the gap, which
 * is precisely how double sends happen.
 *
 * `failed` is claimable alongside `approved` so a retry works. That does not
 * weaken the approval gate: `failed` is only reachable from `sending`, which is
 * only reachable from `approved`, and any edit in between drops the row back to
 * draft and demands re-approval.
 */
export const CLAIMABLE_STATES: OutreachState[] = ['approved', 'failed']

export async function claimForSend(userId: string, id: string): Promise<OutreachRow | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('outreach')
    .update({ state: 'sending', send_error: null })
    .eq('id', id)
    .eq('user_id', userId)
    .in('state', CLAIMABLE_STATES)
    .is('sent_at', null)
    .select('*')
    .maybeSingle()
  if (error) raise(error.message)
  if (!data) return null
  await recordEvent(id, 'approved', 'sending', 'system', {})
  return data as OutreachRow
}

export async function recordSendSuccess(
  userId: string,
  id: string,
  info: { emailId: string; rfc822MessageId: string; gmailThreadId: string | null }
): Promise<OutreachRow> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('outreach')
    .update({
      state: 'sent',
      email_id: info.emailId,
      rfc822_message_id: info.rfc822MessageId,
      gmail_thread_id: info.gmailThreadId,
      sent_at: new Date().toISOString(),
      send_error: null,
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()
  if (error) raise(error.message)
  await recordEvent(id, 'sending', 'sent', 'system', { emailId: info.emailId })
  return data as OutreachRow
}

/**
 * Release the claim after a failed send.
 *
 * Back to `failed`, never to `sent`. An email that Gmail rejected must never be
 * recorded as delivered — a pipeline that hides failures trains its operator to
 * trust it more than it has earned (ADR-010).
 */
export async function recordSendFailure(
  userId: string,
  id: string,
  reason: string
): Promise<OutreachRow> {
  const supabase = createServiceClient()
  const current = await getOutreach(userId, id)
  const { data, error } = await supabase
    .from('outreach')
    .update({
      state: 'failed',
      send_error: reason.slice(0, 500),
      send_attempts: (current?.send_attempts ?? 0) + 1,
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()
  if (error) raise(error.message)
  await recordEvent(id, 'sending', 'failed', 'system', { reason: reason.slice(0, 200) })
  return data as OutreachRow
}

export async function recordOutcome(
  userId: string,
  id: string,
  outcome: Outcome,
  note?: string
): Promise<OutreachRow> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('outreach')
    .update({ outcome, outcome_at: new Date().toISOString(), outcome_note: note ?? null })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()
  if (error) raise(error.message)
  if (!data) throw new Error('Outreach not found')
  await recordEvent(id, null, (data as OutreachRow).state, 'user', { outcome })
  return data as OutreachRow
}

/** Free-form patch for the reply/follow-up columns, which are not state moves. */
export async function patchOutreach(
  userId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<OutreachRow> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('outreach')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()
  if (error) raise(error.message)
  if (!data) throw new Error('Outreach not found')
  return data as OutreachRow
}

// ─── Events ──────────────────────────────────────────────────────────────────

export async function recordEvent(
  outreachId: string,
  from: OutreachState | null,
  to: OutreachState,
  actor: 'user' | 'system' | 'agent',
  detail: Record<string, unknown>
): Promise<void> {
  const supabase = createServiceClient()
  // Best-effort: losing an audit line must never fail the action it describes.
  await supabase
    .from('outreach_events')
    .insert({ outreach_id: outreachId, from_state: from, to_state: to, actor, detail })
}

export function parseState(v: unknown): OutreachState {
  if (!isOutreachState(v)) throw new Error(`Unknown outreach state: ${String(v)}`)
  return v
}
