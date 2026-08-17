// Campaign reference emails: store, analyse, cache.
//
// A campaign's reference email is one real email the user wrote, which defines
// how that campaign should sound. It is a STYLE, STRUCTURE and INTENT example —
// never a fill-in-the-blank template, which is why nothing here parses it for
// variables and nothing ever will.
//
// The Style Analyst runs at most once per (reference, audience, notes). The hash
// is stored beside the analysis, so opening ten prospects in a campaign costs
// one analysis, not ten.
//
// Deterministic throughout except the one agent call. Degrades gracefully
// without migration 013, matching lib/scouting/persist.ts.

import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import {
  runStyleAnalyst,
  styleAnalystPrompt,
  measureEmail,
  targetWordsFor,
  type ReferenceStyle,
} from '@/lib/agents/style-analyst'
import type { OutreachReference } from '@/lib/agents/outreach'
import type { ToolContext } from '@/lib/agents/runtime/types'

export class ReferenceMigrationMissingError extends Error {
  constructor() {
    super('Migration 013_network_and_reference.sql has not been applied — run it in the Supabase SQL editor.')
    this.name = 'ReferenceMigrationMissingError'
  }
}

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache|could not find/i.test(message)
}

export interface CampaignReference {
  campaignId: string
  campaignName: string
  campaignGoal: string | null
  subject: string | null
  body: string | null
  notes: string | null
  targetAudience: string | null
  style: ReferenceStyle | null
  styleVersion: string | null
  /** True when the stored style was produced from the stored reference. */
  styleCurrent: boolean
  updatedAt: string | null
}

export function referenceHash(input: {
  subject: string | null
  body: string
  notes: string | null
  targetAudience: string | null
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        s: input.subject ?? '',
        b: input.body,
        n: input.notes ?? '',
        a: input.targetAudience ?? '',
        v: styleAnalystPrompt.version,
      })
    )
    .digest('hex')
    .slice(0, 32)
}

export async function getCampaignReference(
  userId: string,
  campaignId: string
): Promise<CampaignReference | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('campaigns')
    .select(
      'id, name, goal, reference_subject, reference_body, reference_notes, target_audience, reference_style, reference_style_version, reference_hash, reference_updated_at'
    )
    .eq('user_id', userId)
    .eq('id', campaignId)
    .maybeSingle()

  if (error) {
    if (isMissingSchema(error.message)) throw new ReferenceMigrationMissingError()
    throw new Error(error.message)
  }
  if (!data) return null

  const body = (data.reference_body as string | null) ?? null
  const style = (data.reference_style as ReferenceStyle | null) ?? null
  const currentHash = body
    ? referenceHash({
        subject: data.reference_subject ?? null,
        body,
        notes: data.reference_notes ?? null,
        targetAudience: data.target_audience ?? null,
      })
    : null

  return {
    campaignId: data.id,
    campaignName: data.name,
    campaignGoal: data.goal ?? null,
    subject: data.reference_subject ?? null,
    body,
    notes: data.reference_notes ?? null,
    targetAudience: data.target_audience ?? null,
    style,
    styleVersion: data.reference_style_version ?? null,
    styleCurrent: Boolean(style && currentHash && data.reference_hash === currentHash),
    updatedAt: data.reference_updated_at ?? null,
  }
}

export interface SaveReferenceInput {
  subject?: string | null
  body: string
  notes?: string | null
  targetAudience?: string | null
}

/**
 * Store a reference email.
 *
 * The stored style is CLEARED, not kept: a style analysis of a different email
 * is worse than none, because it looks current. It is recomputed on the next
 * draft, or immediately by `ensureReferenceStyle`.
 */
