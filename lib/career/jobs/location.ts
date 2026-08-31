// Location parsing and mission geo-tiers — pure string work, no model.
//
// Job boards write locations a dozen ways: "San Francisco, CA", "Remote - US",
// "Hybrid · Boston, MA", "SF Bay Area", "Multiple locations". Downstream code
// needs city/state/country columns, a work-mode signal, and the mission's tier
// for the place. All of that is table lookups; a model would be slower and
// would occasionally invent a state.

import type { GeoTier } from '../types'

export interface ParsedLocation {
  city: string | null
  state: string | null       // two-letter code when US
  country: string | null     // 'US' when recognizably United States
  remote: boolean
  hybrid: boolean
  multiple: boolean
  /** Every location string found when the raw value lists several. */
  all: string[]
}

export const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}
const STATE_CODES = new Set(Object.values(US_STATES))

export const BAY_AREA_CITIES = [
  'san francisco', 'oakland', 'berkeley', 'palo alto', 'menlo park', 'mountain view', 'sunnyvale', 'san jose',
  'santa clara', 'redwood city', 'south san francisco', 'fremont', 'cupertino', 'san mateo', 'foster city',
  'emeryville', 'hayward', 'milpitas', 'burlingame', 'san carlos', 'alameda', 'walnut creek', 'pleasanton', 'los altos',
]
const BAY_AREA_ALIASES = ['sf bay area', 'bay area', 'san francisco bay area', 'silicon valley', 'sf', 'san francisco']
const NYC_ALIASES = ['new york city', 'new york', 'nyc', 'manhattan', 'brooklyn', 'jersey city', 'long island city', 'queens', 'ny', 'newark', 'hoboken', 'bronx', 'staten island', 'secaucus', 'stamford', 'white plains', 'yonkers']

/** Metro alias table: the metro name the mission writes → cities that count as it. */
export const METRO_ALIASES: Record<string, string[]> = {
  'san francisco': [...BAY_AREA_ALIASES, ...BAY_AREA_CITIES],
  'bay area': [...BAY_AREA_ALIASES, ...BAY_AREA_CITIES],
  'new york': NYC_ALIASES,
  'new york city': NYC_ALIASES,
  // Suburbs are where the plants and labs are: an industrial posting says
  // "Woburn, MA" or "Newark, NJ", never "Boston" or "New York". A metro that
  // only knows its downtown sends those to tier 3 and mis-ranks the job.
  boston: ['boston', 'cambridge', 'somerville', 'waltham', 'burlington', 'watertown', 'woburn', 'bedford', 'lexington', 'billerica', 'devens', 'newton', 'framingham', 'marlborough', 'andover', 'wilmington', 'quincy', 'medford', 'natick', 'needham', 'norwood', 'peabody'],
  seattle: ['seattle', 'bellevue', 'redmond', 'kirkland', 'bothell', 'everett', 'renton', 'kent', 'tukwila', 'issaquah'],
  'los angeles': ['los angeles', 'la', 'santa monica', 'pasadena', 'el segundo', 'culver city', 'irvine', 'playa vista', 'torrance', 'hawthorne', 'long beach', 'vernon', 'burbank', 'glendale', 'gardena', 'carson', 'compton', 'inglewood', 'san pedro', 'redondo beach', 'manhattan beach', 'commerce', 'city of industry', 'anaheim', 'costa mesa', 'fullerton'],
  'washington dc': ['washington', 'washington dc', 'washington, dc', 'dc', 'arlington', 'bethesda', 'reston', 'mclean', 'alexandria', 'tysons', 'herndon', 'chantilly', 'springfield', 'silver spring', 'rockville', 'gaithersburg', 'fairfax', 'vienna'],
  chicago: ['chicago', 'evanston'],
  austin: ['austin'],
  denver: ['denver', 'boulder'],
  'san diego': ['san diego', 'la jolla'],
  houston: ['houston'],
}

