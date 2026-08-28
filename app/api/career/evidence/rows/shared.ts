// The allow-list and column filter for row edits from the Evidence page.
//
// The page speaks in table names, so the route must decide which tables and
// which columns a browser may write. Anything else — user_id, ids, created_at,
// a table outside the bank — is dropped before it reaches the client library.

export const EDITABLE_TABLES = [
  'evidence_experiences', 'evidence_facts', 'evidence_metrics', 'evidence_deliverables',
  'evidence_skills', 'evidence_stories', 'evidence_preferences', 'resume_bullets',
] as const
export type EditableTable = (typeof EDITABLE_TABLES)[number]

export const APPROVABLE_TABLES = EDITABLE_TABLES.filter((t) => t !== 'evidence_preferences') as Exclude<EditableTable, 'evidence_preferences'>[]

const COLUMNS: Record<EditableTable, string[]> = {
  evidence_experiences: ['kind', 'organization', 'title', 'start_date', 'end_date', 'location', 'description', 'display_order', 'source', 'approved'],
  evidence_facts: ['experience_id', 'statement', 'category', 'source', 'source_location', 'confidence', 'approved'],
  evidence_metrics: ['experience_id', 'value', 'unit', 'context', 'fact_ids', 'source', 'approved'],
  evidence_deliverables: ['experience_id', 'description', 'fact_ids', 'approved'],
  evidence_skills: ['name', 'category', 'evidence_fact_ids', 'approved'],
  evidence_stories: ['experience_id', 'title', 'situation', 'task', 'actions', 'result', 'learning', 'evidence_fact_ids', 'approved'],
  evidence_preferences: ['category', 'value', 'weight', 'hard_constraint', 'note'],
  resume_bullets: ['experience_id', 'text', 'evidence_fact_ids', 'display_order', 'is_on_master', 'approved'],
}

const REQUIRED: Partial<Record<EditableTable, string[]>> = {
  evidence_experiences: ['organization', 'title'],
  evidence_facts: ['statement'],
  evidence_metrics: ['value'],
  evidence_deliverables: ['description'],
  evidence_skills: ['name'],
  evidence_stories: ['title'],
  evidence_preferences: ['category', 'value'],
  resume_bullets: ['text'],
}

export function sanitizeRow(
  table: EditableTable,
  raw: Record<string, unknown>,
  opts: { partial?: boolean } = {}
): { row: Record<string, unknown> } | { error: string } {
  const row: Record<string, unknown> = {}
  for (const col of COLUMNS[table]) {
    if (!(col in raw)) continue
    const v = raw[col]
    if (typeof v === 'string') row[col] = v.trim()
    else if (v === null || typeof v === 'number' || typeof v === 'boolean') row[col] = v
    else if (Array.isArray(v)) row[col] = v.filter((x) => typeof x === 'string')
  }
  if (!opts.partial) {
    for (const col of REQUIRED[table] ?? []) {
      if (!row[col] || (typeof row[col] === 'string' && !(row[col] as string).length)) return { error: `${col} is required` }
    }
  }
  if ('weight' in row && typeof row.weight === 'number') row.weight = Math.min(1, Math.max(0, row.weight))
  if ('confidence' in row && typeof row.confidence === 'number') row.confidence = Math.min(1, Math.max(0, row.confidence))
  // A row a human typed in is a human's claim, not a model's — but the page
  // still decides; default is the schema's false.
  return { row }
}
