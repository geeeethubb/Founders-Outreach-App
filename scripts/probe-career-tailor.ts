// LIVE probe for résumé tailoring and the cover letter. Costs money.
//
// Requires ANTHROPIC_API_KEY in .env.local; exits 2 without it. Every agent
// call is cached by input, so a re-run with the same fixture is free.
//
//   npx tsx scripts/probe-career-tailor.ts
//
// Three parts:
//   1. a realistic Summer 2027 process-excellence JD → the tailoring pipeline,
//      every change printed with level, verdict and clauses
//   2. an ADVERSARIAL JD demanding credentials the bank does not contain →
//      asserts no SUPPORTED change carries them (the fact guarantee)
//   3. one cover letter against three stubbed research points → printed with
//      its grounding result

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { buildFixtureBank, CTX } from './test-career-tailor'

const REALISTIC_JD = {
  title: 'Manufacturing Engineering Intern (Process Excellence) — Summer 2027',
  company: 'Northwind Consumer Products',
  key_requirements: [
    'Pursuing a BS in Chemical, Mechanical or Industrial Engineering, graduating Dec 2027 – Jun 2028',
    'Exposure to lean manufacturing or continuous improvement methods',
    'Comfort with data analysis (Excel, Python or similar)',
    'Experience working with cross-functional teams on the plant floor',
    'Strong written communication; able to document standard work',
    'Preferred: experience with quality systems or risk assessments',
    'Preferred: interest in automation and digital tools for operations',
  ],
  responsibilities: [
    'Support process excellence projects on packaging lines',
    'Analyze line performance data and identify loss drivers',
    'Draft and validate standard operating procedures',
    'Partner with quality and operations on risk mitigation',
  ],
  description_excerpt:
    'Northwind is a consumer products manufacturer with plants across the Midwest. The Process Excellence intern joins a plant team to reduce losses on high-speed packaging lines, standardize work, and pilot digital tools with line leaders.',
}

const ADVERSARIAL_JD = {
  title: 'Process Excellence Intern — Summer 2027',
  company: 'Northwind Consumer Products',
  key_requirements: [
    'Six Sigma Black Belt certification required',
    'Hands-on SAP PM experience',
    'Delivered a $10M cost-out program',
    'Kubernetes and Palantir Foundry',
  ],
  responsibilities: ['Lead a $10M cost-out program', 'Administer SAP PM work orders'],
  description_excerpt: 'Only Six Sigma Black Belts with SAP PM and a $10M cost-out on their résumé will be considered.',
}

const EVIDENCE_MAP = {
  why_i_fit:
    'Hands-on plant-floor quality and process work at a large CPG site, with quantified savings, SOP validation and stakeholder coordination.',
  emphasize: ['Controlled State pilot and $4M+ roadmap', 'SOP validation with $300K+ scrap reduction', 'Quality risk assessment across 4 teams'],
  do_not_claim: ['Six Sigma certification', 'SAP experience', 'any savings figure not on the résumé'],
  top_experience_ids: ['png_controlled_state', 'png_sop_shelf_life', 'png_quality_risk'],
}

const FORBIDDEN = [/six sigma/i, /black belt/i, /\bSAP\b/, /\$10M/i, /kubernetes/i, /palantir/i]

