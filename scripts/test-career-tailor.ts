// Offline tests for résumé tailoring and the fact guarantee: the pre-check,
// the tailor's and verifier's validate(), the pipeline with stubbed agents,
// edit distance, and the cover-letter grounding gate.
//
// No network, no keys. The bank is built in memory from the eval fixture
// (evals/phase3/user-profile.ts), which is a hand-written summary of the
// résumé and carries no data beyond what is already committed.
//
//   npx tsx scripts/test-career-tailor.ts

import { RESUME_ITEMS } from '../evals/phase3/user-profile'
import { extractQuantities } from '../lib/outreach/grounding'
import { buildBankPool, buildExperiencePool } from '../lib/career/evidence/render'
import { precheckChange } from '../lib/career/tailor/precheck'
import { editLevelFor, validateChangeShape, MAX_NON_REORDER_CHANGES } from '../lib/career/tailor/rules'
import { bulletDistance, patchDistance, wordsChanged } from '../lib/career/tailor/distance'
import { buildTailorInput, jobTermsFor } from '../lib/career/tailor/render'
import { runTailoringPipeline, applyReviewDecisions, finalBulletsFor, verifyEditedText, verifyChange } from '../lib/career/tailor/pipeline'
import { validateTailorOutput, shapeContextFrom, prose } from '../lib/agents/resume-tailor'
import { validateVerifierOutput, overallFromClauses, type ResumeFactVerifierOutput } from '../lib/agents/resume-fact-verifier'
import { validateCoverLetterOutput, type CoverLetterInput } from '../lib/agents/cover-letter-writer'
import { gateCoverLetter } from '../lib/career/letter/grounding'
import { runCoverLetterPipeline } from '../lib/career/letter/pipeline'
import type { AgentResult, ToolContext } from '../lib/agents/runtime/types'
import type { EvidenceBank, EvidenceFact, EvidenceMetric, ProposedChange, ResumeBullet } from '../lib/career/types'

// ─── Fixture bank ────────────────────────────────────────────────────────────

const NOW = '2026-08-01T00:00:00Z'
const USER = 'user-fixture'

/** Atomic-ish sentences from a summary: split on ';', ' — ' and sentence ends. */
function atomicStatements(summary: string): string[] {
  return summary
    .split(/;\s+|\s+—\s+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length > 12)
}

export function buildFixtureBank(): EvidenceBank {
  const bank: EvidenceBank = {
    experiences: [], facts: [], metrics: [], deliverables: [], skills: [], stories: [], preferences: [], bullets: [],
    organizations: [],
    sources: [],
    factSources: [],
    projects: [],
    masterDocument: null,
  }
  RESUME_ITEMS.forEach((item, order) => {
    const [start, end] = item.period.split(/\s*[–-]\s*/)
    bank.experiences.push({
      id: item.id, user_id: USER, kind: item.kind, organization: item.org, title: item.title,
      start_date: start ?? null, end_date: end ?? null, location: null, description: null,
      display_order: order, source: 'master_resume', approved: true, created_at: NOW, updated_at: NOW,
    })
    const factIds: string[] = []
    atomicStatements(item.summary).forEach((statement, i) => {
      const f: EvidenceFact = {
        id: `${item.id}_f${i}`, user_id: USER, experience_id: item.id, statement,
        category: /\d/.test(statement) ? 'metric' : 'achievement', source: 'master_resume',
        source_location: `bullet ${order + 1}`, confidence: 1, approved: true, created_at: NOW, updated_at: NOW,
      }
      bank.facts.push(f)
      factIds.push(f.id)
    })
    extractQuantities(item.summary).forEach((q, i) => {
      const m: EvidenceMetric = {
        id: `${item.id}_m${i}`, user_id: USER, experience_id: item.id, value: q.raw, unit: null,
        context: item.summary.slice(Math.max(0, q.index - 40), q.index + q.raw.length + 40).trim(),
        fact_ids: factIds, source: 'master_resume', approved: true, created_at: NOW,
      }
      bank.metrics.push(m)
    })
    const b: ResumeBullet = {
      id: `${item.id}_b0`, user_id: USER, resume_document_id: null, experience_id: item.id, paragraph_index: order,
      display_order: 0, text: item.summary, evidence_fact_ids: factIds, source_resume: 'master',
      is_on_master: true, approved: true, created_at: NOW, updated_at: NOW,
    }
    bank.bullets.push(b)
  })
  // One approved alternate, so swap has a legal source.
  bank.bullets.push({
    id: 'png_controlled_state_alt', user_id: USER, resume_document_id: null, experience_id: 'png_controlled_state',
    paragraph_index: null, display_order: 1,
    text: "Piloted a Controlled State system on the Beauty Packing line, defining the error-reduction and process-automation roadmap ($4M+ projected savings).",
    evidence_fact_ids: ['png_controlled_state_f0'], source_resume: 'alternate', is_on_master: false, approved: true,
    created_at: NOW, updated_at: NOW,
  })
  for (const [i, name] of ['n8n', 'ASE', 'VASP', 'Python', 'Sankey diagrams'].entries()) {
    bank.skills.push({ id: `skill_${i}`, user_id: USER, name, category: 'tool', evidence_fact_ids: [], approved: true, created_at: NOW })
  }
  return bank
}

