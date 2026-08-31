// Raw posting → normalized job. Deterministic classification the Job
// Extractor agent may override, never the other way round.
//
// Title normalization, role family, employment type and season are cheap
// regex work that runs on every posting a board returns — hundreds per
// company. Sending each through a model to learn "Senior Process Engineer is
// not an internship" would cost more than the whole scout.

import { normalizeCompanyName as apolloNormalizeCompanyName, normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { EmploymentType, ExtractedJobFields, GeoTier, JobOpportunity, SeasonRelevance, WorkMode } from '../types'
import type { RawJobPosting } from '../sources/types'
import { locationTier, parseLocation, workModeFromParsed, type TierOptions } from './location'

export { normalizeDomain }

export function normalizeCompanyName(raw: string | null | undefined): string | null {
  return apolloNormalizeCompanyName(raw)
}

/** The JobOpportunity columns the pipeline computes, before the store assigns ids. */
export type NormalizedJob = Omit<
  JobOpportunity,
  'id' | 'user_id' | 'created_at' | 'updated_at' | 'first_seen_at' | 'last_seen_at' | 'company_id' | 'mission_id' | 'discovery_run_id' | 'duplicate_cluster_id'
> & {
  company_id?: string | null
  mission_id?: string | null
  discovery_run_id?: string | null
  duplicate_cluster_id?: string | null
  company_domain: string | null
  /** A stable key for the company: domain, else normalized name. */
  company_key: string
  normalized_title: string
  sources: RawJobPosting[]
}

// ─── Titles ──────────────────────────────────────────────────────────────────

const SEASON_WORDS = '(?:summer|fall|autumn|winter|spring)'
const YEAR = '20\\d\\d'

/** Strip req ids, seasons/years, and trailing "- Intern"-style suffixes into one form. */
export function normalizeTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim()
  t = t.replace(/\(([^)]*)\)/g, (m, inner: string) => (new RegExp(`${SEASON_WORDS}|${YEAR}|intern|co-?op|remote|hybrid|req|id`, 'i').test(inner) ? ' ' : m))
  t = t
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:req(?:uisition)?|job)\s*(?:id|#|no\.?)?\s*[:#]?\s*[A-Z]{0,4}[-_]?\d{3,}\b/gi, ' ')
    .replace(/#\s?\d{3,}\b/g, ' ')
    .replace(/\b[A-Z]{1,4}-?\d{4,}\b/g, ' ')
    .replace(new RegExp(`\\b${SEASON_WORDS}\\s*${YEAR}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b${YEAR}\\s*${SEASON_WORDS}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b${YEAR}\\b`, 'g'), ' ')
    .replace(new RegExp(`\\b${SEASON_WORDS}\\b`, 'gi'), ' ')
    .replace(/\b(?:u\.?s\.?|usa|remote|hybrid|on-?site)\b/gi, ' ')
    .replace(/\s*[-–—|:,/]+\s*(?=[-–—|:,/]|$)/g, ' ')
    .replace(/[-–—|:]\s*intern(?:ship)?\s*$/i, ' Intern')
    .replace(/^\s*intern(?:ship)?\s*[-–—|:,]\s*/i, 'Intern, ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|:,/]+|[\s\-–—|:,/]+$/g, '')
    .trim()
  return t
}

export const ROLE_FAMILIES = [
  'process_engineering', 'manufacturing_operations', 'quality', 'supply_chain', 'mechanical', 'electrical',
  'chemical_engineering', 'materials', 'energy', 'data_ai', 'software', 'product', 'strategy_consulting',
  'business_ops', 'finance', 'research', 'sustainability', 'hardware', 'design', 'marketing', 'sales', 'other',
] as const

const FAMILY_RULES: [string, RegExp][] = [
  ['process_engineering', /\bprocess (?:development |integration |improvement )?engineer|\bprocess (?:development|engineering|integration)\b|\bmanufacturing process\b|\bpilot plant\b|\bprocess technician\b/i],
  ['chemical_engineering', /\bchemical (?:engineer|engineering)\b|\bchem ?e\b|\bformulation\b|\bcatalys/i],
  ['materials', /\bmaterials? (?:science|engineer|engineering|scientist|research)\b|\bmetallurg|\bpolymer\b|\bbattery (?:materials|cell)\b|\bcoatings?\b/i],
  ['quality', /\bquality\b|\bqa\b|\bqc\b|\bregulatory\b|\bcompliance engineer\b|\bvalidation engineer\b/i],
  ['supply_chain', /\bsupply chain\b|\bprocurement\b|\bsourcing\b|\blogistics\b|\bmaterials planning\b|\binventory\b|\bplanner\b/i],
  ['manufacturing_operations', /\bmanufactur\w*\b|\bproduction (?:engineer|supervisor|operations|planning)\b|\boperations engineer\b|\bindustrial engineer|\bplant\b|\bcontinuous improvement\b|\blean\b|\bfacilities\b|\bops engineer\b|\bautomation engineer\b/i],
  ['energy', /\benergy\b|\bpower systems?\b|\bsolar\b|\bwind\b|\bnuclear\b|\boil\b|\bgas\b|\bgrid\b|\brenewable|\bpetroleum\b|\bdrilling\b|\breservoir\b|\bhydrogen\b|\bstorage systems?\b/i],
  ['sustainability', /\bsustainab|\bclimate\b|\bcarbon\b|\bESG\b|\benvironmental\b|\bdecarboni[sz]/i],
  ['strategy_consulting', /\bstrateg|\bconsult|\bcorporate development\b|\bbusiness analyst\b|\bmanagement associate\b|\bchief of staff\b/i],
  ['product', /\bproduct manag|\bproduct (?:owner|analyst|operations|marketing)\b|\bpm intern\b|\bAPM\b|\btechnical program manag|\bprogram manag|\bproject manag/i],
  ['data_ai', /\bdata (?:scien|analy|engineer)|\bmachine learning\b|\bml\b|\bai\b|\bartificial intelligence\b|\banalytics\b|\bresearch scientist\b|\bcomputer vision\b|\bnlp\b|\bdeep learning\b|\bmodeling\b|\bstatistic/i],
  ['software', /\bsoftware\b|\bswe\b|\bdeveloper\b|\bfull[- ]?stack\b|\bfront[- ]?end\b|\bback[- ]?end\b|\bdevops\b|\bsite reliability\b|\bplatform engineer\b|\bfirmware\b|\bembedded\b|\bcloud\b|\bsecurity engineer\b|\bmobile\b|\bandroid\b|\bios\b|\binfrastructure engineer\b|\bforward deployed\b|\bsolutions engineer\b/i],
  ['finance', /\bfinanc|\bfp&a\b|\baccounting\b|\binvestment\b|\btreasury\b|\banalyst, (?:finance|investment)\b|\bequity\b|\bbanking\b|\bventure\b|\bprivate equity\b|\bcapital markets\b/i],
  ['research', /\bresearch\b|\bR&D\b|\bscientist\b|\blaboratory\b|\blab (?:intern|assistant|technician)\b|\bPhD\b/i],
  ['mechanical', /\bmechanical\b|\bmech ?e\b|\bthermal\b|\bstructural\b|\bfluids?\b|\bCAD\b|\bdesign engineer\b|\btest engineer\b|\bpropulsion\b|\baerospace\b|\brobotics\b|\bmechatronic/i],
  ['electrical', /\belectrical\b|\bEE\b|\bpower electronics\b|\bcircuit\b|\bPCB\b|\bRF\b|\bsignal\b|\bcontrols? engineer\b/i],
  ['hardware', /\bhardware\b|\bsystems engineer\b|\bintegration engineer\b|\bsemiconductor\b|\bASIC\b|\bFPGA\b|\bchip\b/i],
  ['business_ops', /\boperations\b|\bbusiness operations\b|\bbizops\b|\bbusiness development\b|\bpartnerships?\b|\bgo-to-market\b|\bgtm\b|\brevenue operations\b|\bcustomer success\b|\bpeople operations\b|\brecruit/i],
  ['design', /\bdesign(?:er)?\b|\bux\b|\bui\b|\bindustrial design\b/i],
  ['marketing', /\bmarketing\b|\bbrand\b|\bcontent\b|\bcommunications?\b|\bgrowth\b|\bsocial media\b/i],
  ['sales', /\bsales\b|\baccount executive\b|\bsdr\b|\bbdr\b|\baccount manag/i],
]

/** Open vocabulary, but the common families map deterministically. Checks title first, then department. */
export function roleFamilyFromTitle(title: string, department?: string | null): string {
  const t = normalizeTitle(title)
  for (const [family, re] of FAMILY_RULES) if (re.test(t)) return family
  if (department) for (const [family, re] of FAMILY_RULES) if (re.test(department)) return family
  return 'other'
}

// ─── Employment type ─────────────────────────────────────────────────────────

const SENIOR_RE = /\b(senior|sr\.?|staff|principal|lead|director|head of|vp|vice president|chief|manager|executive|architect|fellow|distinguished)\b/i
const INTERN_RE = /\b(intern|interns|internship|internships|summer analyst|student (?:worker|associate|engineer|program)|undergraduate|new grad(?:uate)?)\b/i
const COOP_RE = /\bco-?op\b|\bco op\b|\bcooperative education\b/i
/**
 * The hint (a department label, a worker-type field) says INTERNSHIP.
 *
 * `\bintern` was the whole test, and `\b` only guards the LEFT edge: "Internal
 * Communications" and "International Sales" both matched it. Greenhouse's
 * `hintFromMetadata` hands back the department name whenever it contains
 * "intern", so every posting in an "Internal Communications" department was
 * classified `internship` — which is exactly how "Office Management and
 * Internal Communications" reached the founder's inbox as an internship. Both
 * edges are guarded now, and only the words that are actually the type count.
 */
const HINT_INTERN_RE = /\b(intern|interns|internship|internships|co-?op|summer analyst|student (?:worker|associate|engineer|program|intern))\b/i

export function detectEmploymentType(title: string, hint: string | null | undefined, text?: string | null): EmploymentType {
  const t = title ?? ''
  const h = hint ?? ''
  // Seniority in the TITLE wins: "Staff Engineer (mentors interns)" is not an internship.
  const core = t.replace(/\([^)]*\)/g, ' ')
  if (SENIOR_RE.test(core) && !INTERN_RE.test(core) && !COOP_RE.test(core)) return 'full_time'
  if (COOP_RE.test(t) || COOP_RE.test(h)) return 'co_op'
  if (/\bnew grad(?:uate)?\b/i.test(t)) return 'full_time'
  if (INTERN_RE.test(t) || HINT_INTERN_RE.test(h)) return 'internship'
  const hl = h.toLowerCase()
  if (/full[- ]?time|permanent|regular/.test(hl)) return 'full_time'
  if (/part[- ]?time/.test(hl)) return 'part_time'
  if (/contract|temporary|temp\b|fixed[- ]term|freelance/.test(hl)) return 'contract'
  if (SENIOR_RE.test(t)) return 'full_time'
  const head = (text ?? '').slice(0, 1500)
  if (/\bthis (?:is an? |)(?:paid |)internship\b|\bour (?:summer |)internship program\b|\binternship program\b/i.test(head)) return 'internship'
  if (/\b(?:full|part)[- ]time\b/i.test(head)) return /\bpart[- ]time\b/i.test(head) ? 'part_time' : 'full_time'
  return 'unknown'
}

/** The title alone says internship or co-op. Exported so relevance.ts shares one vocabulary. */
export function titleSaysInternship(title: string): boolean {
  return INTERN_RE.test(title) || COOP_RE.test(title)
}

// ─── Season ──────────────────────────────────────────────────────────────────

const TARGET_YEAR = 2027

/**
 * "Computational Physics Intern (Spring 2027)" is a Spring posting even when
 * its body — a template shared with the Summer one — says "Summer 2027". A
 * title that names seasons of the target year and none of them is summer
 * settles the question; the extractor reads the body and is overruled here.
 */
export function titleSaysOtherSeason(title: string): boolean {
  const re = new RegExp(`(?:^|[^a-z])(summer|fall|autumn|winter|spring)(?:\\s*(?:&|and|/|,)\\s*(summer|fall|autumn|winter|spring))*\\s*(?:of\\s*)?['’]?(?:${TARGET_YEAR}|${String(TARGET_YEAR).slice(2)})(?![0-9])`, 'gi')
  let named = false
  let summer = false
  let m: RegExpExecArray | null
  while ((m = re.exec(title))) {
    named = true
    if (/summer/i.test(m[0])) summer = true
  }
  return named && !summer
}

export function detectSeason(title: string, text: string | null | undefined, employmentType?: EmploymentType): SeasonRelevance {
  const corpus = `${title}\n${(text ?? '').slice(0, 6000)}`
  const lower = corpus.toLowerCase()
  const summer2027 = new RegExp(`summer\\s*(?:of\\s*)?['’]?(?:${TARGET_YEAR}|27)\\b|${TARGET_YEAR}\\s*summer|\\b(?:may|june)\\s*${TARGET_YEAR}\\b`).test(lower)
  if (summer2027) return 'summer_2027'
  const otherStated =
    /\b(?:summer|fall|autumn|winter|spring)\s*(?:of\s*)?['’]?(?:20(?:2[0-68-9]|3\d)|2[0-68-9])\b/.test(lower) ||
    /\b(?:fall|autumn|winter|spring)\s*(?:of\s*)?['’]?(?:2027|27)\b/.test(lower) ||
    /\b(?:summer|fall|autumn|winter|spring)\s+20(?:2[0-68-9])\b/.test(lower) ||
    /\b(?:class of|graduating in|graduation (?:date|year) of)\s*20(?:2[0-6])\b/.test(lower)
  if (otherStated) return 'other_season'
  const isIntern = employmentType ? employmentType === 'internship' || employmentType === 'co_op' : INTERN_RE.test(title) || COOP_RE.test(title)
  if (isIntern) return 'unspecified'
  return 'unknown'
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export interface NormalizeOptions {
  geo_tiers?: GeoTier[]
  tier?: TierOptions
}

function workModeFromText(text: string | null | undefined): WorkMode | null {
  const head = (text ?? '').slice(0, 3000).toLowerCase()
  if (/\bhybrid\b/.test(head)) return 'hybrid'
  if (/\bfully remote\b|\bremote[- ]first\b|\bthis (?:role|position) is remote\b/.test(head)) return 'remote'
  if (/\bon-?site\b|\bin[- ]person\b|\bin[- ]office\b/.test(head)) return 'onsite'
  return null
}

export function companyKeyFor(name: string, domain: string | null | undefined): string {
  const d = normalizeDomain(domain)
  if (d) return `d:${d}`
  return `n:${normalizeCompanyName(name) ?? name.trim().toLowerCase()}`
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * The extractor reports a deadline "as written" — "August 2026", "Rolling",
 * "2026-10-15", "Oct 15, 2026". The column is a timestamp, and the first live
 * backfill failed on exactly this: `invalid input syntax for type timestamp
 * with time zone: "August 2026"`. Anything that names a day parses as-is; a
 * month alone is read as its last day (the latest date the text supports);
 * "rolling", "ASAP" and other prose become null — no deadline is not a bug.
 */
export function parseDeadline(text: string | null | undefined): string | null {
  const s = (text ?? '').trim()
  if (!s || s.length > 60) return null
  if (/rolling|asap|until filled|open until|ongoing|n\/a|none/i.test(s)) return null
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 23, 59, 59))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const monthYear = s.match(/^(?:by |before |until |end of |late |early |mid[- ])?([A-Za-z]+)\.?,?\s+(\d{4})$/)
  if (monthYear && MONTHS[monthYear[1].toLowerCase()] !== undefined) {
    const y = Number(monthYear[2])
    const m = MONTHS[monthYear[1].toLowerCase()]
    // Day 0 of the next month is the last day of this one.
    return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59)).toISOString()
  }
  const parsed = Date.parse(s.replace(/^(by|before|until|due)\s+/i, ''))
  if (Number.isNaN(parsed)) return null
  const d = new Date(parsed)
  // A parse that lands before 2000 is a misread ("Fall 2026" → year 2026 only
  // parses on some engines as January 1); refuse anything implausible.
  if (d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2100) return null
  return d.toISOString()
}

export function buildNormalizedJob(raw: RawJobPosting, extracted?: ExtractedJobFields | null, mission?: NormalizeOptions): NormalizedJob {
  const title = raw.title.trim()
  const normalized_title = normalizeTitle(title).toLowerCase()
  const locationRaw = extracted?.location_raw ?? raw.location_raw
  const parsed = parseLocation(locationRaw)
  const heuristicType = detectEmploymentType(title, raw.employment_type_hint, raw.description_text)
  const employment_type = extracted && extracted.employment_type !== 'unknown' ? extracted.employment_type : heuristicType
  const heuristicSeason = detectSeason(title, raw.description_text, employment_type)
  const season_relevance = titleSaysOtherSeason(title) ? 'other_season' : extracted && extracted.season_relevance !== 'unknown' ? extracted.season_relevance : heuristicSeason
  const heuristicMode = parsed.remote || parsed.hybrid ? workModeFromParsed(parsed) : workModeFromText(raw.description_text) ?? workModeFromParsed(parsed)
  const work_mode = extracted && extracted.work_mode !== 'unknown' ? extracted.work_mode : heuristicMode
  const role_family = extracted?.role_family ?? roleFamilyFromTitle(title, raw.department)
  const domain = normalizeDomain(raw.company_domain)

  return {
    company_name: raw.company_name,
    company_domain: domain,
    company_key: companyKeyFor(raw.company_name, domain),
    title,
    normalized_title,
    role_family,
    description_text: raw.description_text,
    description_html: raw.description_html,
    location_raw: locationRaw,
    location_city: parsed.city,
    location_state: parsed.state,
    location_country: parsed.country,
    location_tier: mission?.geo_tiers ? locationTier(parsed, mission.geo_tiers, mission.tier) : null,
    work_mode,
    employment_type,
    season_relevance,
    posted_at: raw.posted_at,
    source_updated_at: raw.updated_at,
    deadline: parseDeadline(extracted?.deadline ?? null),
    canonical_url: raw.canonical_url ?? raw.source_url,
    apply_url: raw.apply_url ?? raw.canonical_url ?? raw.source_url,
    ats_type: raw.ats_type,
    ats_job_id: raw.ats_job_id,
    requisition_id: raw.requisition_id,
    compensation: extracted?.compensation ?? null,
    min_qualifications: extracted?.min_qualifications ?? [],
    preferred_qualifications: extracted?.preferred_qualifications ?? [],
    graduation_eligibility: extracted?.graduation_eligibility ?? null,
    work_authorization: extracted?.work_authorization ?? null,
    skills: extracted?.skills ?? [],
    responsibilities: extracted?.responsibilities ?? [],
    industry: extracted?.industry ?? null,
    company_size_stage: null,
    extraction_version: null,
    extraction_confidence: extracted?.confidence ?? null,
    verification_status: extracted?.appears_closed ? 'CLOSED' : 'UNVERIFIED',
    last_verified_at: null,
    verification_note: extracted?.appears_closed ? 'posting text says the role is closed' : null,
    verification_method: extracted?.appears_closed ? 'extractor' : null,
    confidence: null,
    is_canonical: true,
    fit_overall: null,
    fit_eligibility: null,
    fit_computed_at: null,
    disposition: 'new',
    sources: [raw],
  }
}