async function main() {
  const { anthropicAvailable } = await import('../lib/providers/anthropic/client')
  if (!anthropicAvailable()) {
    console.log('ANTHROPIC_API_KEY not set — live probe skipped.')
    process.exit(2)
  }
  const { runTailoringPipeline } = await import('../lib/career/tailor/pipeline')
  const { runCoverLetterPipeline } = await import('../lib/career/letter/pipeline')

  const bank = buildFixtureBank()
  let total = 0
  let failed = 0

  const printRun = (label: string, r: Awaited<ReturnType<typeof runTailoringPipeline>>) => {
    console.log(`\n=== ${label} ===`)
    if (r.error) console.log(`ERROR: ${r.error}`)
    console.log(`summary: ${r.summary}`)
    if (r.no_change_reason) console.log(`no change: ${r.no_change_reason}`)
    console.log(`distance: ${JSON.stringify(r.distance)} · cost $${r.costUsd.toFixed(4)} · runs ${r.runs.length}`)
    for (const c of r.changes) {
      console.log(`\n- ${c.change_type} L${c.edit_level} [${c.experience_id}] → ${c.verification_result} / ${c.review_status}`)
      console.log(`  requirement: ${c.job_requirement}`)
      if (c.original_text) console.log(`  original: ${c.original_text}`)
      if (c.proposed_text) console.log(`  proposed: ${c.proposed_text}`)
      console.log(`  facts: ${c.evidence_fact_ids.join(', ')}`)
      if (c.precheck_findings?.blocking.length) console.log(`  precheck BLOCK: ${c.precheck_findings.blocking.map((f) => `${f.kind}:${f.span}`).join('; ')}`)
      if (c.precheck_findings?.warnings.length) console.log(`  precheck warn: ${c.precheck_findings.warnings.map((f) => `${f.kind}:${f.span}`).join('; ')}`)
      for (const cl of c.verification_clauses ?? []) console.log(`    ${cl.verdict.padEnd(11)} ${cl.clause}${cl.fact_ids.length ? ` [${cl.fact_ids.join(',')}]` : ''}${cl.note ? ` — ${cl.note}` : ''}`)
      if (c.verification_notes) console.log(`  notes: ${c.verification_notes}`)
    }
    if (r.rejected.length) {
      console.log(`\nrejected at validation (${r.rejected.length}):`)
      for (const x of r.rejected) console.log(`  - ${x.change.change_type} ${x.change.bullet_id ?? 'new'}: ${x.reason}`)
    }
    total += r.costUsd
  }

  // 1. Realistic
  const real = await runTailoringPipeline({
    bank, job: REALISTIC_JD, evidenceMap: EVIDENCE_MAP, ctx: CTX,
    onStep: (s) => console.log(`  [${s.stage}] ${s.detail}`),
  })
  printRun('REALISTIC JD', real)

  // 2. Adversarial
  const adv = await runTailoringPipeline({
    bank, job: ADVERSARIAL_JD, evidenceMap: { ...EVIDENCE_MAP, do_not_claim: [] }, ctx: CTX,
    onStep: (s) => console.log(`  [${s.stage}] ${s.detail}`),
  })
  printRun('ADVERSARIAL JD', adv)
  const leaks = adv.changes.filter(
    (c) => c.verification_result === 'SUPPORTED' && FORBIDDEN.some((re) => re.test(c.final_text ?? ''))
  )
  if (leaks.length) {
    failed++
    console.log(`\nFAIL: ${leaks.length} SUPPORTED change(s) carry forbidden terms:`)
    for (const l of leaks) console.log(`  ${l.final_text}`)
  } else {
    console.log(`\nOK: no SUPPORTED change contains Six Sigma / SAP PM / $10M / Kubernetes / Palantir (${adv.changes.length} proposed, ${adv.changes.filter((c) => c.review_status === 'auto_rejected').length} auto-rejected).`)
  }

  // 3. Cover letter
  const letter = await runCoverLetterPipeline({
    bank,
    job: {
      title: REALISTIC_JD.title, company: REALISTIC_JD.company, location: 'Cincinnati, OH',
      summary: REALISTIC_JD.description_excerpt,
    },
    companyResearch: {
      summary: 'Northwind Consumer Products makes household and personal-care goods at four Midwest plants.',
      points: [
        { id: 'rf-stub-1', text: 'Northwind announced a $120M expansion of its Cincinnati packaging plant in March 2026.' },
        { id: 'rf-stub-2', text: 'Northwind runs a Digital Plant program that pilots line-level dashboards with operators.' },
        { id: 'rf-stub-3', text: 'Northwind reported scrap reduction as a company-wide 2026 priority in its annual sustainability report.' },
      ],
    },
    evidenceMap: { why_i_fit: EVIDENCE_MAP.why_i_fit, fact_ids: [], story_ids: [], top_experience_ids: EVIDENCE_MAP.top_experience_ids },
    ctx: CTX,
    user: { name: 'Zuyu Liu' },
    onStep: (s) => console.log(`  [letter ${s.attempt}] ${s.detail}`),
  })
  console.log('\n=== COVER LETTER ===')
  if (letter.error) console.log(`ERROR: ${letter.error}`)
  console.log(letter.fullText ?? '(none)')
  console.log(`\nwords ${letter.wordCount} · attempts ${letter.attempts} · flagged ${letter.flagged} · cost $${letter.costUsd.toFixed(4)}`)
  console.log(`claims (${letter.claims.length}): ${letter.claims.map((c) => `${c.kind}:${c.research_fact_id ?? c.evidence_fact_id}`).join(', ')}`)
  if (letter.grounding) {
    console.log(`grounding ok=${letter.grounding.ok} blocking=${letter.grounding.blocking.length} warnings=${letter.grounding.warnings.length}`)
    for (const f of letter.grounding.blocking) console.log(`  BLOCK ${f.kind}: "${f.span}" — ${f.reason}`)
    for (const f of letter.grounding.warnings) console.log(`  warn  ${f.kind}: "${f.span}"`)
  }
  total += letter.costUsd
  if (letter.error) failed++

  console.log(`\nTOTAL COST $${total.toFixed(4)}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
