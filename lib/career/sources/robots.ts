// robots.txt — fetched once per origin per day, honoured for every page fetch.
//
// The careers-page fetcher reads public pages on behalf of one person. The
// bargain that makes that acceptable is that it behaves like a well-mannered
// crawler: it identifies itself, it reads robots.txt, and it does not argue
// with it. A robots fetch that fails is treated as "allowed" — an unreachable
// robots.txt is not a prohibition, and most sites simply have none.

import { cached, cacheKey } from '@/lib/providers/cache'
import { ambientTimeoutMs as boundedTimeoutMs } from '@/lib/runs/context'

export const CAREER_BOT_USER_AGENT =
  'OutreachOS-CareerBot/1.0 (personal job search; contact via linkedin.com/in/zuyu-liu-58b2b2241)'

/** The token robots.txt authors would match us on. */
const OUR_UA_TOKEN = 'outreachos-careerbot'

export interface RobotsRules {
  origin: string
  /** Disallow path prefixes that apply to us ("" entries are ignored — they allow everything). */
  disallow: string[]
  allow: string[]
  fetched: boolean
  crawlDelayMs: number | null
}

/** Parse the groups that apply to us: our own UA token first, else `*`. */
export function parseRobots(text: string, origin: string): RobotsRules {
  const groups: { agents: string[]; disallow: string[]; allow: string[]; crawlDelay: number | null }[] = []
  let current: (typeof groups)[number] | null = null
  let lastWasAgent = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [], crawlDelay: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current) continue
    if (field === 'disallow') current.disallow.push(value)
    else if (field === 'allow') current.allow.push(value)
    else if (field === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n)) current.crawlDelay = n
    }
  }

  const ours = groups.filter((g) => g.agents.some((a) => a.includes(OUR_UA_TOKEN)))
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'))
  return {
    origin,
    disallow: chosen.flatMap((g) => g.disallow).filter((p) => p.length > 0),
    allow: chosen.flatMap((g) => g.allow).filter((p) => p.length > 0),
    fetched: true,
    crawlDelayMs: chosen.map((g) => g.crawlDelay).find((d): d is number => d !== null) != null
      ? Math.min(10_000, (chosen.map((g) => g.crawlDelay).find((d): d is number => d !== null) as number) * 1000)
      : null,
  }
}

/** Longest-match semantics: a more specific Allow beats a shorter Disallow. `$` and `*` are supported. */
export function isPathAllowed(rules: RobotsRules, pathname: string): boolean {
  const best = (patterns: string[]): number =>
    patterns.reduce((max, p) => (matchesPattern(p, pathname) ? Math.max(max, p.length) : max), -1)
  const dis = best(rules.disallow)
  if (dis < 0) return true
  const allow = best(rules.allow)
  return allow >= dis
}

function matchesPattern(pattern: string, path: string): boolean {
  if (!pattern.includes('*') && !pattern.endsWith('$')) return path.startsWith(pattern)
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$')
  )
  return re.test(path)
}

const memory = new Map<string, RobotsRules>()

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function getRobotsRules(origin: string, opts: { timeoutMs?: number; bypassCache?: boolean } = {}): Promise<RobotsRules> {
  const hit = memory.get(origin)
  if (hit && !opts.bypassCache) return hit

  const rules = await cached<RobotsRules>(
    cacheKey('robots', { origin, day: utcDay() }),
    async () => {
      // Sized from the ambient run's clock, like every other request; a robots
      // lookup that begins inside the run's reserve is not made at all.
      const timeoutMs = boundedTimeoutMs(opts.timeoutMs ?? 8000)
      if (timeoutMs === 0) return { origin, disallow: [], allow: [], fetched: false, crawlDelayMs: null }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(`${origin}/robots.txt`, {
          headers: { 'User-Agent': CAREER_BOT_USER_AGENT, Accept: 'text/plain,*/*;q=0.5' },
          signal: controller.signal,
          redirect: 'follow',
        })
        if (res.status >= 400) return { origin, disallow: [], allow: [], fetched: true, crawlDelayMs: null }
        const text = (await res.text()).slice(0, 200_000)
        return parseRobots(text, origin)
      } catch {
        return { origin, disallow: [], allow: [], fetched: false, crawlDelayMs: null }
      } finally {
        clearTimeout(timer)
      }
    },
    opts.bypassCache ?? false,
    (r) => r.fetched
  )
  memory.set(origin, rules)
  return rules
}

/** Test seam: preload rules for an origin without network. */
export function primeRobots(origin: string, rules: RobotsRules): void {
  memory.set(origin, rules)
}
