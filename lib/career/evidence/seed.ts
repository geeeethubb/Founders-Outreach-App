// Seeding the Evidence Bank from the master résumé, end to end.
//
// document row → experiences + bullets → importer → facts, metrics, skills,
// deliverables → preferences → default mission. A master with the same sha256
// is reused; row-level idempotency lives in ./persist. Each stage's failure
// is collected, not thrown; the result says exactly what landed.

import crypto from 'crypto'
import { readDocx } from '../documents/docx-read'
import { saveDocument } from '../documents/store'
import { ensureDefaultMission } from '../missions/store'
import { startCareerRun } from '../runs'
import { createServiceClient } from '@/lib/supabase/server'
import {
  extraSourcesFromProfile,
  importFromResume,
  importFromText,
  type ExtraSourceText,
  type ImportProposal,
} from './import'
import { persistProposal, emptyCounts, type PersistOptions, type SeedCounts } from './persist'
import { seedDefaultPreferences } from './preferences'
import { isMissingSchema } from './store'

export { persistProposal }
export type { PersistOptions, SeedCounts }
import type { EvidenceBank, FactSource, ResumeDocument } from '../types'

export interface SeedResult {
  ok: boolean
  migrationMissing: boolean
  errors: string[]
  counts: SeedCounts
  dropped: ImportProposal['dropped']
  costUsd: number
  agentError: string | null
  proposal: ImportProposal | null
  runId: string | null
}