export async function saveCampaignReference(
  userId: string,
  campaignId: string,
  input: SaveReferenceInput
): Promise<CampaignReference> {
  const body = input.body.trim()
  if (!body) throw new Error('A reference email body is required.')
  if (body.split(/\s+/).filter(Boolean).length < 20) {
    throw new Error('That reference is too short to learn a voice from — paste a real email, at least ~20 words.')
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('campaigns')
    .update({
      reference_subject: input.subject?.trim() || null,
      reference_body: body,
      reference_notes: input.notes?.trim() || null,
      target_audience: input.targetAudience?.trim() || null,
      reference_style: null,
      reference_style_version: null,
      reference_hash: null,
      reference_updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('id', campaignId)

  if (error) {
    if (isMissingSchema(error.message)) throw new ReferenceMigrationMissingError()
    throw new Error(error.message)
  }

  const loaded = await getCampaignReference(userId, campaignId)
  if (!loaded) throw new Error('Campaign not found')
  return loaded
}

export async function clearCampaignReference(userId: string, campaignId: string): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('campaigns')
    .update({
      reference_subject: null,
      reference_body: null,
      reference_notes: null,
      reference_style: null,
      reference_style_version: null,
      reference_hash: null,
      reference_updated_at: null,
    })
    .eq('user_id', userId)
    .eq('id', campaignId)
  if (error) {
    if (isMissingSchema(error.message)) throw new ReferenceMigrationMissingError()
    throw new Error(error.message)
  }
}

export interface EnsureStyleResult {
  reference: CampaignReference
  style: ReferenceStyle | null
  /** True when this call paid for an analysis rather than reusing one. */
  analysed: boolean
  costUsd: number
  error: string | null
}

/**
 * Return the campaign's style analysis, computing and storing it if the stored
 * one does not match the stored reference.
 */
export async function ensureReferenceStyle(
  userId: string,
  campaignId: string,
  ctx: ToolContext
): Promise<EnsureStyleResult> {
  const reference = await getCampaignReference(userId, campaignId)
  if (!reference) throw new Error('Campaign not found')
  if (!reference.body) {
    return { reference, style: null, analysed: false, costUsd: 0, error: null }
  }
  if (reference.styleCurrent && reference.style) {
    return { reference, style: reference.style, analysed: false, costUsd: 0, error: null }
  }

  const measured = measureEmail(reference.body)
  const run = await runStyleAnalyst(
    {
      campaignName: reference.campaignName,
      campaignGoal: reference.campaignGoal,
      targetAudience: reference.targetAudience,
      notes: reference.notes,
      reference: { subject: reference.subject, body: reference.body },
      measured,
    },
    ctx
  )

  if (!run.output) {
    return { reference, style: null, analysed: false, costUsd: run.trace.cost_usd, error: run.error }
  }

  const style: ReferenceStyle = { ...run.output, measured, target_words: targetWordsFor(measured) }
  const hash = referenceHash({
    subject: reference.subject,
    body: reference.body,
    notes: reference.notes,
    targetAudience: reference.targetAudience,
  })

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('campaigns')
    .update({
      reference_style: style as unknown as Record<string, unknown>,
      reference_style_version: styleAnalystPrompt.version,
      reference_hash: hash,
    })
    .eq('user_id', userId)
    .eq('id', campaignId)

  return {
    reference: { ...reference, style, styleVersion: styleAnalystPrompt.version, styleCurrent: true },
    style,
    analysed: true,
    costUsd: run.trace.cost_usd,
    // A failure to CACHE the analysis must not lose it — the draft still gets
    // written, it just costs an analysis again next time.
    error: error ? `style not cached: ${error.message.slice(0, 120)}` : null,
  }
}

/** Shape the writer wants, or null when this campaign has no reference. */
export function toOutreachReference(reference: CampaignReference, style: ReferenceStyle): OutreachReference {
  return {
    campaignName: reference.campaignName,
    campaignGoal: reference.campaignGoal,
    targetAudience: reference.targetAudience,
    notes: reference.notes,
    subject: reference.subject,
    body: reference.body ?? '',
    style,
  }
}

/** Campaigns that have a reference, for a picker. */
export async function listCampaignsWithReference(
  userId: string
): Promise<{ id: string; name: string; hasReference: boolean; words: number | null }[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, name, reference_body')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    if (isMissingSchema(error.message)) throw new ReferenceMigrationMissingError()
    throw new Error(error.message)
  }

  return (data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    hasReference: Boolean(c.reference_body),
    words: c.reference_body ? String(c.reference_body).split(/\s+/).filter(Boolean).length : null,
  }))
}
