// Deterministic pre-checks on a proposed bullet — the gate that runs BEFORE
// the fact verifier and needs no model.
//
// The claim-safety gate in lib/outreach/grounding.ts already does the hard
// part (format-tolerant quantities, acronyms and proper nouns, hard
// superlatives, placeholders) and is reused as-is. What a résumé bullet needs
// on top of an email:
//
//   small counts     "4 teams", "3 suppliers" — a cold email waves these
//                    through as prose; on a résumé every count is a claim
//   tools            lowercase or mixed-case names ("n8n", "PyTorch", "VASP")
//                    that the entity scan, built for capitalised nouns, misses
//   ownership        verb pairs from rules.ts — a WARNING for the verifier
//   keyword stuffing a job-description term that appears in the proposal and
//                    nowhere in the evidence. This is the "the JD says
//                    Kubernetes, so say Kubernetes" attack, and it is the
//                    single most likely way a tailor fabricates.
//
// A blocking finding means the verifier is never asked: the change is rejected
// with the original kept, and the finding is shown.

import { checkGrounding, extractQuantities } from '@/lib/outreach/grounding'
import { stripMarkdown } from '../documents/docx-read'
import { OWNERSHIP_ESCALATION } from './rules'
import type { EvidencePool } from '../evidence/render'
import type { ProposedChange } from '../types'

export type PrecheckKind =
  | 'quantity' | 'entity' | 'tool' | 'superlative' | 'ownership' | 'title' | 'keyword_stuffing' | 'placeholder' | 'emphasis'

export interface Finding {
  kind: PrecheckKind
  /** The exact span that could not be grounded. */
  span: string
  reason: string
}

export interface PrecheckResult {
  ok: boolean
  blocking: Finding[]
  warnings: Finding[]
}

/**
 * Tool and system names that appear in engineering résumés and do not look
 * like proper nouns to a capitalisation-based scan. Case-insensitive match.
 * Anything on this list found in a proposal must be in the pool.
 */
const TOOL_LEXICON = [
  'n8n', 'vasp', 'ase', 'python', 'sql', 'matlab', 'aspen', 'aspen plus', 'aspen hysys', 'hysys',
  'autocad', 'solidworks', 'comsol', 'ansys', 'labview', 'minitab', 'jmp', 'tableau', 'power bi',
  'excel', 'vba', 'r', 'julia', 'c++', 'java', 'javascript', 'typescript', 'react', 'node',
  'pytorch', 'tensorflow', 'scikit-learn', 'sklearn', 'pandas', 'numpy', 'docker', 'kubernetes',
  'aws', 'azure', 'gcp', 'sap', 'sap pm', 'oracle', 'salesforce', 'jira', 'confluence', 'git',
  'github', 'linux', 'bash', 'langchain', 'openai', 'anthropic', 'claude', 'gpt', 'llm',
  'six sigma', 'lean', 'kaizen', 'kanban', 'fmea', 'dmaic', 'spc', 'gmp', 'iso 9001', 'haccp',
  'plc', 'scada', 'mes', 'erp', 'lims', 'cad', 'cfd', 'fea', 'dft', 'gaussian', 'lammps',
  'palantir', 'foundry', 'snowflake', 'databricks', 'spark', 'hadoop', 'airflow', 'dbt',
]

/** Generic words that read as CamelCase or tool-shaped but assert nothing. */
const TOOL_ALLOWLIST = new Set(['id', 'ok', 'ai', 'ml', 'us', 'qa', 'qc', 'r&d', 'pm', 'it', 'hr'])

function norm(s: string): string {
  return s.toLowerCase().replace(/[’]/g, "'")
}

function poolText(pool: EvidencePool): string {
  return norm(pool.lines.join('\n'))
}

function wordIn(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9+#])${escaped}(?=$|[^a-z0-9+#])`, 'i').test(text)
}

// ─── Small counts ────────────────────────────────────────────────────────────

/**
 * Every integer below 10 the outreach gate ignores, minus the ones that are
 * grammar. A résumé bullet saying "4 teams" is asserting four teams.
 */
