// The résumé importer's output schema and the enums it validates against.
// Kept beside ./index so the validator (which reads the enums) and the loop
// (which sends the schema) share one definition.

import type { FactCategory, SkillCategory, ExperienceKind } from '@/lib/career/types'
import { RESUME_SOURCE_LABEL } from './prompt'

export const FACT_CATEGORIES: FactCategory[] = [
  'responsibility', 'achievement', 'metric', 'skill', 'tool', 'context', 'award', 'education', 'scope', 'other',
]
export const SKILL_CATEGORIES: SkillCategory[] = ['technical', 'tool', 'domain', 'business', 'language', 'other']
export const EXPERIENCE_KINDS: ExperienceKind[] = ['experience', 'project', 'leadership', 'research', 'education', 'award', 'other']

const FACT_REFS = { type: 'array', items: { type: 'integer' }, description: 'Indexes into this experience\'s facts array.' }

export const OUTPUT_SCHEMA = {
  properties: {
    experiences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          experience_key: { type: 'string', description: 'A supplied key, copied exactly.' },
          summary: { type: 'string', description: 'One sentence.' },
          new_experience: {
            type: ['object', 'null'],
            description: 'A proposed block, or the role as THIS text states it when filing under an existing id. Otherwise null.',
            properties: {
              title: { type: 'string' },
              organization: { type: 'string' },
              location: { type: ['string', 'null'] },
              start_date: { type: ['string', 'null'] },
              end_date: { type: ['string', 'null'] },
              kind: { type: 'string', enum: EXPERIENCE_KINDS },
            },
            required: ['title', 'organization', 'location', 'start_date', 'end_date', 'kind'],
          },
          facts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                statement: { type: 'string', description: 'ONE atomic claim, numbers verbatim.' },
                category: { type: 'string', enum: FACT_CATEGORIES },
                source_label: { type: 'string', description: `"${RESUME_SOURCE_LABEL}" or an additional source label.` },
                paragraph_index: { type: 'integer', description: 'The ¶ or L index shown next to the paragraph.' },
                confidence: { type: 'number', description: '0 to 1.' },
              },
              required: ['statement', 'category', 'source_label', 'paragraph_index', 'confidence'],
            },
          },
          metrics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string', description: 'Exactly as written: "$4M+", "30%", "1,600+".' },
                unit: { type: ['string', 'null'] },
                context: { type: ['string', 'null'] },
                fact_refs: FACT_REFS,
              },
              required: ['value', 'unit', 'context', 'fact_refs'],
            },
          },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string', enum: SKILL_CATEGORIES },
                fact_refs: FACT_REFS,
              },
              required: ['name', 'category', 'fact_refs'],
            },
          },
          deliverables: {
            type: 'array',
            items: {
              type: 'object',
              properties: { description: { type: 'string' }, fact_refs: FACT_REFS },
              required: ['description', 'fact_refs'],
            },
          },
        },
        required: ['experience_key', 'summary', 'new_experience', 'facts', 'metrics', 'skills', 'deliverables'],
      },
    },
    projects: {
      type: 'array',
      description: 'Only projects the text NAMES. Empty when none.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exactly as the text writes it.' },
          experience_ref: { type: ['integer', 'string'], description: 'Index into experiences above, or an existing experience id.' },
          description: { type: ['string', 'null'] },
          fact_refs: FACT_REFS,
        },
        required: ['name', 'experience_ref', 'description', 'fact_refs'],
      },
    },
  },
  required: ['experiences'],
}
