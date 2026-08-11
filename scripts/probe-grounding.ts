// Fast feedback loop for the claim-safety gate.
//
//   npx tsx scripts/probe-grounding.ts
//
// Runs the gate over the real drafts the last positioning eval produced, plus a
// set of deliberately fabricated variants. A gate is only useful if it clears
// genuine drafts AND stops invented ones; this shows both numbers at once.
//
// A blocked real draft is not automatically a false positive — the first run of
// this probe blocked 9 of 10, and the cause was a genuinely impoverished
// evidence pool, not an over-eager gate. See lib/outreach/evidence.ts.

import path from 'path'
import fs from 'fs'
import { checkGrounding, summarizeGrounding } from '../lib/outreach/grounding'
import { buildEvidence, buildVerificationPool, safeNamesFor } from '../lib/outreach/evidence'
import { RESUME_ITEMS } from '../evals/phase3/user-profile'

const EVAL_FILE = path.join(process.cwd(), '.eval-runs', 'positioning-eval.json')

interface Positioned {
  p: { candidate_key: string; why_they_fit: string; researchSummary: string; person: { name: string; title: string | null }; company: string }
  pos: { top_proof_points: { background_id: string }[] }
}
interface Drafted {
  p: { candidate_key: string; person: { name: string; title: string | null }; company: string; why_they_fit: string; researchSummary: string }
  subject: string
  body: string
}

const byId = new Map(RESUME_ITEMS.map((i) => [i.id, i]))

function show(label: string, r: ReturnType<typeof checkGrounding>) {
  console.log(`  [${r.ok ? 'PASS ' : 'BLOCK'}] ${label} — ${summarizeGrounding(r)}`)
  for (const f of r.findings) {
    console.log(`           ${f.severity === 'blocking' ? '✗' : '!'} ${f.kind}: "${f.claim}"`)
    if (f.severity === 'blocking') console.log(`             → ${f.revision.slice(0, 130)}`)
  }
}

function main() {
  if (!fs.existsSync(EVAL_FILE)) {
    console.error(`No ${EVAL_FILE}. Run: npm run eval:positioning -- --emails`)
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(EVAL_FILE, 'utf8')) as {
    positioned: Positioned[]
    drafted: Drafted[]
  }
  const posByKey = new Map(data.positioned.map((x) => [x.p.candidate_key, x.pos]))

  console.log(`\nREAL DRAFTS (${data.drafted.length}) — measuring the false-positive rate\n`)
  let cleared = 0
  for (const d of data.drafted) {
    const pos = posByKey.get(d.p.candidate_key)
    const chosen = (pos?.top_proof_points ?? [])
      .map((pp) => byId.get(pp.background_id))
      .filter(Boolean)
      .map((b) => ({ id: b!.id, title: b!.title, org: b!.org, period: b!.period, summary: b!.summary }))

    const evidence = buildEvidence({
      companyContext: d.p.why_they_fit,
      personContext: d.p.researchSummary,
      recipientTitle: d.p.person.title,
      recipientCompany: d.p.company,
      chosenBackground: chosen,
    })

    const r = checkGrounding({
      subject: d.subject,
      body: d.body,
      evidence: buildVerificationPool(
        evidence,
        RESUME_ITEMS.map((i) => ({ id: i.id, title: i.title, org: i.org, period: i.period, summary: i.summary })),
        chosen.map((c) => c.id)
      ),
      safeNames: safeNamesFor({
        recipientName: d.p.person.name,
        recipientCompany: d.p.company,
        senderName: 'Zuyu Liu',
        timeframe: 'Winter 2026-27',
      }),
    })
    if (r.ok) cleared++
    show(`${d.p.person.name}, ${d.p.company}`, r)
  }
  console.log(`\n  ${cleared}/${data.drafted.length} real drafts cleared\n`)

  // ─── Fabrications the gate must stop ───
  const evidence = [
    'SENDER: HPC catalysis screening — UIUC (2025): Ran 73,000 CPU-hours of VASP/ASE screening on aMOC surfaces for hydrogen fuel cells.',
    'SENDER: Agentic AI adoption — Procter & Gamble (2025): Built an agentic AI workflow at P&G, projected at $3M+ in annual savings.',
    'RECIPIENT: Director of the Manufacturing Science and Engineering programme.',
    'THEIR COMPANY: Argonne National Laboratory operates the Advanced Photon Source.',
  ]
  const safeNames = ['Sibendu Som', 'Argonne National Laboratory', 'Zuyu Liu']

  const fabrications: Array<[string, string, boolean]> = [
    ['invented dollar figure', 'I delivered $12M in annual savings at P&G last year.', true],
    ['invented percentage', 'My screening pipeline cut simulation time by 40%.', true],
    ['invented programme name', 'Your work on Project Helios is exactly the overlap I want.', true],
    ['invented acronym', 'I noticed the ACME initiative there is scaling this quarter.', true],
    ['invented superlative', 'Argonne runs the largest catalysis group in the country.', true],
    ['invented responsibility', 'You lead the quantum photonics roadmap there.', true],
    ['inflated real number', 'I ran 730,000 CPU-hours of VASP screening.', true],
    [
      'grounded control',
      'I ran 73,000 CPU-hours of VASP/ASE screening, and the P&G workflow is projected at $3M+ in annual savings. Worth a 15-minute call in winter 2026-27?',
      false,
    ],
  ]

  console.log('FABRICATIONS — every one but the control must block\n')
  let correct = 0
  for (const [label, body, shouldBlock] of fabrications) {
    const r = checkGrounding({ subject: 'A note', body, evidence, safeNames })
    if (!r.ok === shouldBlock) correct++
    show(label, r)
  }
  console.log(`\n  ${correct}/${fabrications.length} fabrication cases judged correctly\n`)
}

main()