function smallCounts(text: string): string[] {
  const out: string[] = []
  // The lookbehind keeps a decimal fraction ("$1.5 million") from reading as
  // a count of 5 — the factuality eval blocked an emphasis-only change on it.
  const re = /(?<![\d.,$])\b(\d)(?:\+)?\b(?![\d.,:%])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8).toLowerCase()
    // "Level 2", "Phase 3", "Q3": labels, not quantities. Also skip ordinals-in-prose "1st".
    const before = text.slice(Math.max(0, m.index - 8), m.index).toLowerCase()
    if (/\b(level|phase|tier|q|step|stage|part|figure|table|version|v)\s?$/.test(before)) continue
    if (/^(st|nd|rd|th)\b/.test(after)) continue
    out.push(m[1])
  }
  return out
}

function poolHasNumber(pool: string, n: string): boolean {
  return new RegExp(`(^|[^\\d.,])${n}(?=$|[^\\d])`).test(pool)
}

// ─── Tools ───────────────────────────────────────────────────────────────────

function toolMentions(text: string): string[] {
  const found = new Set<string>()
  for (const tool of TOOL_LEXICON) {
    if (tool.length <= 1) continue
    if (wordIn(text, tool)) found.add(tool)
  }
  // Tool-shaped tokens the lexicon does not list: letters+digits ("n8n",
  // "GPT-4") and CamelCase ("PyTorch", "LangChain").
  for (const tok of text.split(/\s+/)) {
    const t = tok.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '')
    if (!t || TOOL_ALLOWLIST.has(t.toLowerCase())) continue
    if (/^[a-z]+\d+[a-z]+$/i.test(t) || /^[A-Z][a-z]+[A-Z][A-Za-z]+$/.test(t)) found.add(t)
  }
  return [...found]
}

// ─── Ownership ───────────────────────────────────────────────────────────────

function ownershipEscalations(original: string, proposed: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = []
  for (const pair of OWNERSHIP_ESCALATION) {
    if (wordIn(original, pair.from) && !wordIn(original, pair.to) && wordIn(proposed, pair.to)) out.push(pair)
  }
  return out
}

// ─── Extra superlatives ──────────────────────────────────────────────────────

/** Ranking words the outreach gate leaves to judgment; on a résumé they are claims. */
const RESUME_SUPERLATIVES = ['#1', 'first-ever', 'the first', 'number one', 'largest', 'flagship']

// ─── Emphasis ────────────────────────────────────────────────────────────────

function boldSpans(text: string): string[] {
  return [...text.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1].trim())
}

/**
 * Bold is a claim about what matters. It may sit on a metric or on a span
 * that was already bold; bolding "led" or a tool name is emphasis the résumé
 * never made, and it is the cheapest way to make a bullet read bigger.
 */
function illegalEmphasis(original: string | null, proposedRaw: string): string[] {
  const allowed = new Set(boldSpans(original ?? '').map((s) => norm(s)))
  return boldSpans(proposedRaw).filter((span) => !allowed.has(norm(span)) && !/[\d$%]/.test(span))
}

/** True when the proposal differs from the original only in `**` markers. */
export function isEmphasisOnly(original: string | null, proposed: string | null): boolean {
  if (!original || !proposed) return false
  return stripMarkdown(original).trim() === stripMarkdown(proposed).trim() && original.trim() !== proposed.trim()
}

/**
 * The words are the original's — bold moved or nothing moved at all. The
 * factuality eval found the tailor proposing a "reword" that was verbatim the
 * master bullet, and the verifier duly spent a call confirming it was
 * identical to itself. Neither case has a clause to audit.
 */
export function isWordingUnchanged(original: string | null, proposed: string | null): boolean {
  if (!original || !proposed) return false
  return stripMarkdown(original).trim() === stripMarkdown(proposed).trim()
}

// ─── The pre-check ───────────────────────────────────────────────────────────

