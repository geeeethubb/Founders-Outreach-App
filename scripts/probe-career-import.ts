// LIVE PROBE — runs the Resume Importer on the real master résumé, no DB writes.
//
//   npx tsx scripts/probe-career-import.ts
//
// Requires ANTHROPIC_API_KEY; exits 0 with a message otherwise. The result is
// cached by input hash, so a second run is free. Nothing here is committed —
// the résumé is untracked and its content stays on this machine.

import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('probe-career-import: ANTHROPIC_API_KEY not set — skipping live probe')
    return
  }
  const file = path.join(process.cwd(), 'Zuyu_Resume.docx')
  if (!fs.existsSync(file)) {
    console.log(`probe-career-import: ${file} not found — skipping`)
    return
  }
  const { importFromResume } = await import('../lib/career/evidence/import')

  console.log('\nRESUME IMPORTER — live probe (dry, no persistence)\n')
  const started = Date.now()
  const p = await importFromResume('probe', fs.readFileSync(file), {
    filename: path.basename(file),
    onStep: (s) => console.log(`  step ${s.step} · ${s.stopReason ?? '?'} · ${Math.round(s.elapsedMs / 1000)}s · ${s.toolCalls.join(',') || 'no tool'}`),
  })

  if (p.agentError) {
    console.error(`\nimporter failed: ${p.agentError}`)
    process.exit(1)
  }

  for (const e of p.experiences) {
    const facts = p.facts.filter((f) => f.experience_key === e.key)
    const metrics = p.metrics.filter((m) => m.experience_key === e.key)
    const deliverables = p.deliverables.filter((d) => d.experience_key === e.key)
    console.log(`\n${e.title} — ${e.organization} [${e.kind}] · ${e.bulletParagraphIndexes.length} bullets`)
    if (e.summary) console.log(`  ${e.summary}`)
    for (const f of facts) console.log(`  · (${f.category}) ${f.statement}   [${f.source_location}]`)
    for (const m of metrics) console.log(`  # ${m.value}${m.unit ? ` ${m.unit}` : ''}${m.context ? ` — ${m.context}` : ''}  facts→${m.fact_refs.length}`)
    for (const d of deliverables) console.log(`  ▸ ${d.description}`)
  }
  console.log(`\nSKILLS (${p.skills.length}): ${p.skills.map((s) => `${s.name} (${s.category})`).join(', ')}`)
  console.log(
    `\nTOTALS  experiences ${p.experiences.length} · bullets ${p.bullets.length} · facts ${p.facts.length} · metrics ${p.metrics.length} · skills ${p.skills.length} · deliverables ${p.deliverables.length}`
  )
  console.log(
    `DROPPED unverifiable ${p.dropped.unverifiable} · metrics ${p.dropped.metrics} · skills ${p.dropped.skills} · misfiled ${p.dropped.misfiled} · experiences ${p.dropped.experiences}`
  )
  const t = p.trace
  if (t) {
    console.log(
      `COST    $${t.cost_usd.toFixed(4)} · ${t.tokens_in} in / ${t.tokens_out} out · ${t.model} · ${t.steps} steps${t.from_cache ? ' · from cache' : ''}`
    )
  }
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s\n`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
