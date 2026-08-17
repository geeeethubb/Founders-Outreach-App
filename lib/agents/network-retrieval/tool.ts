// The one tool the Network Retrieval agent has.
//
// Deterministic full-text search plus structured filters. The agent chooses the
// vocabulary and the filters; the search itself has no judgment in it at all.
//
// What comes back is deliberately compact — one rendered line per person, not a
// row. Handing a model 30 JSON objects per round burns the context it needs for
// the actual judgment, and it starts quoting field names back at you.

import type { AgentTool, ToolOutcome } from '../runtime/types'
import { renderCandidateLine } from '@/lib/network/document'
import { searchNetwork, type NetworkCandidate, type NetworkSearchParams, type NetworkSearchResult } from '@/lib/network/search'

/**
 * The search backend.
 *
 * Postgres is the production implementation and the only one the app uses. The
 * seam exists so the eval harness can measure retrieval quality — the agent,
 * the classification, the ranking — against the real 897 contacts before
 * migration 013 has been applied by hand. The eval labels which backend ran.
 */
export type NetworkSearchFn = (params: NetworkSearchParams) => Promise<NetworkSearchResult>

export interface SearchArgs {
  query?: string
  seniority?: string[]
  functions?: string[]
  regions?: string[]
  states?: string[]
  company_types?: string[]
  opportunity_types?: string[]
  relationship?: string[]
  limit?: number
}

export interface SearchLogEntry {
  query: string
  effectiveQuery: string
  filters: Record<string, unknown>
  totalMatches: number
  returned: number
}

/**
 * Built per run so the caller keeps the log and the accumulated candidate pool.
 *
 * The pool matters: the agent shortlists by id, and the orchestrator has to be
 * able to resolve those ids back to people without trusting anything the model
 * echoed back.
 */
export function buildSearchTool(opts: {
  userId: string
  /** Filled in as the agent searches. */
  log: SearchLogEntry[]
  seen: Map<string, NetworkCandidate>
  /** Contacts to keep out of results entirely (already shortlisted elsewhere). */
  exclude?: string[]
  maxSearches?: number
  /** Defaults to Postgres. Injected only by the eval harness. */
  search?: NetworkSearchFn
  /** Live progress. A five-minute agent that prints nothing is undebuggable. */
  onSearch?: (entry: SearchLogEntry & { elapsedMs: number }) => void
}): AgentTool<SearchArgs> {
  const maxSearches = opts.maxSearches ?? 8
  const search = opts.search ?? searchNetwork

  return {
    name: 'search_network',
    description:
      "Ranked full-text search over the user's existing contact database, with optional structured filters. " +
      'Call it several times with different vocabulary. Returns compact summaries, each starting with the ' +
      'contact id you must use to shortlist, plus total_matches — the number of contacts that matched ' +
      'ABOVE A RELEVANCE FLOOR, not everyone who shares a word. A large total means the network really is ' +
      'full of this profile; a small one means it is not.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free text. Terms are OR-ed and results are ranked, so extra related words broaden the net ' +
            'rather than narrowing it. Wrap a phrase in double quotes to require it as a phrase.',
        },
        seniority: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional filter: founder, c_suite, partner, vp, head, director, manager, senior_ic, ic, academic, unknown.',
        },
        functions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional filter: engineering, operations, manufacturing, rnd, data_ai, product, technology, ' +
            'innovation, strategy, consulting, supply_chain, quality, sustainability, commercial, finance, ' +
            'people, legal, investing, academia, general_management, unknown.',
        },
        regions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter: midwest, northeast, south, west, us_other, international, unknown.',
        },
        states: { type: 'array', items: { type: 'string' }, description: 'Optional filter on US state names.' },
        company_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter: startup, growth, corporate, consultancy, investor, academic, nonprofit, government, agency.',
        },
        opportunity_types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional filter — matches anyone carrying ANY of these: internship, full_time_role, short_project, ' +
            'research_project, consulting_project, mentorship, referral, introduction, investment, partnership, ' +
            'speaking, sponsorship, customer_interview.',
        },
        relationship: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional filter: never_contacted, contacted_no_reply, in_conversation, replied_positive, ' +
            'replied_negative, referred, met.',
        },
        limit: { type: 'number', description: 'Rows to return, 1-30. Default 15.' },
      },
    },

    async execute(args: SearchArgs): Promise<ToolOutcome> {
      if (opts.log.length >= maxSearches) {
        return {
          ok: false,
          result: { error: `Search budget exhausted (${maxSearches} searches). Submit your shortlist now.` },
          summary: 'search budget exhausted',
        }
      }

      const startedAt = Date.now()
      const res = await search({
        userId: opts.userId,
        query: args.query ?? null,
        seniority: args.seniority,
        functions: args.functions,
        regions: args.regions,
        states: args.states,
        companyTypes: args.company_types,
        opportunityTypes: args.opportunity_types,
        relationship: args.relationship,
        exclude: opts.exclude,
        // Capped at 30, not 60. Every returned row re-enters the prompt and
        // stays for the rest of the session, so the row budget is a context
        // budget — and the agent gains nothing from reading past the top of a
        // ranked list it can re-query.
        limit: Math.min(30, Math.max(1, args.limit ?? 15)),
      })

      if (res.error) {
        return {
          ok: false,
          result: { error: res.migrationMissing ? 'The contact index does not exist yet.' : res.error.slice(0, 200) },
          summary: `search failed: ${res.error.slice(0, 60)}`,
        }
      }

      for (const c of res.candidates) opts.seen.set(c.contact_id, c)

      const filters: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(args)) {
        if (k === 'query' || v === undefined) continue
        if (Array.isArray(v) && v.length === 0) continue
        filters[k] = v
      }

      const entry: SearchLogEntry = {
        query: args.query ?? '(no text)',
        effectiveQuery: res.effectiveQuery,
        filters,
        totalMatches: res.totalMatches,
        returned: res.candidates.length,
      }
      opts.log.push(entry)
      opts.onSearch?.({ ...entry, elapsedMs: Date.now() - startedAt })

      return {
        ok: true,
        result: {
          total_matches: res.totalMatches,
          showing: res.candidates.length,
          searches_left: maxSearches - opts.log.length,
          candidates: res.candidates.map((c) =>
            renderCandidateLine({
              contact_id: c.contact_id,
              name: c.name,
              title: c.title,
              company: c.company,
              seniority_band: c.seniority_band,
              function_area: c.function_area,
              geo_city: c.geo_city,
              geo_state: c.geo_state,
              industry: c.industry,
              technical_domains: c.technical_domains,
              opportunity_types: c.opportunity_types,
              relationship_status: c.relationship_status,
              evidence_level: c.evidence_level,
              summary: c.summary,
            })
          ),
        },
        summary: `"${(args.query ?? '(filters only)').slice(0, 48)}" → ${res.totalMatches} matches, showing ${res.candidates.length}`,
      }
    },
  }
}