/** Cities whose state we can infer when the string omits it. */
const CITY_STATE: Record<string, string> = {
  'san francisco': 'CA', oakland: 'CA', berkeley: 'CA', 'palo alto': 'CA', 'menlo park': 'CA', 'mountain view': 'CA',
  sunnyvale: 'CA', 'san jose': 'CA', 'santa clara': 'CA', 'redwood city': 'CA', 'south san francisco': 'CA', fremont: 'CA',
  cupertino: 'CA', 'san mateo': 'CA', 'foster city': 'CA', emeryville: 'CA', hayward: 'CA', milpitas: 'CA',
  'los angeles': 'CA', 'santa monica': 'CA', pasadena: 'CA', 'el segundo': 'CA', 'culver city': 'CA', irvine: 'CA', 'san diego': 'CA',
  'new york': 'NY', 'new york city': 'NY', nyc: 'NY', manhattan: 'NY', brooklyn: 'NY', 'long island city': 'NY', queens: 'NY',
  'jersey city': 'NJ', boston: 'MA', cambridge: 'MA', somerville: 'MA', seattle: 'WA', bellevue: 'WA', redmond: 'WA', kirkland: 'WA',
  chicago: 'IL', austin: 'TX', houston: 'TX', dallas: 'TX', denver: 'CO', boulder: 'CO', atlanta: 'GA', miami: 'FL',
  washington: 'DC', 'washington dc': 'DC', arlington: 'VA', reston: 'VA', mclean: 'VA', bethesda: 'MD', philadelphia: 'PA',
  pittsburgh: 'PA', detroit: 'MI', minneapolis: 'MN', portland: 'OR', phoenix: 'AZ', 'salt lake city': 'UT', raleigh: 'NC', durham: 'NC',
}

const COUNTRY_ALIASES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', us: 'US', 'u.s.': 'US', 'u.s.a.': 'US',
  canada: 'CA_COUNTRY', 'united kingdom': 'GB', uk: 'GB', england: 'GB', germany: 'DE', france: 'FR', india: 'IN',
  australia: 'AU', singapore: 'SG', japan: 'JP', china: 'CN', ireland: 'IE', netherlands: 'NL', spain: 'ES', italy: 'IT',
  israel: 'IL', mexico: 'MX', brazil: 'BR', switzerland: 'CH', sweden: 'SE', poland: 'PL',
  // "Budapest, Hungary" reached a Summer 2027 US-only ranking (discovery eval
  // run 4) because Hungary was not here: an unrecognized country parses as
  // null, and the "United States" constraint deliberately lets unknown
  // through. The list has to be wide enough that "unknown" means unstated.
  hungary: 'HU', austria: 'AT', belgium: 'BE', denmark: 'DK', norway: 'NO', finland: 'FI', portugal: 'PT', 'czech republic': 'CZ', czechia: 'CZ',
  romania: 'RO', greece: 'GR', turkey: 'TR', türkiye: 'TR', ukraine: 'UA', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB', 'great britain': 'GB',
  'south korea': 'KR', korea: 'KR', taiwan: 'TW', 'hong kong': 'HK', vietnam: 'VN', thailand: 'TH', malaysia: 'MY', indonesia: 'ID', philippines: 'PH',
  'new zealand': 'NZ', 'south africa': 'ZA', nigeria: 'NG', kenya: 'KE', egypt: 'EG', 'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA', qatar: 'QA',
  argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE', 'costa rica': 'CR', luxembourg: 'LU', estonia: 'EE', latvia: 'LV', lithuania: 'LT',
  slovakia: 'SK', slovenia: 'SI', croatia: 'HR', serbia: 'RS', bulgaria: 'BG', pakistan: 'PK', bangladesh: 'BD', 'sri lanka': 'LK', rwanda: 'RW', ghana: 'GH',
}

