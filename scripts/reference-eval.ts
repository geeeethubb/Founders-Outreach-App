// Campaign-reference writing eval.
//
//   npm run eval:reference                 all four campaigns, with the control
//   npm run eval:reference -- --no-control  reference mode only (half the cost)
//   npm run eval:reference -- --campaign mentor
//   npm run eval:reference -- --show        print every draft in full

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null
}
const flag = (name: string) => process.argv.includes(`--${name}`)

function bar(score: number): string {
  const filled = Math.round(score)
  return '█'.repeat(filled) + '·'.repeat(5 - filled)
}

async function main() {
  const { runReferenceEval } = await import('../evals/reference/run')
  const { REFERENCE_CAMPAIGNS } = await import('../evals/reference/campaigns')
  const { createServiceClient } = await import('../lib/supabase/server')

  const supabase = createServiceClient()
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
  const userId = profiles?.[0]?.id ?? '00000000-0000-0000-0000-000000000000'

  const only = arg('campaign')
  const campaigns = only ? REFERENCE_CAMPAIGNS.filter((c) => c.key === only) : REFERENCE_CAMPAIGNS
  if (campaigns.length === 0) {
    console.error(`No campaign "${only}". Known: ${REFERENCE_CAMPAIGNS.map((c) => c.key).join(', ')}`)
    process.exit(1)
  }

  const started = Date.now()
  const result = await runReferenceEval({
    userId,
    campaigns,
    skipControl: flag('no-control'),
    onProgress: (m) => console.log(m),
  })

  console.log('\n' + '═'.repeat(78))
  console.log('CAMPAIGN REFERENCE WRITING — EVAL REPORT')
  console.log('═'.repeat(78))
  console.log(`Elapsed: ${Math.round((Date.now() - started) / 1000)}s`)

  console.log('\n─── What the writer learned from each reference ───')
  for (const s of result.styles) {
    console.log(`\n  ${s.campaign}  (${s.referenceWords} words → target ${s.targetWords.min}-${s.targetWords.max})`)
    console.log(`    human description: ${s.expected}`)
    console.log(`    system read it as: ${s.summary}`)
    console.log(`    structure: ${s.structure.join(' → ')}`)
    if (s.distinctiveMoves.length) console.log(`    distinctive: ${s.distinctiveMoves.join(' · ')}`)
    if (s.recipientSpecific.length) {
      console.log(`    will not reuse: ${s.recipientSpecific.slice(0, 4).join(' · ')}`)
    }
  }

  console.log('\n─── Per draft ───')
  for (const d of result.drafts.filter((x) => x.mode === 'reference')) {
    const j = d.judgement
    const control = result.drafts.find((x) => x.mode === 'control' && x.campaign === d.campaign && x.prospect === d.prospect)
    console.log(`\n  ${d.campaign} → ${d.prospect}`)
    if (d.error) {
      console.log(`    FAILED: ${d.error}`)
      continue
    }
    console.log(
      `    ${d.wordCount} words (reference ${d.checks.referenceWords}, ratio ${d.checks.lengthRatio})` +
        (control ? ` · control wrote ${control.wordCount}` : '')
    )
    if (j) {
      console.log(`    similarity   ${bar(j.reference_similarity)} ${j.reference_similarity}${control?.judgement ? `   (control ${control.judgement.reference_similarity})` : ''}`)
      console.log(`    relevance    ${bar(j.recipient_relevance)} ${j.recipient_relevance}`)
      console.log(`    grounding    ${bar(j.fact_grounding)} ${j.fact_grounding}`)
      console.log(`    naturalness  ${bar(j.naturalness)} ${j.naturalness}`)
      console.log(`    cta fit      ${bar(j.cta_fit)} ${j.cta_fit}`)
      console.log(`    not-a-copy   ${bar(j.template_avoidance)} ${j.template_avoidance}`)
      console.log(`    same writer? ${j.same_writer ? 'YES' : 'no'}${control?.judgement ? ` (control: ${control.judgement.same_writer ? 'YES' : 'no'})` : ''}`)
      console.log(`    strongest: ${j.strongest}`)
      console.log(`    weakest:   ${j.weakest}`)
    }
    const problems: string[] = []
    if (d.checks.placeholders.length) problems.push(`PLACEHOLDERS: ${d.checks.placeholders.join(', ')}`)
    if (d.checks.copiedFromReference.length) problems.push(`COPIED: ${d.checks.copiedFromReference.join(' | ')}`)
    if (d.checks.verbatimSpans.length) problems.push(`VERBATIM: "${d.checks.verbatimSpans.join('", "')}"`)
    if (d.checks.overCompressed) problems.push(`OVER-COMPRESSED (${d.checks.lengthRatio}× the reference)`)
    if (d.checks.overLong) problems.push(`OVER-LONG (${d.checks.lengthRatio}×)`)
    if (d.checks.arrogance.length) problems.push(`ARROGANCE: ${d.checks.arrogance.join(', ')}`)
    if (d.checks.fakeFamiliarity.length) problems.push(`FAKE FAMILIARITY: ${d.checks.fakeFamiliarity.join(', ')}`)
    if (d.checks.aiTells.length) problems.push(`AI TELLS: ${d.checks.aiTells.join(', ')}`)
    if (d.groundingBlocking > 0) problems.push(`GROUNDING GATE BLOCKED: ${d.groundingFindings.join(' | ')}`)
    console.log(problems.length ? `    ⚠ ${problems.join('\n    ⚠ ')}` : '    ✓ all deterministic checks pass')

    if (flag('show')) {
      console.log(`\n    ── Subject: ${d.subject}`)
      console.log(d.body.split('\n').map((l) => `    ${l}`).join('\n'))
      if (control) {
        console.log(`\n    ── CONTROL (house style) Subject: ${control.subject}`)
        console.log(control.body.split('\n').map((l) => `    ${l}`).join('\n'))
      }
    }
  }

  const t = result.totals
  console.log('\n' + '═'.repeat(78))
  console.log('TOTALS')
  console.log('═'.repeat(78))
  console.log(`  reference similarity     ${t.referenceSimilarity.toFixed(2)} / 5`)
  if (!flag('no-control')) {
    console.log(`  control  similarity      ${t.controlSimilarity.toFixed(2)} / 5   ← house style, no reference`)
    console.log(`  DELTA                    ${t.similarityDelta >= 0 ? '+' : ''}${t.similarityDelta.toFixed(2)}`)
    console.log(`  "same writer" rate       ${(t.sameWriterRate * 100).toFixed(0)}%  (control ${(t.controlSameWriterRate * 100).toFixed(0)}%)`)
    console.log(`  over-compressed rate     ${(t.overCompressedRate * 100).toFixed(0)}%  (control ${(t.controlOverCompressedRate * 100).toFixed(0)}%)`)
  }
  console.log(`  recipient relevance      ${t.recipientRelevance.toFixed(2)} / 5`)
  console.log(`  fact grounding           ${t.factGrounding.toFixed(2)} / 5`)
  console.log(`  naturalness              ${t.naturalness.toFixed(2)} / 5`)
  console.log(`  CTA fit                  ${t.ctaFit.toFixed(2)} / 5`)
  console.log(`  template avoidance       ${t.templateAvoidance.toFixed(2)} / 5`)
  console.log(`  overall                  ${t.overall.toFixed(2)} / 5`)
  console.log(`  placeholders (reference) ${t.placeholderCount}`)
  console.log(`  placeholders (control)   ${t.controlPlaceholderCount}`)
  console.log(`  copied from reference    ${t.copiedFromReferenceCount}`)
  console.log(`  deterministic pass rate  ${(t.deterministicPassRate * 100).toFixed(0)}%`)
  console.log(`  writing cost             $${result.costUsd.toFixed(4)}`)
  console.log(`  judging cost             $${result.judgeCostUsd.toFixed(4)}`)

  if (result.errors.length) {
    console.log('\n─── Issues ───')
    for (const e of result.errors) console.log(`  · ${e}`)
  }

  const out = path.join(process.cwd(), '.eval-out')
  fs.mkdirSync(out, { recursive: true })
  const file = path.join(out, `reference-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(`\nFull result: ${path.relative(process.cwd(), file)}`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
