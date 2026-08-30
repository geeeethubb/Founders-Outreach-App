// Repair for letters that carried the email local-part as the applicant's name.
//
// The signup trigger set profiles.name to "zuyu.alex06"; letterSigner trusted
// it; every letter before the identity resolver opened and signed with it.
// This module finds those tokens in stored cover_letters rows, rewrites them
// to the resolved real name, and — because a rendered document can never be
// overwritten in place (saveDocument is upsert:false, and a locked package is
// what was submitted) — produces a NEW package version with the corrected
// letter rendered, through finishPackage's `letterFromStored` path. No model
// call: the résumé patch and the letter body are reused verbatim.
//
// The pure half (token detection and rewriting) has no I/O so it can be
// tested offline; `repairLetterNames` is the DB walk the script drives.

import { loadEvidenceBank } from '../evidence/store'
import { isEmailLikeName, resolveApplicantName, type ApplicantName } from '../identity'
import type { ApplicationPackage, CoverLetter, PackageStatus } from '../types'
import { finishPackage } from './orchestrator'
import { getPackage, loadProfile, updateCoverLetter } from './persist'
import { clonePackageVersion } from './redo'

/** Letter text columns the repair may rewrite. `paragraphs` is handled element-wise. */
export const LETTER_TEXT_FIELDS = ['greeting', 'closing', 'full_text', 'edited_text'] as const

/** Package statuses whose current letter gets re-rendered as a new version. Superseded packages are history: text only. */
const RERENDER_STATUSES = new Set<PackageStatus>(['locked', 'ready_to_apply', 'ready_for_review'])

/** The tokens a profile could have leaked into a letter: the email local-part, and profiles.name when it is one. */
export function profileNameTokens(profile: { name: string | null; email: string | null }): string[] {
  const out = new Set<string>()
  const local = (profile.email ?? '').split('@')[0]?.trim()
  if (local && isEmailLikeName(local)) out.add(local)
  const name = (profile.name ?? '').trim()
  if (name && isEmailLikeName(name)) out.add(name)
  return [...out]
}

/** The last non-empty block of a letter, which is where the signature stands. */
function signatureLine(text: string | null): string | null {
  if (!text) return null
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  return blocks.length ? blocks[blocks.length - 1] : null
}

/**
 * Every email-like token standing where a name should in this letter: the
 * profile's tokens, plus a signature line that is itself email-like (a letter
 * written under a profile the founder has since corrected).
 */