const NON_US_CITY_HINTS = ['london', 'paris', 'berlin', 'toronto', 'vancouver', 'montreal', 'dublin', 'amsterdam', 'bangalore', 'bengaluru', 'tokyo', 'sydney', 'singapore', 'tel aviv', 'munich', 'zurich', 'stockholm', 'madrid', 'barcelona', 'hyderabad', 'mumbai', 'shanghai', 'beijing', 'warsaw', 'montreuil', 'lisbon', 'budapest', 'prague', 'vienna', 'copenhagen', 'oslo', 'helsinki', 'melbourne', 'seoul', 'taipei', 'hong kong', 'kigali', 'accra', 'lagos', 'nairobi', 'mexico city', 'são paulo', 'sao paulo', 'buenos aires', 'ottawa', 'calgary', 'waterloo', 'cambridge, uk', 'manchester', 'edinburgh', 'oxford', 'pune', 'chennai', 'delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida']

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Parse ONE location phrase (no separators for multiple sites). */
function parseSingle(raw: string): Omit<ParsedLocation, 'multiple' | 'all'> {
  let s = clean(raw)
  const lower0 = s.toLowerCase()
  const remote = /\b(remote|work from home|wfh|distributed|anywhere)\b/.test(lower0)
  const hybrid = /\bhybrid\b/.test(lower0)
  s = s
    .replace(/\b(remote|hybrid|on-?site|in-?office|work from home|wfh|distributed|anywhere|hq|headquarters|office|or)\b/gi, ' ')
    .replace(/[-–—·|/]+/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s+/g, ' ')
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)

  let city: string | null = null
  let state: string | null = null
  let country: string | null = null

  const rest: string[] = []
  const isStateToken = (p: string | undefined): boolean => {
    const l = (p ?? '').toLowerCase().replace(/\.$/, '')
    return !!US_STATES[l] || (/^[a-z]{2}$/.test(l) && STATE_CODES.has(l.toUpperCase()))
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const lower = part.toLowerCase().replace(/\.$/, '')
    if (COUNTRY_ALIASES[lower]) {
      country = COUNTRY_ALIASES[lower]
      continue
    }
    // "New York, NY" / "Washington, DC": a state name in city position followed by a state is the city.
    if (US_STATES[lower] && !(i === 0 && CITY_STATE[lower] && isStateToken(parts[i + 1]))) {
      state = US_STATES[lower]
      continue
    }
    if (/^[a-z]{2}$/.test(lower) && STATE_CODES.has(lower.toUpperCase()) && !['sf'].includes(lower)) {
      // "NY" alone means the city when nothing else is given; handled below.
      state = lower.toUpperCase()
      continue
    }
    // "CA 94103" / "Cambridge MA"
    const tail = /^(.*?)\s+([A-Za-z]{2})(?:\s+\d{5})?$/.exec(part)
    if (tail && STATE_CODES.has(tail[2].toUpperCase()) && !US_STATES[lower]) {
      rest.push(tail[1])
      state = tail[2].toUpperCase()
      continue
    }
    rest.push(part)
  }

  const cityish = rest.map((r) => r.toLowerCase()).find((r) => r && !/^\d+$/.test(r))
  if (cityish) {
    // Alias collapse: metros, NYC boroughs, "SF".
    if (BAY_AREA_ALIASES.includes(cityish)) city = cityish === 'sf' || cityish === 'san francisco' ? 'San Francisco' : 'San Francisco Bay Area'
    else if (['nyc', 'new york city', 'new york'].includes(cityish)) city = 'New York'
    else city = titleCase(cityish)
    const key = cityish === 'sf' ? 'san francisco' : cityish
    if (!state && CITY_STATE[key]) state = CITY_STATE[key]
    if (city === 'San Francisco Bay Area' && !state) state = 'CA'
  } else if (state === 'NY' && parts.length === 1) {
    city = 'New York'
  } else if (state === 'DC') {
    city = 'Washington'
  }

  if (!country) {
    if (state) country = 'US'
    else if (city && NON_US_CITY_HINTS.includes(city.toLowerCase())) country = null
    else if (remote && /\b(us|usa|u\.s\.|united states)\b/.test(lower0)) country = 'US'
  }
  if (country === 'CA_COUNTRY') country = 'CA'
  if (city && NON_US_CITY_HINTS.includes(city.toLowerCase()) && country === 'US') country = null

  return { city, state, country, remote, hybrid }
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function parseLocation(raw: string | null | undefined): ParsedLocation {
  const empty: ParsedLocation = { city: null, state: null, country: null, remote: false, hybrid: false, multiple: false, all: [] }
  if (!raw || !raw.trim()) return empty
  const text = clean(raw)
  const lower = text.toLowerCase()
  if (/\b(multiple|various|several) (locations|cities|offices)\b/.test(lower) || lower === 'multiple' || lower === 'various') {
    const remote = /\bremote\b/.test(lower)
    return { ...empty, remote, multiple: true, all: [text], country: /\b(us|usa|united states)\b/.test(lower) ? 'US' : null }
  }

  // Multi-site strings: "A; B", "A | B", "A or B", or comma lists with ≥2 known cities.
  let sites = text.split(/\s*(?:;|\|| \/ |\bor\b)\s*/).map((s) => s.trim()).filter(Boolean)
  if (sites.length === 1) {
    const commaParts = text.split(',').map((s) => s.trim().toLowerCase())
    const knownCities = commaParts.filter((p) => CITY_STATE[p] || BAY_AREA_CITIES.includes(p) || NON_US_CITY_HINTS.includes(p))
    if (knownCities.length >= 2 && commaParts.length === knownCities.length) sites = text.split(',').map((s) => s.trim())
  }

  if (sites.length > 1) {
    const parsed = sites.map(parseSingle)
    const first = parsed.find((p) => p.city) ?? parsed[0]
    return {
      city: first.city,
      state: first.state,
      country: parsed.every((p) => p.country === 'US' || p.country === null) && parsed.some((p) => p.country === 'US') ? 'US' : first.country,
      remote: parsed.some((p) => p.remote),
      hybrid: parsed.some((p) => p.hybrid),
      multiple: true,
      all: sites,
    }
  }

  const one = parseSingle(text)
  return { ...one, multiple: false, all: [text] }
}

