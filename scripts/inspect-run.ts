// Inspects a persisted scouting run's agent outputs, to cluster failures without
// waiting for the whole eval suite to finish writing its JSON.
//
//   npx tsx scripts/inspect-run.ts [labelSubstring]

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

async function main() {
  const needle = process.argv[2] ?? 'agentic-eval'
  const { createServiceClient } = await import('../lib/supabase/server')
  const s = createServiceClient()

  const { data: runs } = await s
    .from('scouting_runs')
    .select('id, label, status, started_at')
    .like('label', `%${needle}%`)
    .order('started_at', { ascending: false })
    .limit(1)

  if (!runs?.length) {
    console.log('no matching run')
    return
  }
  const run = runs[0]
  console.log(`run: ${run.label} (${run.status})\n`)

  const { data: agentRuns } = await s
    .from('agent_runs')
    .select('agent_id, status, output, input_refs, cost_usd, tokens_in, tokens_out')
    .eq('run_id', run.id)
    .limit(500)

  const rows = agentRuns ?? []
  const byAgent: Record<string, { n: number; failed: number; cost: number }> = {}
  for (const r of rows) {
    const a = (byAgent[r.agent_id as string] ??= { n: 0, failed: 0, cost: 0 })
    a.n++
    if (r.status !== 'succeeded') a.failed++
    a.cost += Number(r.cost_usd ?? 0)
  }
  console.log('AGENT RUNS')
  for (const [id, v] of Object.entries(byAgent)) {
    console.log(`  ${id.padEnd(22)} ${String(v.n).padStart(3)} runs, ${v.failed} failed, $${v.cost.toFixed(2)}`)
  }

  // ─── Person research: is the public record the bottleneck? ─────────────────
  const people = rows.filter((r) => r.agent_id === 'person_research' && r.output)
  let thin = 0
  let noHook = 0
  const verdicts: Record<string, number> = {}
  let factCount = 0

  for (const r of people) {
    const o = r.output as Record<string, unknown>
    if (o.thin_public_record === true) thin++
    if (!o.specific_interest_hook) noHook++
    verdicts[String(o.verdict ?? '?')] = (verdicts[String(o.verdict ?? '?')] ?? 0) + 1
    const claims = Array.isArray(o.claims) ? o.claims : []
    factCount += claims.filter((c) => (c as { type?: string }).type === 'FACT').length
  }

  console.log(`\nPERSON RESEARCH (${people.length} dossiers)`)
  console.log(`  thin public record : ${thin} (${people.length ? Math.round((thin / people.length) * 100) : 0}%)`)
  console.log(`  NO specific hook   : ${noHook} (${people.length ? Math.round((noHook / people.length) * 100) : 0}%)`)
  console.log(`  FACTs per dossier  : ${people.length ? (factCount / people.length).toFixed(1) : 0}`)
  console.log(`  verdicts           : ${JSON.stringify(verdicts)}`)

  // ─── Company validation: how permissive is the gate? ───────────────────────
  const companies = rows.filter((r) => r.agent_id === 'company_validation' && r.output)
  const cVerdicts: Record<string, number> = {}
  const archetypes: Record<string, number> = {}
  let fallbackTitles = 0
  for (const r of companies) {
    const o = r.output as Record<string, unknown>
    cVerdicts[String(o.verdict ?? '?')] = (cVerdicts[String(o.verdict ?? '?')] ?? 0) + 1
    archetypes[String(o.archetype ?? '?')] = (archetypes[String(o.archetype ?? '?')] ?? 0) + 1
    if (o.target_titles_used_fallback === true) fallbackTitles++
  }
  console.log(`\nCOMPANY VALIDATION (${companies.length})`)
  console.log(`  verdicts        : ${JSON.stringify(cVerdicts)}`)
  console.log(`  archetypes      : ${JSON.stringify(archetypes)}`)
  console.log(`  fallback titles : ${fallbackTitles}`)

  // ─── Verdict split by job title ────────────────────────────────────────────
  // Tests whether weak prospects cluster on a FUNCTION rather than being spread
  // evenly — which is the difference between "find better people" and "look for
  // different roles".
  const { data: contacts } = await s
    .from('contacts')
    .select('name, role')
    .eq('discovery_source', 'apollo')
    .order('created_at', { ascending: false })
    .limit(400)

  const roleByName = new Map((contacts ?? []).map((c) => [String(c.name), String(c.role ?? '')]))
  const nameOf = (r: (typeof rows)[number]) =>
    String(((r as unknown as { input_refs?: { person?: string } }).input_refs?.person) ?? '')

  const buckets: Record<string, { KEEP: number; MAYBE: number; other: number }> = {}
  const classify = (title: string): string => {
    if (/\b(founder|co-?founder|ceo|president)\b/i.test(title)) return 'founder/CEO'
    if (/\b(cto|chief technology)\b/i.test(title)) return 'CTO'
    if (/\b(deployment|solutions|customer success|field|implementation|applied)\b/i.test(title)) return 'deployment/solutions'
    if (/\b(product)\b/i.test(title)) return 'product'
    if (/\b(engineering|engineer|software)\b/i.test(title)) return 'engineering'
    if (/\b(manufactur|process|plant|operations|quality|industrial)\b/i.test(title)) return 'industrial/ops'
    if (/\b(data|analytics|machine learning|ai|research|scien)\b/i.test(title)) return 'data/AI/research'
    return 'other'
  }

  for (const r of people) {
    const o = r.output as Record<string, unknown>
    const title = roleByName.get(nameOf(r)) ?? ''
    if (!title) continue
    const b = (buckets[classify(title)] ??= { KEEP: 0, MAYBE: 0, other: 0 })
    const v = String(o.verdict ?? '')
    if (v === 'KEEP') b.KEEP++
    else if (v === 'MAYBE') b.MAYBE++
    else b.other++
  }

  console.log('\nRESEARCHER VERDICT BY FUNCTION')
  const sorted = Object.entries(buckets).sort((a, b) => b[1].KEEP + b[1].MAYBE - (a[1].KEEP + a[1].MAYBE))
  for (const [fn, b] of sorted) {
    const total = b.KEEP + b.MAYBE + b.other
    const keepPct = total ? Math.round((b.KEEP / total) * 100) : 0
    console.log(`  ${fn.padEnd(22)} n=${String(total).padStart(2)}  KEEP ${b.KEEP} / MAYBE ${b.MAYBE} / other ${b.other}   keep-rate ${keepPct}%`)
  }

  // ─── A few dossiers, to read rather than count ─────────────────────────────
  console.log('\nSAMPLE DOSSIERS')
  for (const r of people.slice(0, 5)) {
    const o = r.output as Record<string, unknown>
    console.log(`  • verdict=${o.verdict} thin=${o.thin_public_record}`)
    console.log(`    owns : ${String(o.apparent_ownership ?? '').slice(0, 120)}`)
    console.log(`    hook : ${String(o.specific_interest_hook ?? 'NONE').slice(0, 140)}`)
  }
}

main().catch((e) => {
  console.error('failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