export interface SeedOptions {
  approve?: boolean
  includeProfile?: boolean
  /** Delete this user's evidence_* / resume_* rows first. A dev tool. */
  reset?: boolean
  /** Build the proposal, persist nothing. */
  dry?: boolean
  filename?: string
  extraSources?: ExtraSourceText[]
  onProgress?: (stage: string, detail: string) => void
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** One cheap select. True when migration 014 has been applied. */
export async function migrationApplied(): Promise<{ applied: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('evidence_experiences').select('id').limit(1)
  if (!error) return { applied: true, error: null }
  return { applied: !isMissingSchema(error.message), error: error.message }
}

const RESET_TABLES = [
  'resume_bullets', 'evidence_stories', 'evidence_deliverables', 'evidence_metrics',
  'evidence_skills', 'evidence_facts', 'evidence_experiences', 'resume_documents', 'evidence_preferences',
] as const

/** Deletes the user's bank, child tables first. Returns what was deleted, per table. */
export async function resetEvidence(userId: string): Promise<{ deleted: Record<string, number>; errors: string[] }> {
  const supabase = createServiceClient()
  const deleted: Record<string, number> = {}
  const errors: string[] = []
  for (const table of RESET_TABLES) {
    const { data, error } = await supabase.from(table).delete().eq('user_id', userId).select('id')
    if (error) errors.push(`${table}: ${error.message}`)
    else deleted[table] = data?.length ?? 0
  }
  return { deleted, errors }
}

/**
 * The master résumé row. A document with the same hash is reused; a new one
 * is saved under its short hash so two uploads never collide, and earlier
 * masters are demoted rather than deleted — a package generated from them
 * still points at a row that exists.
 */
export async function ensureMasterDocument(
  userId: string,
  buffer: Buffer,
  filename: string,
  paragraphMap: unknown,
  opts: { asMaster?: boolean } = {}
): Promise<{ document: ResumeDocument | null; reused: boolean; error: string | null; migrationMissing: boolean; warning?: string }> {
  const supabase = createServiceClient()
  const hash = sha256(buffer)
  const asMaster = opts.asMaster ?? true

  const { data: existing, error: readErr } = await supabase
    .from('resume_documents')
    .select('*')
    .eq('user_id', userId)
    .eq('sha256', hash)
    .limit(1)
  if (readErr) return { document: null, reused: false, error: readErr.message, migrationMissing: isMissingSchema(readErr.message) }
  if (existing?.length) {
    const doc = existing[0] as ResumeDocument
    if (asMaster && !doc.is_master) {
      await supabase.from('resume_documents').update({ is_master: false } as never).eq('user_id', userId).eq('is_master', true)
      await supabase.from('resume_documents').update({ is_master: true } as never).eq('id', doc.id)
      doc.is_master = true
    }
    return { document: doc, reused: true, error: null, migrationMissing: false }
  }

  let storagePath: string | null = null
  let warning: string | undefined
  try {
    const saved = await saveDocument({
      userId,
      relativePath: `resumes/master-${hash.slice(0, 8)}.docx`,
      data: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    storagePath = saved.storage_path
    warning = saved.warning
  } catch (e) {
    // A local file already at that path (same hash, row deleted by --reset) is
    // the one case; the row is what matters and the bytes are identical.
    warning = `document not re-saved: ${e instanceof Error ? e.message : String(e)}`
  }

  if (asMaster) {
    await supabase.from('resume_documents').update({ is_master: false } as never).eq('user_id', userId).eq('is_master', true)
  }
  const { data, error } = await supabase
    .from('resume_documents')
    .insert({
      user_id: userId,
      label: asMaster ? 'master' : 'alternate',
      is_master: asMaster,
      filename,
      storage_path: storagePath,
      sha256: hash,
      byte_size: buffer.length,
      paragraph_map: paragraphMap,
    } as never)
    .select('*')
    .single()
  if (error) return { document: null, reused: false, error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { document: data as ResumeDocument, reused: false, error: null, migrationMissing: false, warning }
}

// ─── End to end ──────────────────────────────────────────────────────────────

async function loadProfileSources(userId: string): Promise<ExtraSourceText[]> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('profiles')
    .select('resume_text, linkedin_bio_text, personal_context')
    .eq('id', userId)
    .maybeSingle()
  return data ? extraSourcesFromProfile(data as { resume_text?: string | null; linkedin_bio_text?: string | null; personal_context?: string | null }) : []
}

/**
 * The seed: document row → experiences + bullets → importer → facts, metrics,
 * skills, deliverables → preferences → default mission. Each stage's failure
 * is collected, not thrown; the result says exactly what landed.
 */
export async function seedEvidenceFromDocx(userId: string, buffer: Buffer, opts: SeedOptions = {}): Promise<SeedResult> {
  const progress = opts.onProgress ?? (() => {})
  const filename = opts.filename ?? 'resume.docx'
  const counts = emptyCounts()
  const errors: string[] = []

  // A dry run reads nothing and writes nothing, so it must work before the
  // migration exists — that is when the founder most wants to see the output.
  if (!opts.dry) {
    const gate = await migrationApplied()
    if (!gate.applied) {
      return { ok: false, migrationMissing: true, errors: [gate.error ?? 'migration missing'], counts, dropped: zeroDropped(), costUsd: 0, agentError: null, proposal: null, runId: null }
    }
  }

  if (opts.reset && !opts.dry) {
    progress('reset', 'deleting existing evidence rows')
    const r = await resetEvidence(userId)
    errors.push(...r.errors)
    progress('reset', Object.entries(r.deleted).map(([t, n]) => `${t}=${n}`).join(' '))
  }

  const file = await readDocx(buffer)
  const extra = [...(opts.extraSources ?? [])]
  if (opts.includeProfile) {
    const fromProfile = await loadProfileSources(userId)
    extra.push(...fromProfile)
    progress('profile', fromProfile.length ? `${fromProfile.length} profile field(s) included` : 'no profile text to include')
  }

  // A run row so the importer's agent_runs trace attaches somewhere.
  const run = opts.dry
    ? null
    : await startCareerRun({ userId, kind: 'evidence_import', label: `evidence-import/${filename}`, mission: { filename, approve: Boolean(opts.approve) } })

  progress('import', 'running the résumé importer')
  const proposal = await importFromResume(userId, file, {
    filename,
    extraSources: extra,
    onStep: (s) => progress('import', `step ${s.step} · ${s.stopReason ?? '?'} · ${Math.round(s.elapsedMs / 1000)}s`),
  })
  if (proposal.agentError) errors.push(`importer: ${proposal.agentError}`)
  const costUsd = proposal.trace?.cost_usd ?? 0
  if (run && proposal.trace) {
    await run.trace({ output: null, status: proposal.agentError ? 'failed' : 'succeeded', error: proposal.agentError, evidence: [], trace: proposal.trace })
  }

  if (opts.dry) {
    return { ok: !proposal.agentError, migrationMissing: false, errors, counts, dropped: proposal.dropped, costUsd, agentError: proposal.agentError, proposal, runId: null }
  }

  progress('document', 'saving the master document')
  const doc = await ensureMasterDocument(userId, buffer, filename, proposal.model?.map ?? [])
  if (doc.warning) errors.push(doc.warning)
  if (!doc.document) {
    errors.push(`document: ${doc.error}`)
    await run?.finish('failed', { errors: errors.length }, doc.error)
    return { ok: false, migrationMissing: doc.migrationMissing, errors, counts, dropped: proposal.dropped, costUsd, agentError: proposal.agentError, proposal, runId: run?.runId ?? null }
  }
  counts.documents = doc.reused ? 0 : 1
  counts.documentReused = doc.reused

  progress('persist', 'writing experiences, bullets, facts, metrics, skills')
  const persisted = await persistProposal(userId, proposal, { approve: Boolean(opts.approve), documentId: doc.document.id, counts })
  errors.push(...persisted.errors)

  progress('preferences', 'seeding default preferences')
  const prefs = await seedDefaultPreferences(userId)
  if (prefs.error) errors.push(`preferences: ${prefs.error}`)
  counts.preferences = prefs.inserted

  const mission = await ensureDefaultMission(userId)
  if (mission.error) errors.push(`mission: ${mission.error}`)
  counts.missionCreated = mission.created

  await run?.finish(errors.length && !counts.facts ? 'failed' : 'succeeded', { ...counts, dropped: proposal.dropped, errors: errors.length })
  return { ok: persisted.errors.length === 0 && !proposal.agentError, migrationMissing: false, errors, counts, dropped: proposal.dropped, costUsd, agentError: proposal.agentError, proposal, runId: run?.runId ?? null }
}

/** Pasted résumé / LinkedIn text → facts under agent-proposed experiences. */
export async function seedEvidenceFromText(
  userId: string,
  text: string,
  source: FactSource,
  opts: Pick<SeedOptions, 'approve' | 'dry' | 'onProgress'> & { label?: string } = {}
): Promise<SeedResult> {
  const counts = emptyCounts()
  const gate = await migrationApplied()
  if (!gate.applied) {
    return { ok: false, migrationMissing: true, errors: [gate.error ?? 'migration missing'], counts, dropped: zeroDropped(), costUsd: 0, agentError: null, proposal: null, runId: null }
  }
  const run = opts.dry ? null : await startCareerRun({ userId, kind: 'evidence_import', label: `evidence-import/text:${source}`, mission: { source } })
  const proposal = await importFromText(userId, text, source, { label: opts.label })
  const errors: string[] = []
  if (proposal.agentError) errors.push(`importer: ${proposal.agentError}`)
  const costUsd = proposal.trace?.cost_usd ?? 0
  if (run && proposal.trace) {
    await run.trace({ output: null, status: proposal.agentError ? 'failed' : 'succeeded', error: proposal.agentError, evidence: [], trace: proposal.trace })
  }
  if (opts.dry || proposal.agentError) {
    await run?.finish(proposal.agentError ? 'failed' : 'succeeded', { dry: true }, proposal.agentError)
    return { ok: !proposal.agentError, migrationMissing: false, errors, counts, dropped: proposal.dropped, costUsd, agentError: proposal.agentError, proposal, runId: run?.runId ?? null }
  }
  const persisted = await persistProposal(userId, proposal, { approve: Boolean(opts.approve), documentId: null, counts })
  errors.push(...persisted.errors)
  await run?.finish(persisted.errors.length ? 'failed' : 'succeeded', { ...counts, dropped: proposal.dropped })
  return { ok: persisted.errors.length === 0, migrationMissing: persisted.migrationMissing, errors, counts, dropped: proposal.dropped, costUsd, agentError: null, proposal, runId: run?.runId ?? null }
}

function zeroDropped(): ImportProposal['dropped'] {
  return { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0 }
}

/** Printable summary for scripts and API responses. */
export function summarizeSeed(result: SeedResult): string[] {
  const c = result.counts
  const lines = [
    `documents: ${c.documents}${c.documentReused ? ' (master reused — same sha256)' : ''}`,
    `experiences: ${c.experiences} new, ${c.experiencesReused} reused`,
    `bullets: ${c.bullets}`,
    `facts: ${c.facts}   metrics: ${c.metrics}   skills: ${c.skills}   deliverables: ${c.deliverables}`,
    `preferences: ${c.preferences} seeded   mission: ${c.missionCreated ? 'created' : 'existing'}`,
    `dropped — unverifiable numbers: ${result.dropped.unverifiable}, metrics: ${result.dropped.metrics}, skills: ${result.dropped.skills}, misfiled: ${result.dropped.misfiled}, experiences: ${result.dropped.experiences}`,
    `cost: $${result.costUsd.toFixed(4)}`,
  ]
  if (result.agentError) lines.push(`importer error: ${result.agentError}`)
  return lines
}

export type { EvidenceBank }