export function workModeFromParsed(p: ParsedLocation): 'remote' | 'hybrid' | 'onsite' | 'unknown' {
  if (p.hybrid) return 'hybrid'
  if (p.remote) return 'remote'
  if (p.city) return 'onsite'
  return 'unknown'
}

// ─── Tiers ───────────────────────────────────────────────────────────────────

function aliasesFor(missionLocation: string): string[] {
  const out = new Set<string>()
  // "San Francisco / Bay Area" → both halves
  for (const piece of missionLocation.toLowerCase().split(/\s*[\/,]\s*/)) {
    const p = piece.trim()
    if (!p) continue
    out.add(p)
    for (const alias of METRO_ALIASES[p] ?? []) out.add(alias)
  }
  return [...out]
}

/** "Newark, NJ (Greater New York City area)" names its metro in the parenthetical; keep that name as a candidate. */
export function metroHints(raw: string): string[] {
  const out: string[] = []
  const re = /\b(?:greater\s+)?([a-z][a-z .]*?)\s+(?:metro(?:politan)?\s+)?(?:area|region)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw.toLowerCase()))) out.push(m[1].replace(/^(?:the|in|near)\s+/, '').trim())
  return out
}

function placeMatches(parsed: ParsedLocation, aliases: string[]): boolean {
  const candidates = new Set<string>()
  if (parsed.city) candidates.add(parsed.city.toLowerCase())
  for (const site of parsed.all) {
    const p = parseSingle(site)
    if (p.city) candidates.add(p.city.toLowerCase())
    candidates.add(site.toLowerCase())
    for (const h of metroHints(site)) candidates.add(h)
  }
  for (const c of candidates) {
    if (aliases.includes(c)) return true
    if (c === 'san francisco bay area' && aliases.includes('bay area')) return true
    if (c === 'washington' && aliases.includes('washington dc') && parsed.state === 'DC') return true
  }
  return false
}

export interface TierOptions {
  /** Where remote-US roles land. Default 2 — remote is fine but not the first choice. */
  remoteUsTier?: 1 | 2 | 3 | null
}

/**
 * 1 | 2 | 3 | null against the mission's geo tiers. Tier 3 is "anywhere else in
 * the US"; null is outside the US or unparseable — the fit evaluator handles
 * those, not this table.
 */
export function locationTier(parsed: ParsedLocation, geoTiers: GeoTier[], opts: TierOptions = {}): 1 | 2 | 3 | null {
  // NO TIER TABLE MEANS NO TIER. Since migration 017 the shipped mission states
  // no place preference, so `geo_tiers` is normally empty — and the old code
  // still walked to the bottom of this function and stamped every US posting
  // tier 3. That number is not neutral: it reaches ranking as a geography
  // penalty and reaches the fit evaluator as "(mission geography tier 3)",
  // reintroducing the exact preference the mission just said it does not have.
  // A posting scored against nothing has no tier, and says so.
  if (!geoTiers.length) return null
  const sorted = [...geoTiers].sort((a, b) => a.tier - b.tier)
  for (const tier of sorted) {
    const aliases = tier.locations.flatMap(aliasesFor)
    if (placeMatches(parsed, aliases)) return tier.tier
  }
  if (parsed.remote && !parsed.city) {
    return parsed.country === 'US' ? opts.remoteUsTier === undefined ? 2 : opts.remoteUsTier : null
  }
  if (parsed.country === 'US' && (parsed.city || parsed.state)) return 3
  return null
}
