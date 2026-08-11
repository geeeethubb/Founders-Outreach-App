// Conversation Agent eval.
//
//   npm run eval:conversation
//
// Fourteen fixture replies, one agent call each, no judge — the ground truth is
// written down, so an LLM judge would only add cost and a second opinion nobody
// asked for. Target: >= 90% sensible classification AND action.
//
// Cheap by construction: no web search, ~1k tokens in, cached on the reply text.

import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.join(process.cwd(), '.env.local') })

import { REPLY_FIXTURES, CRITICAL_IDS } from '../evals/conversation/fixtures'

const TARGET = 0.9

const MISSION = {
  goal:
    'Find people who could realistically lead to a strong winter 2026-27 internship or short-term ' +
    'project at the intersection of industrial AI, manufacturing, and chemical engineering.',
  timeframe: 'Winter 2026-27',
}

const ORIGINAL_SUBJECT = 'Floor-level agent adoption, not the demo'
const ORIGINAL_BODY = `At P&G's largest global manufacturing site, I built an agentic AI workflow that got floor-level
managers to act on AI-flagged use cases — a $3M+ savings case signed off by plant management, not a
demo. I built the same pattern again for validation-document approvals: 1,600+ hours returned,
$130K+ in annual savings.

I'm a chemical engineering student looking for a winter 2026-27 project. Worth a 15-minute call to
see if your group has something like this, or point me to who does?`

const FACTS = [
  'SENDER: Agentic AI workflow for floor-level managers — Procter & Gamble (2025): $3M+ projected annual site-wide savings, in partnership with Plant Management.',
  'SENDER: AI agent for site validation document approvals — Procter & Gamble (2025): 30% targeted reduction in manual review, 1,600+ productivity hours returned, $130K+ projected annual savings.',
  'RECIPIENT: Director, Smart Manufacturing at a large food manufacturer.',
]

async function main() {
  const { runConversation } = await import('../lib/agents/conversation')
  const { anthropicUsage, resetAnthropicUsage, setAnthropicBudget } = await import(
    '../lib/providers/anthropic/client'
  )
  const { stateForClassification } = await import('../lib/outreach/states')
  const { checkGrounding } = await import('../lib/outreach/grounding')
  const { evidenceForReply } = await import('../lib/outreach/evidence')

  // Call budget, not dollars. Each fixture is one agent call plus retries.
  setAnthropicBudget(60)
  resetAnthropicUsage()

  const ctx = {
    user_id: 'eval',
    run_id: null,
    budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 4 },
  }

  console.log(`\nCONVERSATION AGENT — ${REPLY_FIXTURES.length} fixtures\n`)

  let classificationHits = 0
  let actionHits = 0
  let bothHits = 0
  let criticalMisses = 0
  let ungroundedDrafts = 0
  const rows: Record<string, unknown>[] = []

  for (const f of REPLY_FIXTURES) {
    const res = await runConversation(
      {
        mission: MISSION,
        sender: { name: 'Zuyu Liu' },
        person: { name: 'Jonathan Huggins', firstName: 'Jonathan', title: 'Director, Smart Manufacturing', company: 'Dow' },
        originalSubject: ORIGINAL_SUBJECT,
        originalBody: ORIGINAL_BODY,
        thread: [{ direction: 'outbound', body: ORIGINAL_BODY }],
        reply: f.reply,
        groundedFacts: FACTS,
      },
      ctx
    )

    if (!res.output) {
      console.log(`  FAIL   ${f.id.padEnd(22)} agent error: ${res.error}`)
      rows.push({ id: f.id, error: res.error })
      continue
    }

    const v = res.output
    const classOk =
      v.classification === f.expected || (f.alsoAcceptable ?? []).includes(v.classification)
    const actionOk = f.acceptable.includes(v.action)
    if (classOk) classificationHits++
    if (actionOk) actionHits++
    if (classOk && actionOk) bothHits++
    if (!(classOk && actionOk) && CRITICAL_IDS.includes(f.id)) criticalMisses++

    // The suggested reply is held to the same grounding bar as the cold email.
    let groundingNote = ''
    if (v.suggested_body) {
      const g = checkGrounding({
        subject: v.suggested_subject ?? '',
        body: v.suggested_body,
        evidence: evidenceForReply(FACTS, f.reply),
        safeNames: ['Jonathan Huggins', 'Dow', 'Zuyu Liu'],
      })
      if (!g.ok) {
        ungroundedDrafts++
        groundingNote = ` · UNGROUNDED: ${g.blocking.map((b) => b.claim).join(', ')}`
      }
    }

    const mark = classOk && actionOk ? 'ok  ' : classOk || actionOk ? 'part' : 'MISS'
    console.log(
      `  ${mark}   ${f.id.padEnd(22)} ${v.classification.padEnd(16)} ${v.action.padEnd(16)} ` +
        `conf ${v.confidence.toFixed(2)}${classOk ? '' : ` (want ${f.expected})`}${groundingNote}`
    )

    rows.push({
      id: f.id,
      expected: f.expected,
      got: v.classification,
      action: v.action,
      acceptable: f.acceptable,
      confidence: v.confidence,
      summary: v.summary,
      state: stateForClassification(v.classification, 'sent'),
      suggested: v.suggested_body,
    })
  }

  const n = REPLY_FIXTURES.length
  const u = anthropicUsage()

  console.log('\nRESULTS')
  console.log(`  Classification   ${classificationHits}/${n}  ${((classificationHits / n) * 100).toFixed(0)}%`)
  console.log(`  Action           ${actionHits}/${n}  ${((actionHits / n) * 100).toFixed(0)}%`)
  console.log(
    `  Both             ${bothHits}/${n}  ${((bothHits / n) * 100).toFixed(0)}%   ` +
      `(target >= ${TARGET * 100}%)  ${bothHits / n >= TARGET ? 'PASS' : 'FAIL'}`
  )
  console.log(`  Critical misses  ${criticalMisses}   (must be 0)`)
  console.log(`  Ungrounded suggested replies  ${ungroundedDrafts}   (must be 0)`)
  console.log(`\nCOST  $${u.costUsd.toFixed(4)} across ${u.calls} calls  ($${(u.costUsd / n).toFixed(4)}/reply)`)

  fs.mkdirSync(path.join(process.cwd(), '.eval-runs'), { recursive: true })
  fs.writeFileSync(
    path.join(process.cwd(), '.eval-runs', 'conversation-eval.json'),
    JSON.stringify({ rows, classificationHits, actionHits, bothHits, costUsd: u.costUsd }, null, 2)
  )
}

main().catch((e) => {
  console.error('eval failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