/**
 * Check one proposed change against the pool for ITS experience.
 *
 * `original` is the bullet being changed (null for a new bullet); it is what
 * ownership escalation is measured against. `jobTerms` are the job's skills
 * and requirement phrases — the vocabulary a stuffed keyword would come from.
 */
export function precheckChange(
  change: ProposedChange,
  pool: EvidencePool,
  original: string | null,
  jobTerms: string[] = []
): PrecheckResult {
  const blocking: Finding[] = []
  const warnings: Finding[] = []

  const proposed = stripMarkdown(change.proposed_text ?? '').trim()
  // Nothing to check for a reorder or remove; a swap carries its source text
  // and is checked like any other, since the source is in the pool anyway.
  if (!proposed) return { ok: true, blocking, warnings }

  const pool_ = poolText(pool)
  const originalPlain = stripMarkdown(original ?? '')

  // 1. The shared gate: quantities, capitalised entities, hard superlatives,
  //    placeholders. Its responsibility patterns are about "you" and do not
  //    apply to a bullet, so they are dropped.
  const shared = checkGrounding({ subject: '', body: proposed, evidence: pool.lines })
  for (const f of shared.findings) {
    if (f.kind === 'responsibility') continue
    const target = f.severity === 'blocking' ? blocking : warnings
    target.push({ kind: f.kind, span: f.claim, reason: f.reason })
  }

  // 2. Small counts.
  const poolCounts = extractQuantities(pool.lines.join('\n')).map((q) => String(q.value))
  for (const n of smallCounts(proposed)) {
    if (poolHasNumber(pool_, n) || poolCounts.includes(n)) continue
    blocking.push({ kind: 'quantity', span: n, reason: `The count "${n}" appears in no fact, metric or bullet for this experience.` })
  }

  // 3. Keyword stuffing — checked before tools so the finding names the
  //    attack, not the category the term happens to fall into.
  const seen = new Set<string>()
  for (const raw of jobTerms) {
    const term = norm(raw).trim()
    if (term.length < 3 || seen.has(term)) continue
    seen.add(term)
    if (!wordIn(proposed, term)) continue
    if (wordIn(pool_, term)) continue
    if (blocking.some((b) => norm(b.span) === term)) continue
    blocking.push({
      kind: 'keyword_stuffing',
      span: raw,
      reason: `"${raw}" comes from the job description and appears nowhere in the evidence for this experience.`,
    })
  }

  // 4. Tools and systems.
  for (const tool of toolMentions(proposed)) {
    if (wordIn(pool_, tool.toLowerCase())) continue
    if (blocking.some((b) => norm(b.span) === norm(tool))) continue
    blocking.push({ kind: 'tool', span: tool, reason: `"${tool}" is a tool or system name that no evidence for this experience mentions.` })
  }

  // 5. Résumé-specific superlatives.
  for (const s of RESUME_SUPERLATIVES) {
    if (!wordIn(proposed, s) || wordIn(pool_, s)) continue
    if (blocking.some((b) => b.kind === 'superlative' && norm(b.span) === s)) continue
    blocking.push({ kind: 'superlative', span: s, reason: `"${s}" is a ranking claim that no evidence for this experience makes.` })
  }

  // 6. Emphasis: bold only what was bold or is a number.
  for (const span of illegalEmphasis(original, change.proposed_text ?? '')) {
    blocking.push({ kind: 'emphasis', span, reason: `"${span}" is bolded but is neither a metric nor bold in the original.` })
  }

  // 7. Ownership escalation — warn, name the pair, let the verifier decide.
  if (originalPlain) {
    for (const p of ownershipEscalations(originalPlain, proposed)) {
      warnings.push({
        kind: 'ownership',
        span: p.to,
        reason: `"${p.from}" in the original became "${p.to}" — an ownership upgrade the facts must support.`,
      })
    }
  }

  return { ok: blocking.length === 0, blocking, warnings }
}

/** One line for notes and the UI. */
export function summarizeFindings(findings: Finding[]): string {
  return findings.map((f) => `${f.kind}: "${f.span}"`).join('; ')
}
