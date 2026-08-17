// Deterministic normalization of an existing contact.
//
// Everything here is free. No model, no network, no cost — which is why it runs
// on all 897 contacts and the classifier runs only on what it cannot answer.
//
// The split matters: 71% of the stored contacts carry an Apollo `seniority`
// value and 29% do not, but 99% carry a job title. Deriving seniority and
// function from the title in code closes that gap for nothing, and leaves the
// model to answer the genuinely interpretive questions (which industry is this
// company in, what would this person be useful FOR).

import { normalizeSeniority, type Seniority } from '@/lib/scouting/seniority'

export type SeniorityBand =
  | 'founder'
  | 'c_suite'
  | 'partner'
  | 'vp'
  | 'head'
  | 'director'
  | 'manager'
  | 'senior_ic'
  | 'ic'
  | 'academic'
  | 'unknown'

export type FunctionArea =
  | 'engineering'
  | 'operations'
  | 'manufacturing'
  | 'rnd'
  | 'data_ai'
  | 'product'
  | 'technology'
  | 'innovation'
  | 'strategy'
  | 'consulting'
  | 'supply_chain'
  | 'quality'
  | 'sustainability'
  | 'commercial'
  | 'finance'
  | 'people'
  | 'legal'
  | 'investing'
  | 'academia'
  | 'general_management'
  | 'unknown'

export type GeoRegion =
  | 'midwest'
  | 'northeast'
  | 'south'
  | 'west'
  | 'us_other'
  | 'international'
  | 'unknown'

export interface NormalizedContact {
  seniorityBand: SeniorityBand
  functionArea: FunctionArea
  geo: { city: string | null; state: string | null; country: string | null; region: GeoRegion }
  companyNorm: string | null
}

// ─── Seniority ───────────────────────────────────────────────────────────────

/**
 * Order matters. "Founder & CEO" is a founder, not a C-suite hire; "VP of
 * Engineering" is a VP, not an engineer. Each pattern is tried in turn and the
 * first hit wins, so the more specific claims are listed first.
 */
const SENIORITY_PATTERNS: { band: SeniorityBand; pattern: RegExp }[] = [
  { band: 'founder', pattern: /\b(founder|co-?founder|founding (partner|engineer|member))\b/i },
  { band: 'founder', pattern: /\bowner\b/i },
  {
    band: 'c_suite',
    pattern: /\b(chief\s+\w+|c[teofimdsp]o\b|cxo|ceo|cto|coo|cfo|cio|cmo|cdo|cso|cpo|chro|president|chairman|chairwoman|chairperson)\b/i,
  },
  { band: 'partner', pattern: /\b(managing partner|general partner|partner|managing director)\b/i },
  { band: 'vp', pattern: /\b(vice[-\s]?president|\bvp\b|\bsvp\b|\bevp\b|\bavp\b)\b/i },
  { band: 'head', pattern: /\b(head of|global head|group head|chief of staff)\b/i },
  { band: 'director', pattern: /\b(director|dir\.)\b/i },
  { band: 'manager', pattern: /\b(manager|mgr\.?|lead|leader|principal|superintendent|supervisor)\b/i },
  { band: 'academic', pattern: /\b(professor|prof\.|lecturer|dean|postdoc|post-doctoral|research fellow)\b/i },
  { band: 'senior_ic', pattern: /\b(senior|sr\.?|staff|distinguished|fellow)\b/i },
  {
    band: 'ic',
    pattern: /\b(engineer|scientist|analyst|specialist|associate|consultant|developer|designer|technician|researcher|intern|student|assistant|coordinator|representative)\b/i,
  },
]

/** Apollo's own band, mapped into ours where the two disagree on vocabulary. */
const APOLLO_BAND: Partial<Record<Seniority, SeniorityBand>> = {
  owner: 'founder',
  founder: 'founder',
  c_suite: 'c_suite',
  partner: 'partner',
  vp: 'vp',
  head: 'head',
  director: 'director',
  manager: 'manager',
  senior: 'senior_ic',
  entry: 'ic',
  intern: 'ic',
}

/**
 * Title first, provider band second.
 *
 * Apollo reports "director" for a "Managing Director" at a bank and for a
 * "Director of Manufacturing" at a plant; the title is the more honest signal
 * and it is present on 99% of the stored rows.
 */
export function seniorityBandFor(title: string | null, apolloSeniority: string | null): SeniorityBand {
  const t = (title ?? '').trim()
  if (t) {
    for (const { band, pattern } of SENIORITY_PATTERNS) {
      if (pattern.test(t)) return band
    }
  }
  const mapped = APOLLO_BAND[normalizeSeniority(apolloSeniority)]
  return mapped ?? 'unknown'
}

