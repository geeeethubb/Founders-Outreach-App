// WebResearchProvider backed by the OpenAI Responses API `web_search` tool.
//
// This is the default implementation of the interface defined in ADR-006. It
// needs no new vendor — the SDK and key are already present — and it returns
// real `url_citation` annotations, which is what makes FACT-typed research
// claims sourceable and therefore persistable.
//
// Kept behind `WebResearchProvider` so Tavily/Exa can replace it without any
// change to the research agents.

import { cached, cacheKey } from '../cache'
import { modelFor } from '@/lib/ai/models'
import type {
  ProviderCapabilities,
  ProviderResult,
  WebFinding,
  WebResearchProvider,
  WebResearchQuery,
} from '../types'

const RESPONSES_URL = 'https://api.openai.com/v1/responses'

const CAPABILITIES: ProviderCapabilities = {
  organization_search: false,
  people_search: false,
  person_enrichment: false,
  web_research: true,
}

// ─── Usage accounting ────────────────────────────────────────────────────────

export interface WebSearchStats {
  searches: number
  cachedSearches: number
  tokens_in: number
  tokens_out: number
  errors: number
}

const stats: WebSearchStats = { searches: 0, cachedSearches: 0, tokens_in: 0, tokens_out: 0, errors: 0 }

export function webSearchStats(): WebSearchStats {
  return { ...stats }
}

export function resetWebSearchStats(): void {
  stats.searches = 0
  stats.cachedSearches = 0
  stats.tokens_in = 0
  stats.tokens_out = 0
  stats.errors = 0
}

/** Hard ceiling so a bug cannot produce an uncontrolled search loop. */
let searchBudget = Number(process.env.WEB_SEARCH_MAX_PER_RUN ?? 600)

export function setWebSearchBudget(n: number): void {
  searchBudget = n
}

export class WebSearchBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`Web search budget exceeded (${limit} live searches). Raise WEB_SEARCH_MAX_PER_RUN or rely on the cache.`)
    this.name = 'WebSearchBudgetExceeded'
  }
}

// ─── Response shapes ─────────────────────────────────────────────────────────

interface UrlCitation {
  type: string
  url?: string
  title?: string
  start_index?: number
  end_index?: number
}

interface OutputContent {
  type: string
  text?: string
  annotations?: UrlCitation[]
}

interface OutputItem {
  type: string
  content?: OutputContent[]
}

interface ResponsesPayload {
  output?: OutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

export interface WebResearchRaw {
  text: string
  citations: { url: string; title: string | null }[]
  error?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * One web-grounded call. Returns the synthesized text plus every URL the model
 * actually cited — the citation list is the provenance record.
 */
async function callWebSearch(prompt: string, maxResults: number): Promise<WebResearchRaw> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return { text: '', citations: [], error: 'OPENAI_API_KEY is not set' }
  if (stats.searches >= searchBudget) throw new WebSearchBudgetExceeded(searchBudget)

  stats.searches++

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(Math.round(800 * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5)))

    try {
      const res = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: modelFor('reasoning'),
          tools: [{ type: 'web_search' }],
          input: prompt,
          max_output_tokens: 1200,
        }),
      })

      const text = await res.text()
      if (!res.ok) {
        // 429/5xx are transient; anything else will not succeed on retry.
        if (res.status === 429 || res.status >= 500) continue
        stats.errors++
        return { text: '', citations: [], error: `OpenAI ${res.status}: ${text.slice(0, 200)}` }
      }

      const payload = JSON.parse(text) as ResponsesPayload
      stats.tokens_in += payload.usage?.input_tokens ?? 0
      stats.tokens_out += payload.usage?.output_tokens ?? 0

      const messages = (payload.output ?? []).filter((o) => o.type === 'message')
      const contents = messages.flatMap((m) => m.content ?? []).filter((c) => c.type === 'output_text')

      const body = contents.map((c) => c.text ?? '').join('\n').trim()
      const seen = new Set<string>()
      const citations: { url: string; title: string | null }[] = []
      for (const c of contents) {
        for (const a of c.annotations ?? []) {
          if (a.type !== 'url_citation' || !a.url || seen.has(a.url)) continue
          seen.add(a.url)
          citations.push({ url: a.url, title: a.title ?? null })
          if (citations.length >= maxResults) break
        }
      }

      return { text: body, citations }
    } catch (e) {
      if (attempt === 2) {
        stats.errors++
        return { text: '', citations: [], error: e instanceof Error ? e.message : 'network error' }
      }
    }
  }

  stats.errors++
  return { text: '', citations: [], error: 'exhausted retries' }
}

export class OpenAIWebResearchProvider implements WebResearchProvider {
  readonly id = 'openai_web'
  readonly capabilities = CAPABILITIES

  isAvailable(): boolean {
    return Boolean(process.env.OPENAI_API_KEY)
  }

  async research(query: WebResearchQuery): Promise<ProviderResult<WebFinding>> {
    const raw = await this.researchRaw(query)
    if (raw.error) return { items: [], error: raw.error }

    // Each citation becomes a finding carrying the synthesized text. The
    // research agents do the claim extraction; this layer only guarantees that
    // nothing arrives without a source URL.
    const retrievedAt = new Date().toISOString()
    return {
      items: raw.citations.map((c) => ({
        claim: raw.text,
        source_url: c.url,
        source_title: c.title,
        published_at: null,
        snippet: null,
        provenance: { provider_id: this.id, query_ref: { query: query.query }, retrieved_at: retrievedAt },
      })),
    }
  }

  /** Text + citations, cached. The research agents consume this directly. */
  async researchRaw(query: WebResearchQuery): Promise<WebResearchRaw> {
    if (!this.isAvailable()) return { text: '', citations: [], error: 'OPENAI_API_KEY is not set' }

    const prompt = query.context ? `${query.context}\n\n${query.query}` : query.query
    const key = cacheKey('web_research', { prompt, model: modelFor('reasoning'), max: query.max_results ?? 6 })

    let wasCached = true
    const result = await cached<WebResearchRaw>(key, async () => {
      wasCached = false
      return callWebSearch(prompt, query.max_results ?? 6)
    })

    if (wasCached) stats.cachedSearches++
    return result
  }
}

export const openAIWebResearchProvider = new OpenAIWebResearchProvider()