export function emailNameTokensIn(letter: Pick<CoverLetter, 'full_text' | 'edited_text'>, profileTokens: string[]): string[] {
  const out = new Set(profileTokens)
  for (const sig of [signatureLine(letter.full_text), signatureLine(letter.edited_text)]) {
    if (sig && isEmailLikeName(sig)) out.add(sig)
  }
  return [...out]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace each token where it stands alone (not inside a longer local-part or an address), case-insensitively. */
export function replaceNameTokens(text: string, tokens: string[], realName: string): { text: string; replaced: number } {
  let out = text
  let replaced = 0
  for (const token of tokens) {
    if (!token) continue
    const re = new RegExp(`(^|[^A-Za-z0-9._+@-])${escapeRegExp(token)}(?=$|[^A-Za-z0-9._+@-])`, 'gi')
    out = out.replace(re, (_m, pre: string) => {
      replaced++
      return `${pre}${realName}`
    })
  }
  return { text: out, replaced }
}

export interface LetterTextRepair {
  /** Column names that changed (`paragraphs[i]` for a paragraph). */
  fields: string[]
  replaced: number
  patch: Partial<CoverLetter>
}

/** Pure: the patch that rewrites every email-like name token in a letter row to the real name. */
export function repairLetterText(letter: CoverLetter, tokens: string[], realName: string): LetterTextRepair {
  const fields: string[] = []
  let replaced = 0
  const patch: Partial<CoverLetter> = {}
  if (!tokens.length) return { fields, replaced, patch }
  for (const f of LETTER_TEXT_FIELDS) {
    const v = letter[f]
    if (!v) continue
    const r = replaceNameTokens(v, tokens, realName)
    if (r.replaced) {
      fields.push(f)
      replaced += r.replaced
      patch[f] = r.text
    }
  }
  const paragraphs = Array.isArray(letter.paragraphs) ? letter.paragraphs : []
  let paraChanged = false
  const fixed = paragraphs.map((p, i) => {
    const r = replaceNameTokens(p, tokens, realName)
    if (r.replaced) {
      fields.push(`paragraphs[${i}]`)
      replaced += r.replaced
      paraChanged = true
    }
    return r.text
  })
  if (paraChanged) patch.paragraphs = fixed
  return { fields, replaced, patch }
}

// ─── The DB walk ─────────────────────────────────────────────────────────────

export interface LetterRepairRow {
  letterId: string
  letterVersion: number
  packageId: string | null
  packageStatus: PackageStatus | null
  company: string | null
  tokens: string[]
  fields: string[]
  /** What happened to the documents: a new version, or why not. */
  newVersion: number | null
  newPackageId: string | null
  docs: { docx: boolean; pdf: boolean }
  qa: 'ok' | 'failed' | 'not rendered' | 'dry-run' | 'skipped'
  note: string | null
}

export interface LetterRepairResult {
  name: ApplicantName
  tokens: string[]
  rows: LetterRepairRow[]
  scanned: number
  errors: string[]
  migrationMissing: boolean
}

export async function repairLetterNames(params: {
  userId: string
  dryRun: boolean
  onRow?: (row: LetterRepairRow) => void
  onProgress?: (detail: string) => void
}): Promise<LetterRepairResult> {
  const errors: string[] = []
  const progress = params.onProgress ?? (() => {})
  const profile = await loadProfile(params.userId)
  const loaded = await loadEvidenceBank(params.userId)
  if (loaded.migrationMissing) return { name: { name: 'Applicant', source: 'fallback' }, tokens: [], rows: [], scanned: 0, errors, migrationMissing: true }
  errors.push(...loaded.errors)
  const name = resolveApplicantName({ profileName: profile.name, bank: loaded.bank })
  const profileTokens = profileNameTokens(profile)

  const { createServiceClient } = await import('@/lib/supabase/server')
  const db = createServiceClient()
  const { data, error } = await db.from('cover_letters').select('*').eq('user_id', params.userId).order('created_at', { ascending: true })
  if (error) return { name, tokens: profileTokens, rows: [], scanned: 0, errors: [...errors, error.message], migrationMissing: false }
  const letters = (data ?? []) as CoverLetter[]

  const rows: LetterRepairRow[] = []
  const packages = new Map<string, ApplicationPackage | null>()
  const pkgOf = async (id: string) => {
    if (!packages.has(id)) packages.set(id, (await getPackage(params.userId, id)).pkg)
    return packages.get(id) ?? null
  }
  // Cover_letters ids the packages currently point at — those are the ones whose documents are live.
  const jobCompany = new Map<string, string | null>()

  for (const letter of letters) {
    const tokens = emailNameTokensIn(letter, profileTokens)
    const repair = name.source === 'fallback' ? { fields: [], replaced: 0, patch: {} } : repairLetterText(letter, tokens, name.name)
    if (!repair.fields.length) continue
    const pkg = letter.package_id ? await pkgOf(letter.package_id) : null
    if (pkg && !jobCompany.has(pkg.job_id)) {
      const { data: job } = await db.from('job_opportunities').select('company_name').eq('id', pkg.job_id).maybeSingle()
      jobCompany.set(pkg.job_id, (job as { company_name?: string } | null)?.company_name ?? null)
    }
    const row: LetterRepairRow = {
      letterId: letter.id, letterVersion: letter.version, packageId: letter.package_id, packageStatus: pkg?.status ?? null,
      company: pkg ? jobCompany.get(pkg.job_id) ?? null : null, tokens, fields: repair.fields,
      newVersion: null, newPackageId: null, docs: { docx: false, pdf: false }, qa: params.dryRun ? 'dry-run' : 'skipped', note: null,
    }
    const current = pkg !== null && pkg.cover_letter_id === letter.id && RERENDER_STATUSES.has(pkg.status)
    if (!current) row.note = pkg ? `package ${pkg.status} and this is ${pkg.cover_letter_id === letter.id ? 'its letter' : 'not its current letter'} — text corrected, no re-render` : 'no package — text corrected only'

    if (!params.dryRun) {
      // 1. The old row's text, so the review UI never shows the email name again. The rendered files stay.
      const w = await updateCoverLetter(letter.id, repair.patch)
      if (w.error) {
        errors.push(`letter ${letter.id}: ${w.error}`)
        row.note = `text update failed: ${w.error}`
        rows.push(row)
        params.onRow?.(row)
        continue
      }
      // 2. A new version beside the package, rendered from the corrected text. Never in place.
      if (current && pkg) {
        progress(`v${pkg.version} → new version for ${row.company ?? pkg.job_id}`)
        const clone = await clonePackageVersion({ userId: params.userId, source: pkg })
        if (!clone.pkg) {
          errors.push(`package ${pkg.id}: ${clone.error}`)
          row.note = `new version not created: ${clone.error}`
        } else {
          row.newPackageId = clone.pkg.id
          row.newVersion = clone.pkg.version
          const corrected: CoverLetter = { ...letter, ...repair.patch }
          const fin = await finishPackage({ userId: params.userId, packageId: clone.pkg.id, letterFromStored: corrected, onProgress: (s, d) => progress(`${s}: ${d}`) })
          const after = (await getPackage(params.userId, clone.pkg.id)).pkg
          row.docs = { docx: Boolean(after?.cover_docx_path), pdf: Boolean(after?.cover_pdf_path) }
          const qa = after?.qa as unknown as { cover_letter?: { ok?: boolean } | null } | null
          row.qa = qa?.cover_letter ? (qa.cover_letter.ok ? 'ok' : 'failed') : 'not rendered'
          if (fin.error) {
            errors.push(`package ${clone.pkg.id}: ${fin.error}`)
            row.note = `new version ${fin.status ?? 'failed'}: ${fin.error}`
          } else if (fin.warnings.length) row.note = fin.warnings.join('; ')
        }
      }
    }
    rows.push(row)
    params.onRow?.(row)
  }

  return { name, tokens: profileTokens, rows, scanned: letters.length, errors, migrationMissing: false }
}
