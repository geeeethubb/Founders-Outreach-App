// Renderings of a RelevantEvidence slice for prompts, and the mapping to the
// outreach loop's BackgroundItem shape. Pure; deterministic.
//
//   compact   one line per experience + its top facts (fit evaluator, planner,
//             positioning summaries)
//   detailed  compact + fact ids, metrics and projects (evidence matcher, tailor)

import type { BackgroundItemLike, RelevantEvidence, RelevantExperience } from './retrieval-types'

const hasNumber = (text: string): boolean => /\d/.test(text)

export interface RenderOptions {
  style: 'compact' | 'detailed'
  /** Default 3 for compact, 6 for detailed. */
  maxFactsPerExperience?: number
}

function labels(s: string[]): string {
  return s.length ? ` (${s.join('; ')})` : ''
}

function header(e: RelevantExperience): string {
  const period = e.period ? ` (${e.period})` : ''
  const summary = e.summary ? `: ${e.summary}` : ''
  return `[${e.experience.id}] ${e.organization} — ${e.roleTitle}${period}${summary}`
}

export function renderRelevantEvidence(rel: RelevantEvidence, opts: RenderOptions): string {
  if (rel.experiences.length === 0) return '(no approved experiences recorded)'
  const detailed = opts.style === 'detailed'
  const maxFacts = opts.maxFactsPerExperience ?? (detailed ? 6 : 3)
  const blocks: string[] = []
  for (const e of rel.experiences) {
    const lines = [header(e)]
    for (const f of e.facts.slice(0, maxFacts)) {
      lines.push(detailed ? `  - [${f.fact.id}] ${f.fact.statement}${labels(f.sourceLabels)}` : `  - ${f.fact.statement}${labels(f.sourceLabels)}`)
    }
    if (detailed && e.metrics.length) {
      lines.push(`  METRICS: ${e.metrics.map((m) => `[${m.id}] ${m.value}${m.unit ? ` ${m.unit}` : ''}${m.context ? ` — ${m.context}` : ''}`).join('; ')}`)
    }
    if (detailed && e.projects.length) {
      lines.push(`  PROJECTS: ${e.projects.map((p) => `${p.name}${p.description ? ` — ${p.description}` : ''}`).join('; ')}`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join(detailed ? '\n\n' : '\n')
}

// ─── BackgroundItem mapping ──────────────────────────────────────────────────

/**
 * A small, fixed domain lexicon. Deterministic tags for the positioning
 * agent's `domains` field; it is a hint, not a judgment, so the list is
 * deliberately short and the patterns deliberately literal.
 */
const DOMAIN_LEXICON: [string, RegExp][] = [
  ['manufacturing', /manufactur|plant\b|production line|packing line|factory|manufacturing site/],
  ['quality', /\bquality\b|\bqa\b|\bsop\b|validation|controlled state|risk assessment|scrap/],
  ['process automation', /automation|automat|process improvement|controlled state|workflow/],
  ['AI/agents', /\bai\b|\bagents?\b|agentic|\bllm\b|machine learning|\bn8n\b|artificial intelligence/],
  ['catalysis', /catalys|\bdft\b|\bvasp\b|\base\b|fuel cell|electrocatal|computational chem/],
  ['energy', /\benergy\b|solar|hydrogen|biofuel|electrode|battery|\bcsp\b/],
  ['clean-tech', /cleantech|clean-tech|clean energy|sustainab|carbon|climate|de-ionization|desalination|recycl/],
  ['consulting', /consult|fortune 500|client engagement|\bclient\b/],
  ['M&A', /\bm&a\b|merger|acquisition|due diligence|screening/],
  ['startups', /startup|founder|founding team|entrepreneur|accelerator|y combinator|startup school/],
  ['events/community', /\bevents?\b|summit|hackathon|community|organized|attendees|speaker|podcast|host/],
  ['venture', /\bventure\b|\bvc\b|investor|scout|accelerator|\bfund\b|round/],
  ['research', /research|\blab\b|laboratory|whitepaper|techno-economic|analysis/],
  ['education', /\bstudent\b|b\.s\.|\bgpa\b|graduat|scholar|university|undergraduate/],
]

export function domainsFor(e: RelevantExperience, skillNames: string[]): string[] {
  const text = [e.roleTitle, e.summary, ...e.facts.map((f) => f.fact.statement)].join(' ').toLowerCase()
  const out: string[] = []
  for (const [domain, re] of DOMAIN_LEXICON) if (re.test(text)) out.push(domain)
  for (const name of skillNames) {
    const n = name.trim().toLowerCase()
    if (n && !out.includes(n)) out.push(n)
  }
  return out.slice(0, 8)
}

export function credibilityFor(e: RelevantExperience): BackgroundItemLike['credibility'] {
  const strong =
    e.metrics.length > 0 ||
    e.facts.some((f) => (f.fact.category === 'achievement' || f.fact.category === 'metric') && hasNumber(f.fact.statement)) ||
    e.facts.some((f) => f.support_count >= 2)
  if (strong) return 'strong'
  return e.facts.length > 0 ? 'moderate' : 'supporting'
}

function kindFor(kind: string): BackgroundItemLike['kind'] {
  switch (kind) {
    case 'project': return 'project'
    case 'award': return 'award'
    case 'education': return 'education'
    default: return 'experience'
  }
}

/** One BackgroundItem per returned experience. Skill names come from the slice's skills linked to each experience's facts. */
export function toBackgroundItems(rel: RelevantEvidence): BackgroundItemLike[] {
  return rel.experiences.map((e) => {
    const factIds = new Set(e.facts.map((f) => f.fact.id))
    const skillNames = rel.skills
      .filter((s) => s.evidence_fact_ids.some((id) => factIds.has(id)))
      .map((s) => s.name)
      .sort()
    return {
      id: e.experience.id,
      kind: kindFor(e.experience.kind),
      title: e.roleTitle,
      org: e.organization,
      period: e.period,
      summary: e.summary,
      domains: domainsFor(e, skillNames),
      credibility: credibilityFor(e),
    }
  })
}