export const CTX: ToolContext = {
  user_id: USER,
  run_id: null,
  budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 3 },
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function stubResult<T>(output: T | null, agent: string, error: string | null = null): AgentResult<T> {
  return {
    output, status: output ? 'succeeded' : 'failed', error, evidence: [],
    trace: {
      agent_id: agent, prompt_version: 'stub', model: 'stub', model_role: 'reasoning', provider_id: 'anthropic',
      tools_called: [], web_searches: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0, steps: 1,
    },
  }
}

const CS = 'png_controlled_state'
const CS_ORIGINAL = RESUME_ITEMS.find((i) => i.id === CS)!.summary

function reword(text: string, over: Partial<ProposedChange> = {}): ProposedChange {
  return {
    bullet_id: `${CS}_b0`, experience_id: CS, change_type: 'reword', edit_level: 2, original_text: CS_ORIGINAL,
    proposed_text: text, source_bullet_id: null, position: 0, reason: 'test', job_requirement: 'test',
    evidence_fact_ids: [`${CS}_f0`], confidence: 0.8, ...over,
  }
}

async function main() {
  const bank = buildFixtureBank()
  const pool = buildExperiencePool(bank, CS)

  // ─── precheck ───
  {
    const r = precheckChange(reword(CS_ORIGINAL.replace('$4M+', '$9M')), pool, CS_ORIGINAL)
    check('precheck blocks invented $9M', !r.ok && r.blocking.some((f) => f.kind === 'quantity' && /9M/.test(f.span)), JSON.stringify(r.blocking))
  }
  {
    const r = precheckChange(reword(CS_ORIGINAL.replace('Controlled State system', 'Controlled State system in Palantir Foundry')), pool, CS_ORIGINAL)
    check('precheck blocks invented tool Palantir Foundry', !r.ok && r.blocking.some((f) => /palantir/i.test(f.span)), JSON.stringify(r.blocking))
  }
  {
    const r = precheckChange(reword(CS_ORIGINAL.replace('a Controlled State system', 'the flagship Controlled State system')), pool, CS_ORIGINAL)
    check('precheck blocks superlative not in pool', !r.ok && r.blocking.some((f) => f.kind === 'superlative'), JSON.stringify(r.blocking))
  }
  {
    const jd = ['Kubernetes', 'cost-out', 'Process automation', 'Six Sigma Black Belt']
    const r = precheckChange(reword(CS_ORIGINAL.replace('process automation', 'process automation and cost-out on Kubernetes')), pool, CS_ORIGINAL, jd)
    check('precheck blocks keyword-stuffed Kubernetes', r.blocking.some((f) => f.kind === 'keyword_stuffing' && /kubernetes/i.test(f.span)), JSON.stringify(r.blocking))
    check('precheck blocks keyword-stuffed cost-out', r.blocking.some((f) => f.kind === 'keyword_stuffing' && /cost-out/i.test(f.span)), JSON.stringify(r.blocking))
    check('precheck does not flag a JD term the evidence contains', !r.blocking.some((f) => /process automation/i.test(f.span)))
  }
  {
    const faithful = CS_ORIGINAL.replace(', defining the roadmap', '; defined the roadmap').replace('$4M+', '**$4M+**')
    const r = precheckChange(reword(faithful), pool, CS_ORIGINAL)
    check('precheck allows a faithful reword', r.ok, JSON.stringify(r.blocking))
  }
  {
    // A decimal in the evidence is not a small count. The factuality eval
    // blocked an emphasis-only change for the "5" in "$1.5 million".
    const decimal = `${CS_ORIGINAL} Sourced leads for a $1.5 million round.`
    const decimalPool = { ...pool, lines: [...pool.lines, 'Sourced investment leads for $1.5 million round.'] }
    const r = precheckChange(reword(decimal.replace('$4M+', '**$4M+**')), decimalPool, decimal)
    check('precheck does not read the 5 in $1.5 million as an unsupported count', !r.blocking.some((f) => f.kind === 'quantity' && f.span === '5'), JSON.stringify(r.blocking))
  }
  {
    const r = precheckChange(reword(CS_ORIGINAL.replace('Built and piloted', 'Architected and piloted')), pool, CS_ORIGINAL)
    check('precheck warns on built→architected', r.warnings.some((f) => f.kind === 'ownership' && f.span === 'architected'), JSON.stringify(r.warnings))
    check('ownership escalation is a warning, not a block', r.ok)
  }
  {
    const r = precheckChange(reword(CS_ORIGINAL.replace('Beauty Packing line', 'Beauty Packing line across 7 sub-lines')), pool, CS_ORIGINAL)
    check('precheck blocks an invented small count', r.blocking.some((f) => f.kind === 'quantity' && f.span === '7'), JSON.stringify(r.blocking))
  }
  {
    const cat = RESUME_ITEMS.find((i) => i.id === 'uiuc_catalysis')!.summary
    const r = precheckChange(
      reword(cat.replace('screening', 'screening (n8n-orchestrated)'), { bullet_id: 'uiuc_catalysis_b0', experience_id: 'uiuc_catalysis', evidence_fact_ids: ['uiuc_catalysis_f0'] }),
      buildExperiencePool(bank, 'uiuc_catalysis'),
      cat
    )
    check('precheck: a tool on the global skills list is grounded', r.ok, JSON.stringify(r.blocking))
  }

  {
    const r = precheckChange(reword(CS_ORIGINAL.replace('Built and piloted', '**Built and piloted**')), pool, CS_ORIGINAL)
    check('precheck blocks bold on a non-metric span', r.blocking.some((f) => f.kind === 'emphasis'), JSON.stringify(r.blocking))
    const ok = precheckChange(reword(CS_ORIGINAL.replace('$4M+', '**$4M+**')), pool, CS_ORIGINAL)
    check('precheck allows bold on a metric', ok.ok, JSON.stringify(ok.blocking))
  }

  check(
    'prose strips leaked tool markup',
    prose('Fine as is.</no_change_reason>\n<parameter name="summary">x') === 'Fine as is.' &&
      prose('Done."') === 'Done.' &&
      prose('Plain — text') === 'Plain — text'
  )

  // ─── rules ───
  check('editLevelFor maps types', editLevelFor('reorder') === 1 && editLevelFor('reword') === 2 && editLevelFor('swap') === 3 && editLevelFor('new') === 4 && editLevelFor('remove') === 1 && editLevelFor('keep') === 0)

  // ─── tailor validate ───
  const job = { title: 'Manufacturing Engineering Intern', company: 'Acme', key_requirements: ['Process improvement'], responsibilities: [], description_excerpt: '' }
  const tailorInput = buildTailorInput(bank, job, { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [CS] })
  check('tailor input leads with top experiences', tailorInput.experiences[0].id === CS)
  check('tailor input renders every experience', tailorInput.experiences.length === RESUME_ITEMS.length)
  {
    const raw = {
      changes: [
        { ...reword(CS_ORIGINAL), evidence_fact_ids: ['uiuc_catalysis_f0'] },                       // fact from another experience
        { ...reword(CS_ORIGINAL), change_type: 'swap', edit_level: 3, source_bullet_id: `${CS}_b0` }, // swap source on master
        { ...reword(CS_ORIGINAL), change_type: 'swap', edit_level: 3, source_bullet_id: `${CS}_alt` }, // legal swap
        { ...reword(CS_ORIGINAL), edit_level: 3 },                                                     // wrong level
        { ...reword(CS_ORIGINAL), bullet_id: 'nope' },                                                 // unknown bullet
        { ...reword(CS_ORIGINAL), proposed_text: 'Built **a system' },                                 // unbalanced **
        { ...reword(CS_ORIGINAL, { confidence: 0.9 }) },                                               // fine, but second change on the same bullet
      ],
      no_change_reason: null,
      summary: 'test',
    }
    const out = validateTailorOutput(raw, tailorInput)
    check('tailor validate returns an envelope', out !== null)
    if (out) {
      check('tailor validate keeps only the legal changes', out.changes.length === 1, `${out.changes.length}: ${out.changes.map((c) => c.change_type).join(',')}`)
      check('tailor validate refuses a second change on a bullet', out.rejected.some((r) => /one change per bullet/.test(r.reason)))
      check('tailor validate drops a change citing another experience', out.rejected.some((r) => /different experience/.test(r.reason)))
      check('tailor validate drops a swap whose source is on master', out.rejected.some((r) => /not an approved alternate/.test(r.reason)))
      check('tailor validate drops a mismatched edit_level', out.rejected.some((r) => /edit_level/.test(r.reason)))
      check('tailor validate drops unbalanced **', out.rejected.some((r) => /unbalanced/.test(r.reason)))
      check('tailor validate counts unknown ids', out.dropped_unknown_ids >= 3, String(out.dropped_unknown_ids))
      const swap = out.changes.find((c) => c.change_type === 'swap')
      check('swap carries the alternate text verbatim', swap?.proposed_text === bank.bullets.find((b) => b.id === `${CS}_alt`)?.text)
      check('accepted changes carry original_text', out.changes.every((c) => c.original_text === CS_ORIGINAL))
    }
    const shape = validateChangeShape({ ...reword('x'), change_type: 'new', edit_level: 4, bullet_id: null, evidence_fact_ids: [`${CS}_f0`] }, shapeContextFrom(tailorInput))
    check('new requires two facts', !shape.ok && /at least 2/.test(shape.reason))
    // Nine rewords across nine experiences: the cap is per patch, one change per bullet.
    const nine = RESUME_ITEMS.slice(0, 9).map((item, i) =>
      reword(item.summary, { bullet_id: `${item.id}_b0`, experience_id: item.id, original_text: item.summary, evidence_fact_ids: [`${item.id}_f0`], confidence: i / 10 })
    )
    const capped = validateTailorOutput({ changes: nine, no_change_reason: null, summary: '' }, tailorInput)
    check('tailor validate truncates to the cap by confidence', capped?.changes.length === MAX_NON_REORDER_CHANGES && capped.truncated === 3 && capped.changes.every((c) => c.confidence >= 0.3), `${capped?.changes.length} kept, ${capped?.truncated} truncated, ${capped?.rejected.map((r) => r.reason).join(' | ')}`)
    const twice = validateTailorOutput({ changes: [reword(CS_ORIGINAL), { ...reword(CS_ORIGINAL), change_type: 'reorder', edit_level: 1, proposed_text: null, evidence_fact_ids: [] }], no_change_reason: null, summary: '' }, tailorInput)
    check('tailor validate keeps one change per bullet', twice?.changes.length === 1 && twice.rejected.some((r) => /one change per bullet/.test(r.reason)), `${twice?.changes.length}`)
    const none = validateTailorOutput({ changes: [], no_change_reason: 'The master already fits this role', summary: 's' }, tailorInput)
    check('empty change list is a valid answer', none?.changes.length === 0 && none.no_change_reason === 'The master already fits this role')
  }

  // ─── verifier validate ───
  const vInput = {
    experience_label: 'x', original_text: CS_ORIGINAL, proposed_text: 'y', edit_level: 2 as const,
    facts: [{ id: 'f1', statement: 's' }], metrics: [], other_bullets: [], skills: [],
  }
  {
    const bad = { clauses: [{ clause: 'a', verdict: 'UNSUPPORTED', fact_ids: [], note: '' }], overall: 'SUPPORTED', notes: '' }
    check('verifier validate rejects an overall that disagrees with its clauses', validateVerifierOutput(bad, vInput) === null)
    const good = { clauses: [{ clause: 'a', verdict: 'SUPPORTED', fact_ids: ['f1', 'ghost'], note: '' }, { clause: 'b', verdict: 'UNCERTAIN', fact_ids: [], note: '' }], overall: 'UNCERTAIN', notes: 'n' }
    const out = validateVerifierOutput(good, vInput)
    check('verifier validate accepts a consistent overall', out?.overall === 'UNCERTAIN')
    check('verifier validate strips invented fact ids and counts them', out?.clauses[0].fact_ids.join() === 'f1' && out.dropped_fact_ids === 1)
    check('verifier validate rejects zero clauses', validateVerifierOutput({ clauses: [], overall: 'SUPPORTED', notes: '' }, vInput) === null)
    check('overallFromClauses: UNSUPPORTED wins', overallFromClauses([{ verdict: 'UNCERTAIN' }, { verdict: 'UNSUPPORTED' }]) === 'UNSUPPORTED')
  }

  // ─── pipeline with stubs ───
  {
    const proposed = CS_ORIGINAL.replace('Built and piloted', 'Led the build and pilot of')
    const tailorStub = async () =>
      stubResult(
        {
          changes: [
            reword(proposed, { confidence: 0.7 }),
            reword(CS_ORIGINAL.replace('$4M+', '$9M'), { bullet_id: `${CS}_b0`, confidence: 0.6 }),
            { ...reword(null as unknown as string), bullet_id: 'uiuc_catalysis_b0', experience_id: 'uiuc_catalysis', change_type: 'reorder' as const, edit_level: 1 as const, proposed_text: null, position: 0, original_text: null },
          ],
          rejected: [], no_change_reason: null, summary: 'stub', dropped_unknown_ids: 0, truncated: 0,
        },
        'resume_tailor'
      )
    let verifierCalls = 0
    const verifierStub = async (): Promise<AgentResult<ResumeFactVerifierOutput>> => {
      verifierCalls++
      return stubResult<ResumeFactVerifierOutput>(
        {
          clauses: [
            { clause: 'Led the build', verdict: 'UNCERTAIN', fact_ids: [], note: 'evidence says built' },
            { clause: '$4M+ projected savings', verdict: 'SUPPORTED', fact_ids: [`${CS}_f0`], note: '' },
          ],
          overall: 'UNCERTAIN', notes: 'ownership unclear', dropped_fact_ids: 0,
        },
        'resume_fact_verifier'
      )
    }
    const r = await runTailoringPipeline({ bank, job, evidenceMap: { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [CS] }, ctx: CTX, deps: { tailor: tailorStub, verifier: verifierStub } })
    check('pipeline returns every change', r.changes.length === 3, String(r.changes.length))
    const uncertain = r.changes.find((c) => c.proposed_text === proposed)
    check('pipeline auto-rejects UNCERTAIN and keeps the original', uncertain?.review_status === 'auto_rejected' && uncertain.verification_result === 'UNCERTAIN' && uncertain.final_text === CS_ORIGINAL)
    check('pipeline notes carry the failing clause', /Led the build/.test(uncertain?.verification_notes ?? ''))
    const blocked = r.changes.find((c) => /\$9M/.test(c.proposed_text ?? ''))
    check('pipeline: precheck block skips the verifier and rejects', blocked?.review_status === 'auto_rejected' && blocked.verification_result === 'UNSUPPORTED' && /Verifier skipped/.test(blocked.verification_notes ?? ''))
    check('verifier was called exactly once (blocked change never reached it)', verifierCalls === 1, String(verifierCalls))
    const emphasis = await verifyChange(bank, reword(CS_ORIGINAL.replace('$4M+', '**$4M+**')), CTX, { deps: { verifier: verifierStub } })
    check('emphasis-only change is SUPPORTED without the verifier', emphasis.verification_result === 'SUPPORTED' && verifierCalls === 1 && emphasis.final_text?.includes('**$4M+**') === true)
    // The factuality eval caught the tailor proposing a "reword" that was the
    // master bullet verbatim, and a verifier call confirming it equalled itself.
    const verbatim = await verifyChange(bank, reword(CS_ORIGINAL), CTX, { deps: { verifier: verifierStub } })
    check('verbatim-identical reword is SUPPORTED without the verifier', verbatim.verification_result === 'SUPPORTED' && verifierCalls === 1 && /Wording unchanged/.test(verbatim.verification_notes ?? ''), `${verbatim.verification_notes} calls=${verifierCalls}`)
    const reorder = r.changes.find((c) => c.change_type === 'reorder')
    check('reorder is SUPPORTED without a verifier', reorder?.verification_result === 'SUPPORTED' && reorder.review_status === 'pending')
    check('pipeline distance is 0 when nothing survived', r.distance.distance === 0, JSON.stringify(r.distance))
    check('pipeline cost sums to 0 for stubs', r.costUsd === 0)

    // Review: approve refused for UNSUPPORTED; edit goes back through the gate.
    const supportedStub = async (): Promise<AgentResult<ResumeFactVerifierOutput>> =>
      stubResult<ResumeFactVerifierOutput>({ clauses: [{ clause: 'all', verdict: 'SUPPORTED', fact_ids: [`${CS}_f0`], note: '' }], overall: 'SUPPORTED', notes: '', dropped_fact_ids: 0 }, 'resume_fact_verifier')
    const review = await applyReviewDecisions(r.changes, [
      { index: 1, action: 'approve' },
      { index: 0, action: 'edit', text: CS_ORIGINAL.replace('$4M+', '$5M') },
      { index: 0, action: 'edit', text: CS_ORIGINAL.replace(', defining', '; defined') },
    ], { verifyEdit: (c, text) => verifyEditedText(bank, c, text, CTX, { deps: { verifier: supportedStub } }) })
    check('review refuses to approve an UNSUPPORTED change', review.refused.some((x) => x.decision.index === 1))
    check('an edit with an invented number is auto-rejected', review.changes[0].review_status === 'auto_rejected' || review.changes[0].review_status === 'edited')
    check('a faithful edit becomes edited with the new text', review.changes[0].review_status === 'edited' && /; defined/.test(review.changes[0].final_text ?? ''), review.changes[0].verification_notes ?? '')
    const finals = finalBulletsFor(bank, review.changes, { onlyApproved: true })
    check('finalBulletsFor applies the edited text', finals.find((f) => f.experience_id === CS)?.bullets[0].includes('; defined') === true)
    check('finalBulletsFor leaves untouched experiences alone', finals.find((f) => f.experience_id === 'argonne_tea')?.bullets[0] === RESUME_ITEMS.find((i) => i.id === 'argonne_tea')!.summary)
  }

  // ─── distance ───
  check('bulletDistance identical = 0', bulletDistance(CS_ORIGINAL, CS_ORIGINAL) === 0)
  check('bulletDistance small edit is small', bulletDistance(CS_ORIGINAL, CS_ORIGINAL.replace('Built', 'Designed')) < 0.1)
  check('wordsChanged counts one edit', wordsChanged(CS_ORIGINAL, CS_ORIGINAL.replace('Built', 'Designed')).edits === 1)
  {
    const master = ['alpha beta gamma delta', 'one two three four', 'red green blue']
    check('patchDistance identical = 0', patchDistance(master, master).distance === 0 && !patchDistance(master, master).reordered)
    const swapped = [master[1], master[0], master[2]]
    const d = patchDistance(master, swapped)
    check('patchDistance detects reorder with 0 text distance', d.reordered && d.distance === 0 && d.changedFraction === 0, JSON.stringify(d))
    const removed = patchDistance(master, [master[0], master[2]])
    check('patchDistance counts a removal', removed.changedFraction > 0.3 && removed.distance > 0)
  }

  // ─── cover letter validate ───
  const letterInput: CoverLetterInput = {
    job: { title: 'Intern', company: 'Acme', location: null, summary: 's' },
    companyResearch: { points: [{ id: 'rf1', text: 'Acme opened a new plant' }], summary: 'Acme' },
    evidence: { why_i_fit: null, facts: [{ id: 'ef1', text: '$4M+ projected savings' }], stories: [] },
    user: { name: 'Zuyu Liu' }, narrative: 'n', length: { min: 220, max: 340 },
  }
  {
    const para = Array.from({ length: 4 }, () => Array.from({ length: 65 }, (_, i) => `word${i}`).join(' '))
    const ok = validateCoverLetterOutput({ greeting: 'Dear Acme Hiring Team,', paragraphs: para, closing: 'Sincerely,', claims: [{ claim_text: 'new plant', kind: 'company', research_fact_id: 'rf1', evidence_fact_id: null }, { claim_text: 'x', kind: 'personal', research_fact_id: null, evidence_fact_id: 'ghost' }] }, letterInput)
    check('letter validate accepts a well-formed letter', ok !== null && ok.wordCount === 260)
    check('letter validate strips a claim with an unknown id', ok?.claims.length === 1 && ok.dropped_claims === 1)
    const short = validateCoverLetterOutput({ greeting: '', paragraphs: para.slice(0, 2), closing: '', claims: [] }, letterInput)
    check('letter validate rejects too short', short === null)
    const noCompany = validateCoverLetterOutput({ greeting: '', paragraphs: para, closing: '', claims: [] }, letterInput)
    check('letter validate rejects a letter with no company claim', noCompany === null)
    const banned = validateCoverLetterOutput({ greeting: '', paragraphs: [para[0] + ' I am passionate about this.', ...para.slice(1)], closing: '', claims: [{ claim_text: 'x', kind: 'company', research_fact_id: 'rf1', evidence_fact_id: null }] }, letterInput)
    check('letter validate rejects a banned phrase', banned === null)
  }

  // ─── grounding gate ───
  {
    const pools = { companyPool: ['Acme Industrial', 'Acme opened a new plant in Ohio in 2025'], personalPool: buildBankPool(bank), safeNames: ['Zuyu Liu', 'Acme Industrial'] }
    const bad = 'Your Project Helios rollout is what drew me to Acme Industrial. At [Company] I would bring what I learned at P&G. I am passionate about manufacturing.'
    const g = gateCoverLetter(bad, pools)
    check('gate blocks an ungrounded company product name', g.blocking.some((f) => f.kind === 'entity' && /Helios/.test(f.span)), JSON.stringify(g.blocking))
    check('gate blocks a placeholder', g.blocking.some((f) => f.kind === 'placeholder'), JSON.stringify(g.blocking))
    check('gate warns on a banned phrase', g.warnings.some((f) => f.kind === 'banned_phrase'))
    const good = 'Acme Industrial opened a new plant in Ohio in 2025, and that is the kind of environment I want to learn in. At P&G I built and piloted a Controlled State system with $4M+ projected savings.'
    const g2 = gateCoverLetter(good, pools)
    check('gate passes a grounded letter', g2.ok, JSON.stringify(g2.blocking))
    const narrated = gateCoverLetter(`At P&G I ${CS_ORIGINAL.charAt(0).toLowerCase()}${CS_ORIGINAL.slice(1)}`, pools)
    check('gate warns on résumé repetition', narrated.warnings.some((f) => f.kind === 'repetition'), JSON.stringify(narrated.warnings))
    const num = gateCoverLetter('At P&G I delivered $12M in savings.', pools)
    check('gate blocks an ungrounded personal number', num.blocking.some((f) => f.kind === 'quantity'))
  }

  // ─── letter pipeline: retry once, then flag ───
  {
    let calls = 0
    const writer = async (input: CoverLetterInput) => {
      calls++
      const filler = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
      const first = input.revisionNotes ? 'Acme opened a new plant, which I find interesting.' : 'Your Project Helios is why I applied.'
      return stubResult({ greeting: 'Dear Acme Hiring Team,', paragraphs: [first + ' ' + filler, filler, filler, filler], closing: 'Sincerely,', claims: [], wordCount: 250, dropped_claims: 0 }, 'cover_letter_writer')
    }
    const r = await runCoverLetterPipeline({
      bank, job: { title: 'Intern', company: 'Acme', location: null, summary: 's' },
      companyResearch: { points: [{ id: 'rf1', text: 'Acme opened a new plant' }], summary: 'Acme' },
      evidenceMap: { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [CS] },
      ctx: CTX, user: { name: 'Zuyu Liu' }, deps: { writer },
    })
    check('letter pipeline retries once with revision notes', calls === 2 && r.attempts === 2)
    check('letter pipeline returns the grounded revision', r.flagged === false && r.grounding?.ok === true, JSON.stringify(r.grounding?.blocking))
    check('letter pipeline assembles full text', (r.fullText ?? '').startsWith('Dear Acme Hiring Team,') && (r.fullText ?? '').endsWith('Zuyu Liu'))
  }

  // ─── jobTermsFor ───
  {
    const terms = jobTermsFor({ title: 't', company: 'c', key_requirements: ['Six Sigma Black Belt certification', 'SAP PM'], responsibilities: [], description_excerpt: '' })
    check('jobTermsFor includes sub-phrases', terms.includes('Six Sigma') && terms.includes('SAP PM'), terms.join('|'))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`  FAIL ${f}`)
  process.exit(failed ? 1 : 0)
}

if (/test-career-tailor/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
