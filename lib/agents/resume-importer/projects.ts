// Project validation for the résumé importer.
//
// A project is named work under one experience ("Forge", "Keywords", a
// summit). The importer may propose one ONLY when the source text names
// it: the name must appear, case-insensitively, in a supplied header,
// bullet or extra-source line, or the project is a guess and falls. Its
// fact_refs are the model's positions, remapped to the positions that
// survived validation of that experience's facts.

import { normalizeModelText } from '../runtime/text'
import type { ResumeImporterInput } from './prompt'

export interface ImportedProject {
  name: string
  /** The output experience this project happened under (its experience_key). */
  experience_key: string
  description: string | null
  /** Indexes into that experience's facts[] AFTER validation. */
  fact_refs: number[]
}

export interface ProjectContext {
  /** The model's experience positions → surviving keys. */
  keyOfRawIndex: Map<number, string>
  /** Each surviving key's fact index map (model position → surviving position). */
  factMapOfKey: Map<string, { map: Map<number, number>; rawCount: number }>
  seenKeys: Set<string>
  headerOf: Map<string, string>
  refs: (v: unknown, max: number) => number[]
}

/** Every line the model was shown, lowercased, for the substring check. */
export function sourceTextOf(input: ResumeImporterInput, headerOf: Map<string, string>): string {
  return [
    ...input.experiences.flatMap((e) => [headerOf.get(e.key) ?? '', ...e.bullets.map((b) => b.text)]),
    ...input.extra_sources.flatMap((s) => s.lines.map((l) => l.text)),
  ].join('\n').toLowerCase()
}

export function validateProjects(
  raw: unknown,
  input: ResumeImporterInput,
  ctx: ProjectContext
): { projects: ImportedProject[]; dropped: number } {
  const allText = sourceTextOf(input, ctx.headerOf)
  const projects: ImportedProject[] = []
  let dropped = 0
  const seen = new Set<string>()
  for (const rp of Array.isArray(raw) ? raw : []) {
    if (!rp || typeof rp !== 'object') continue
    const p = rp as Record<string, unknown>
    const name = normalizeModelText(p.name)
    const ref = p.experience_ref
    const key =
      typeof ref === 'number' ? ctx.keyOfRawIndex.get(ref)
      : typeof ref === 'string' && ctx.seenKeys.has(ref) ? ref
      : undefined
    if (!name || !key || !allText.includes(name.toLowerCase()) || seen.has(`${key}::${name.toLowerCase()}`)) {
      dropped++
      continue
    }
    seen.add(`${key}::${name.toLowerCase()}`)
    const fm = ctx.factMapOfKey.get(key)
    const factRefs = fm ? ctx.refs(p.fact_refs, fm.rawCount).map((i) => fm.map.get(i)).filter((i): i is number => i !== undefined) : []
    projects.push({ name, experience_key: key, description: normalizeModelText(p.description) || null, fact_refs: factRefs })
  }
  return { projects, dropped }
}
