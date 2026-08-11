// Qualitative report rendering — the "would I actually want to contact them?"
// view. The numeric checks answer whether the output is structurally sound;
// this answers whether the top of the list is any good, which is the thing the
// founder actually cares about.

import fs from 'fs'
import path from 'path'

interface SavedProspect {
  rank: number
  name: string
  title: string | null
  company: string | null
  employees: number | null
  industry: string | null
  linkedin: string | null
  email_status: string
  apollo_id?: string
  total: number
  components: { dimension: string; points: number; max: number; explanation: string }[]
  why_they_fit: string
  why_i_fit_them: string
  resume_item_ids: string[]
  risks: string
  recommendation: string
  judge: { verdict: string; reasoning: string } | null
}

interface SavedProfile {
  id: string
  label: string
  precision: { good: number; maybe: number; bad: number; precision: number }
  top20: SavedProspect[]
}

interface SavedRun {
  iteration: string
  profiles: SavedProfile[]
}

const DIMENSION_LABEL: Record<string, string> = {
  opportunity_fit: 'Opportunity Fit',
  background_relevance: 'Background Relevance',
  decision_influence: 'Decision Influence',
  differentiation: 'Differentiation',
  accessibility: 'Accessibility',
}

/** The per-prospect card from the Phase 3 requirements. */
export function renderProspect(p: SavedProspect): string {
  const lines: string[] = [
    `${p.name}`,
    `${p.title ?? 'unknown title'}`,
    `${p.company ?? 'unknown company'}${p.employees ? ` · ~${p.employees} employees` : ''}`,
    '',
    `TOTAL SCORE: ${p.total}/100`,
    '',
  ]
  for (const c of p.components) {
    lines.push(`${(DIMENSION_LABEL[c.dimension] ?? c.dimension).padEnd(22)} ${c.points}/${c.max}`)
  }
  lines.push('', 'WHY THEY FIT:', p.why_they_fit)
  lines.push('', 'WHY I FIT THEM:', p.why_i_fit_them)
  lines.push(`  [resume items: ${p.resume_item_ids.join(', ') || 'none'}]`)
  lines.push('', 'RISKS:', p.risks)
  lines.push('', `RECOMMENDATION: ${p.recommendation}`)
  if (p.judge) lines.push(`JUDGE: ${p.judge.verdict} — ${p.judge.reasoning}`)
  return lines.join('\n')
}

export function renderTop10Report(runFile: string): string {
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8')) as SavedRun
  const out: string[] = [`# Qualitative Top-10 Review — iteration ${run.iteration}`, '']

  for (const profile of run.profiles) {
    out.push(`## ${profile.label}`)
    out.push(
      `Precision@20: ${(profile.precision.precision * 100).toFixed(0)}% ` +
        `(${profile.precision.good} GOOD / ${profile.precision.maybe} MAYBE / ${profile.precision.bad} BAD)`
    )
    out.push('')
    for (const p of profile.top20.slice(0, 10)) {
      out.push('```')
      out.push(renderProspect(p))
      out.push('```')
      out.push('')
    }
  }
  return out.join('\n')
}

/** Compact cross-profile table for scanning the whole top-100 quickly. */
export function renderScanTable(runFile: string): string {
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8')) as SavedRun
  const out: string[] = []
  for (const profile of run.profiles) {
    out.push(`\n### ${profile.label} — P@20 ${(profile.precision.precision * 100).toFixed(0)}%\n`)
    out.push('| # | Score | Verdict | Name | Title | Company | Emp |')
    out.push('|---|-------|---------|------|-------|---------|-----|')
    for (const p of profile.top20) {
      out.push(
        `| ${p.rank} | ${p.total} | ${p.judge?.verdict ?? '?'} | ${p.name} | ${(p.title ?? '').slice(0, 40)} | ${(p.company ?? '').slice(0, 30)} | ${p.employees ?? '?'} |`
      )
    }
  }
  return out.join('\n')
}

if (require.main === module) {
  const file = process.argv[2] ?? path.join(process.cwd(), '.eval-runs', 'iteration-final.json')
  process.stdout.write(renderTop10Report(file))
  process.stdout.write('\n\n')
  process.stdout.write(renderScanTable(file))
  process.stdout.write('\n')
}
