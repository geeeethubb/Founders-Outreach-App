// Fix cover letters that carried the email local-part ("zuyu.alex06") as the
// applicant's name.
//
//   npm run career:fix-names -- --dry-run          what would change, no writes
//   npm run career:fix-names                       rewrite + re-render
//   npm run career:fix-names -- --user <id>        a specific user (default: first profile)
//
// For every cover_letters row whose text carries an email-like name token:
//   1. the row's text fields are rewritten to the resolved real name
//      (lib/career/identity.ts: profile → résumé name line → bank → env);
//   2. when the letter is the CURRENT letter of a locked / ready package, a
//      NEW package version is created beside it, carrying the same reviewed
//      résumé patch, and its documents are rendered from the corrected text
//      through finishPackage({ letterFromStored }) — no model call.
// Locked (submitted) packages and their files are never touched; the new
// version sits beside them. Nothing is submitted anywhere.

import { defaultProfiles } from './lib/cli-user'
import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { shutdownPdfRenderers } from '../lib/career/documents/pdf'
import { repairLetterNames, type LetterRepairRow } from '../lib/career/package/repair'

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

function cell(v: string | number | null | undefined, w: number): string {
  const s = v === null || v === undefined ? '—' : String(v)
  return s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w)
}

function printRow(r: LetterRepairRow): void {
  const docs = `${r.docs.docx ? 'docx' : '-'}/${r.docs.pdf ? 'pdf' : '-'}`
  console.log(
    `  ${cell(r.letterId.slice(0, 8), 9)} v${cell(r.letterVersion, 3)} ${cell(r.packageId?.slice(0, 8) ?? null, 9)} ${cell(r.packageStatus, 16)} ${cell(r.company, 18)} ` +
      `${cell(r.fields.join(','), 34)} ${cell(r.newVersion === null ? null : `v${r.newVersion}`, 5)} ${cell(docs, 9)} ${cell(r.qa, 12)}${r.note ? `  ${r.note}` : ''}`
  )
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run')
  let userId = opt('user')
  const { createServiceClient } = await import('../lib/supabase/server')
  if (!userId) {
    const { data } = await defaultProfiles()
    userId = (data?.[0] as { id: string } | undefined)?.id
  }
  if (!userId) throw new Error('no user — pass --user <id>')

  console.log(`${dryRun ? 'DRY RUN — ' : ''}user ${userId}`)
  console.log(`  ${cell('letter', 9)} ${cell('ver', 4)} ${cell('package', 9)} ${cell('pkg status', 16)} ${cell('company', 18)} ${cell('fields changed', 34)} ${cell('new', 5)} ${cell('docs', 9)} ${cell('QA', 12)}`)
  const r = await repairLetterNames({
    userId, dryRun,
    onRow: printRow,
    onProgress: (d) => console.log(`      … ${d}`),
  })
  if (r.migrationMissing) {
    console.error('migration 014_career_os.sql has not been applied')
    process.exitCode = 2
    return
  }
  console.log(`\nresolved name: "${r.name.name}" (source: ${r.name.source}) · profile tokens: ${r.tokens.length ? r.tokens.join(', ') : 'none'}`)
  console.log(`${r.scanned} letter(s) scanned, ${r.rows.length} carried an email-like name${dryRun ? ' (nothing written)' : ''}`)
  if (r.name.source === 'fallback') console.log('  no real name could be resolved (profile, résumé name line, bank, OUTREACH_SENDER_NAME) — nothing rewritten')
  for (const e of r.errors) console.log(`  error: ${e}`)
  process.exitCode = r.errors.length ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => shutdownPdfRenderers())