/** Roughly: could this person create, sponsor, or credibly refer an opportunity? */
export function isDecisionCapable(band: SeniorityBand): boolean {
  return ['founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'academic'].includes(band)
}

// ─── Function ────────────────────────────────────────────────────────────────

/**
 * ⚠ EVERY STEM HERE ENDS IN `\w*`, AND THAT IS NOT DECORATION.
 *
 * The first version of this table wrote stems as `\b(manufactur|operation|
 * technolog|consult|strateg|sustainab|recruit)\b`. A trailing `\b` after a
 * truncated stem requires a NON-word character next, so `manufactur\b` cannot
 * match "Manufacturing" — the "i" is a word character. Every inflected form
 * silently fell through to `unknown`.
 *
 * Measured on the real database before the fix: "Director of Manufacturing",
 * "VP Operations", "Chief Technology Officer", "Head of Sustainability",
 * "Director of Strategy" and "Technical Recruiter" all classified as `unknown`.
 * The facet counts looked plausible and the function filters were nearly inert.
 *
 * Caught by a unit test asserting that a recruiter is not an engineer.
 */
const FUNCTION_PATTERNS: { area: FunctionArea; pattern: RegExp }[] = [
  { area: 'data_ai', pattern: /\b(a\.?i\.?|artificial intelligence|machine learning|ml|data scien\w*|data engineer\w*|analytic\w*|digital twin)\b/i },
  { area: 'manufacturing', pattern: /\b(manufactur\w*|plant|production|factory|shop floor|fabricat\w*|packing|converting)\b/i },
  { area: 'quality', pattern: /\b(quality|qa|qc|validation|regulatory|compliance engineer|reliabilit\w*)\b/i },
  { area: 'supply_chain', pattern: /\b(supply chain|logistic\w*|procurement|sourcing|planning|s&op|distribution|warehous\w*)\b/i },
  { area: 'rnd', pattern: /\b(r&d|research and development|research|formulation\w*|discovery|scientist\w*|laborator\w*)\b/i },
  { area: 'engineering', pattern: /\b(engineer\w*|process design|process safety|controls|automation|mechanical|chemical|electrical|civil)\b/i },
  { area: 'operations', pattern: /\b(operation\w*|operational\w*|ops|continuous improvement|lean|six sigma|maintenance|ehs|safety)\b/i },
  { area: 'innovation', pattern: /\b(innovation\w*|incubat\w*|venture studio|venture lab|ventures|emerging tech\w*|new business|transformation|digital)\b/i },
  { area: 'sustainability', pattern: /\b(sustainab\w*|decarboni\w*|esg|climate|net[- ]zero|circular)\b/i },
  { area: 'product', pattern: /\b(product manage\w*|product owner|product lead|product marketing|head of product|product)\b/i },
  { area: 'technology', pattern: /\b(software|platform\w*|infrastructure|architect\w*|technolog\w*|technical|it|information systems|security|cloud)\b/i },
  { area: 'consulting', pattern: /\b(consult\w*|advisory|engagement manager|practice lead)\b/i },
  { area: 'investing', pattern: /\b(investor\w*|investment\w*|venture capital|venture partner|private equity|vc|fund|portfolio)\b/i },
  { area: 'strategy', pattern: /\b(strateg\w*|corporate development|corp dev|m&a|business development|partnership\w*)\b/i },
  { area: 'academia', pattern: /\b(professor\w*|lecturer\w*|dean|academic|university|faculty|postdoc\w*)\b/i },
  { area: 'commercial', pattern: /\b(sales|account\w*|revenue|marketing|brand|commercial|communications|customer success|growth)\b/i },
  { area: 'finance', pattern: /\b(finance|financial|accounting|controller|treasur\w*|audit\w*)\b/i },
  { area: 'people', pattern: /\b(human resources|people|talent|recruit\w*|hr|culture|learning and development)\b/i },
  { area: 'legal', pattern: /\b(legal|counsel\w*|attorney\w*|paralegal\w*)\b/i },
  { area: 'general_management', pattern: /\b(general manager|country manager|business unit|p&l|managing director|chief of staff|president)\b/i },
]

/**
 * Functions no adjective can rescue, checked BEFORE the ordered table.
 *
 * "Technical Recruiter" is a recruiter. Without this it lands in `technology`,
 * because `technical` appears in that pattern and `technology` is listed first.
 * lib/scouting/filter.ts learned the same lesson the hard way — its comment
 * records an earlier version where the override term "technical" rescued
 * exactly this title into the funnel.
 */
const HARD_FUNCTION_PATTERNS: { area: FunctionArea; pattern: RegExp }[] = [
  { area: 'people', pattern: /\b(recruit\w*|talent acquisition|human resources|people ops|people operations|hr business partner|campus recruiting)\b/i },
  { area: 'legal', pattern: /\b(general counsel|attorney\w*|paralegal\w*|legal counsel)\b/i },
  { area: 'finance', pattern: /\b(accounting|accounts payable|accounts receivable|payroll|bookkeep\w*|controller|treasurer)\b/i },
]

export function functionAreaFor(title: string | null): FunctionArea {
  const t = (title ?? '').trim()
  if (!t) return 'unknown'
  for (const { area, pattern } of HARD_FUNCTION_PATTERNS) {
    if (pattern.test(t)) return area
  }
  for (const { area, pattern } of FUNCTION_PATTERNS) {
    if (pattern.test(t)) return area
  }
  return 'unknown'
}

// ─── Geography ───────────────────────────────────────────────────────────────

const US_STATES: Record<string, GeoRegion> = {
  illinois: 'midwest', indiana: 'midwest', iowa: 'midwest', kansas: 'midwest', michigan: 'midwest',
  minnesota: 'midwest', missouri: 'midwest', nebraska: 'midwest', 'north dakota': 'midwest',
  ohio: 'midwest', 'south dakota': 'midwest', wisconsin: 'midwest',
  connecticut: 'northeast', maine: 'northeast', massachusetts: 'northeast', 'new hampshire': 'northeast',
  'new jersey': 'northeast', 'new york': 'northeast', pennsylvania: 'northeast', 'rhode island': 'northeast',
  vermont: 'northeast', delaware: 'northeast', maryland: 'northeast', 'district of columbia': 'northeast',
  alabama: 'south', arkansas: 'south', florida: 'south', georgia: 'south', kentucky: 'south',
  louisiana: 'south', mississippi: 'south', 'north carolina': 'south', oklahoma: 'south',
  'south carolina': 'south', tennessee: 'south', texas: 'south', virginia: 'south',
  'west virginia': 'south',
  alaska: 'west', arizona: 'west', california: 'west', colorado: 'west', hawaii: 'west',
  idaho: 'west', montana: 'west', nevada: 'west', 'new mexico': 'west', oregon: 'west',
  utah: 'west', washington: 'west', wyoming: 'west',
}

const US_NAMES = new Set(['united states', 'usa', 'us', 'u.s.', 'u.s.a.', 'america'])

/**
 * Apollo writes "Chicago, Illinois, United States" and sometimes just
 * "United States" or "Greater Chicago Area". Parse right-to-left: the last
 * segment is the country when it looks like one, the segment before it the
 * state, and whatever remains the city.
 */
export function parseLocation(raw: string | null): NormalizedContact['geo'] {
  const empty = { city: null, state: null, country: null, region: 'unknown' as GeoRegion }
  if (!raw?.trim()) return empty

  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return empty

  let city: string | null = null
  let state: string | null = null
  let country: string | null = null

  const last = parts[parts.length - 1]
  if (US_NAMES.has(last.toLowerCase())) {
    country = 'United States'
    if (parts.length >= 2) state = parts[parts.length - 2]
    if (parts.length >= 3) city = parts.slice(0, parts.length - 2).join(', ')
  } else if (parts.length === 1) {
    // A bare token: a state name means US, anything else is a country or a
    // metro description we cannot resolve further.
    if (US_STATES[last.toLowerCase()]) {
      country = 'United States'
      state = last
    } else {
      country = last
    }
  } else {
    country = last
    state = parts[parts.length - 2]
    if (parts.length >= 3) city = parts.slice(0, parts.length - 2).join(', ')
  }

  let region: GeoRegion = 'unknown'
  if (country === 'United States') {
    region = state ? (US_STATES[state.toLowerCase()] ?? 'us_other') : 'us_other'
  } else if (country) {
    region = 'international'
  }

  return { city, state, country, region }
}

// ─── Company ─────────────────────────────────────────────────────────────────

const COMPANY_SUFFIX =
  /\b(inc|inc\.|incorporated|llc|l\.l\.c\.|ltd|limited|corp|corp\.|corporation|co|co\.|company|plc|gmbh|ag|sa|s\.a\.|nv|bv|group|holdings|holding)\b/gi

export function normalizeCompany(name: string | null): string | null {
  if (!name?.trim()) return null
  const cleaned = name
    .toLowerCase()
    .replace(COMPANY_SUFFIX, ' ')
    .replace(/[^a-z0-9&\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || null
}

// ─── Everything at once ──────────────────────────────────────────────────────

export function normalizeContact(input: {
  title: string | null
  seniority: string | null
  location: string | null
  company: string | null
}): NormalizedContact {
  return {
    seniorityBand: seniorityBandFor(input.title, input.seniority),
    functionArea: functionAreaFor(input.title),
    geo: parseLocation(input.location),
    companyNorm: normalizeCompany(input.company),
  }
}
