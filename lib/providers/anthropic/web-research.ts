// WebResearchProvider backed by Anthropic's server-side `web_search` tool.
//
// Why this and not the OpenAI implementation it replaces: the searching model
// and the reasoning model are now the same model, so a research agent can run
// one tool loop instead of round-tripping findings between two vendors. The
// interface is unchanged (ADR-006), so the swap is a provider change.
//
// The important property is preserved: every returned finding carries a
// `source_url` taken from a REAL citation the model emitted, not from prose it
// wrote. `research_facts.fact_requires_source` is a DB constraint, so an
// unsourceable claim cannot be persisted as a FACT.

import { anthropicComplete, recordWebSearches } from './client'
import { ANTHROPIC_WEB_SEARCH_COST_PER_CALL } from '@/lib/ai/models'
import { cached, cacheKey } from '../cache'
import type {
  ProviderCapabilities,
  ProviderResult,
  WebFinding,
  WebResearchProvider,
  WebResearchQuery,
} from '../types'

const CAPABILITIES: ProviderCapabilities = {
  organization_search: false,
  people_search: false,
  person_enrichment: false,
  web_research: true,
}

/** Anthropic's server tool identifier. Env-overridable so a version bump is config. */
const WEB_SEARCH_TOOL_TYPE = process.env.ANTHROPIC_WEB_SEARCH_TOOL ?? 'web_search_20250305'

// ─── Usage accounting ────────────────────────────────────────────────────────

export interface WebSearchStats {
  calls: number
  cachedCalls: number
  searches: number
  errors: number
  costUsd: number
}

const stats: WebSearchStats = { calls: 0, cachedCalls: 0, searches: 0, errors: 0, costUsd: 0 }

export function anthropicWebStats(): WebSearchStats {
  return { ...stats }
}

export function resetAnthropicWebStats(): void {
  stats.calls = 0
  stats.cachedCalls = 0
  stats.searches = 0
  stats.errors = 0
  stats.costUsd = 0
}

/** Hard ceiling so a bug cannot produce an uncontrolled search loop. */
let searchBudget = Number(process.env.WEB_SEARCH_MAX_PER_RUN ?? 400)

export function setWebSearchBudget(n: number): void {
  searchBudget = n
}

export class WebSearchBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`Web search budget exceeded (${limit} live searches). Raise WEB_SEARCH_MAX_PER_RUN or rely on the cache.`)
    this.name = 'WebSearchBudgetExceeded'
  }
}

// ─── Citation extraction ─────────────────────────────────────────────────────

interface Citation {
  type?: string
  url?: string
  title?: string
  cited_text?: string
}

interface TextBlockWithCitations {
  type: string
  text?: string
  citations?: Citation[] | null
}

export interface WebResearchRaw {
  text: string
  citations: { url: string; title: string | null; snippet: string | null }[]
  searches: number
  error?: string
}

function httpUrl(u: string | undefined): string | null {
  if (!u) return null
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

async function callWebSearch(prompt: string, maxResults: number): Promise<WebResearchRaw> {
  if (stats.searches >= searchBudget) throw new WebSearchBudgetExceeded(searchBudget)

  stats.calls++

  const res = await anthropicComplete({
    role: 'reasoning',
    system:
      'You are a research assistant. Search the web and answer concisely and factually. ' +
      'Cite every specific claim. If the web does not support a claim, say so explicitly ' +
      'rather than guessing. Prefer primary sources (company sites, filings, official news).',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 2000,
    tools: [
      {
        type: WEB_SEARCH_TOOL_TYPE,
        name: 'web_search',
        max_uses: Math.max(1, Math.min(8, maxResults)),
      },
    ],
  })

  if (res.error) {
    stats.errors++
    return { text: '', citations: [], searches: 0, error: res.error }
  }

  // Count the server-side searches Anthropic actually performed, and bill them.
  // Search is priced per request, separately from tokens.
  const searches = res.content.filter(
    (b) => (b as { type: string; name?: string }).type === 'server_tool_use' &&
      (b as { name?: string }).name === 'web_search'
  ).length

  stats.searches += searches
  const searchCost = searches * ANTHROPIC_WEB_SEARCH_COST_PER_CALL
  stats.costUsd += searchCost + res.usage.costUsd
  recordWebSearches(searches, searchCost)

  // Provenance comes from citation objects the model attached to its own text.
  // Anything it merely *wrote* that looks like a URL is deliberately ignored.
  const seen = new Set<string>()
  const citations: { url: string; title: string | null; snippet: string | null }[] = []
  for (const block of res.content as unknown as TextBlockWithCitations[]) {
    if (block.type !== 'text') continue
    for (const c of block.citations ?? []) {
      const url = httpUrl(c.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      citations.push({ url, title: c.title ?? null, snippet: c.cited_text ?? null })
    }
  }

  return { text: res.text, citations, searches }
}

export class AnthropicWebResearchProvider implements WebResearchProvider {
  readonly id = 'anthropic_web'
  readonly capabilities = CAPABILITIES

  isAvailable(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY)
  }

  async research(query: WebResearchQuery): Promise<ProviderResult<WebFinding>> {
    const raw = await this.researchRaw(query)
    if (raw.error) return { items: [], error: raw.error }

    const retrievedAt = new Date().toISOString()
    return {
      items: raw.citations.map((c) => ({
        claim: raw.text,
        source_url: c.url,
        source_title: c.title,
        published_at: null,
        snippet: c.snippet,
        provenance: {
          provider_id: this.id,
          query_ref: { query: query.query },
          retrieved_at: retrievedAt,
        },
      })),
    }
  }

  /** Text + citations, cached. Research agents consume this directly. */
  async researchRaw(query: WebResearchQuery): Promise<WebResearchRaw> {
    if (!this.isAvailable()) {
      return { text: '', citations: [], searches: 0, error: 'ANTHROPIC_API_KEY is not set' }
    }

    const prompt = query.context ? `${query.context}\n\n${query.query}` : query.query
    const key = cacheKey('anthropic_web_research', { prompt, max: query.max_results ?? 6 })

    let wasCached = true
    const result = await cached<WebResearchRaw>(
      key,
      async () => {
        wasCached = false
        return callWebSearch(prompt, query.max_results ?? 6)
      },
      false,
      // ADR-015: never cache a failure, or a transient error becomes permanent.
      (v) => !v.error
    )

    if (wasCached) stats.cachedCalls++
    return result
  }
}

export const anthropicWebResearchProvider = new AnthropicWebResearchProvider()
