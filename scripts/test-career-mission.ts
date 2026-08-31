// Offline checks for mission neutrality: geography stopped being a built-in
// preference, and direction became a dial.
//
//   npx tsx scripts/test-career-mission.ts
//
// No network, no keys, no database. Everything here is a pure function — the
// shipped default, the sanitizers, the three location behaviours, the rendered
// mission text every agent reads, and the predicate migration 017 keys on.
//
// What is being defended: the product used to ship San Francisco and New York
// as tier-1 geography and four coastal cities as tier 2, and print them into
// every prompt, while the founder's own stated direction read "I don't care
// about location or which company". If any assertion below starts failing
// because a city crept back into a default, that is the bug, not the test.

import {
  DEFAULT_MISSION_PREFERENCES,
  NEUTRAL_DEFAULT_OBJECTIVE,
  PRE_V2_DEFAULT_GEO_TIERS,
  PRE_V2_DEFAULT_OBJECTIVE,
  defaultMission,
  isShippedPreV2Geography,
  isShippedPreV2Objective,
  missionPatchError,
  renderMission,
  sanitizeLocations,
  sanitizeMissionPatch,
  sanitizePreferences,
} from '../lib/career/missions/store'
import {
  DEFAULT_LOCATION_PREFERENCE,
  geoTiersForLocations,
  locationHardFilter,
  missionDirectionMode,
  missionLocations,
  rankingGeoTiers,
  type CareerMission,
  type CareerMissionPreferences,
} from '../lib/career/types'
import { withoutPlacePreferences } from '../lib/career/missions/preferences'
import {
  DIRECTION_MODE_OPTIONS,
  LOCATION_EMPTY_WARNING,
  LOCATION_MODE_OPTIONS,
  directionDialDirty,
  directionModeFor,
  directionPatch,
  locationChoiceIncomplete,
  locationsPatch,
  scoutingLine,
} from '../app/dashboard/jobs/direction'
import { jobMissionPlannerPrompt } from '../lib/agents/job-mission-planner/prompt'
import { fitEvaluatorPrompt } from '../lib/agents/fit-evaluator/prompt'
import { evidenceMatcherPrompt } from '../lib/agents/evidence-matcher/prompt'
import { readFileSync } from 'fs'
import { join } from 'path'

/** Run from the repo root, like every other `npx tsx scripts/test-career-*.ts`. */
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Every city and coastal phrase that used to be shipped, plus the ones nobody should add. */
const BANNED = [
  'San Francisco',
  'Bay Area',
  'New York',
  'NYC',
  'Boston',
  'Seattle',
  'Los Angeles',
  'Washington DC',
  'coastal',
  'vibrant',
]

function bannedIn(text: string): string[] {
  return BANNED.filter((b) => text.toLowerCase().includes(b.toLowerCase()))
}

const MISSION = (over: Partial<CareerMissionPreferences> = {}): Pick<CareerMission, 'objective' | 'season' | 'preferences' | 'hard_constraints'> => ({
  objective: NEUTRAL_DEFAULT_OBJECTIVE,
  season: 'summer_2027',
  preferences: { ...DEFAULT_MISSION_PREFERENCES, ...over },
  hard_constraints: [],
})

// ─── 1. The shipped default states no place preference ──────────────────────

console.log('shipped default')
{
  const p = DEFAULT_MISSION_PREFERENCES
  check('geo_tiers ships empty — no city, no tier', Array.isArray(p.geo_tiers) && p.geo_tiers.length === 0, JSON.stringify(p.geo_tiers))
  check("locations ships as 'anywhere' with no region", p.locations?.mode === 'anywhere' && p.locations.regions.length === 0, JSON.stringify(p.locations))
  check('direction ships null', p.direction === null)
  // A stored 'off' would survive every `{ ...defaults, direction }` spread, so
  // the Jobs page could save a direction that then did nothing at all.
  check('direction_mode is NOT shipped — it is derived, so a saved direction always applies', !('direction_mode' in p))
  check('spreading a direction over the shipped default gives boost, not off', missionDirectionMode({ ...p, direction: 'genomics' }) === 'boost')

  const serialized = JSON.stringify(p)
  check('the whole default preferences object names no city and no coastal language', bannedIn(serialized).length === 0, bannedIn(serialized).join(', '))

  const m = defaultMission('user-1')
  check('the default objective names no city', bannedIn(m.objective).length === 0, bannedIn(m.objective).join(', '))
  check('the default objective says anywhere in the US', /anywhere in the United States/i.test(m.objective), m.objective)
  check('the default objective is NOT the pre-V2 one', m.objective !== PRE_V2_DEFAULT_OBJECTIVE)
  check('the default mission still seeds hard constraints (US, internships, season)', m.hard_constraints.length === 3)
}

// ─── 2. Three location behaviours, named, never conflated ───────────────────

console.log('locations: anywhere | prefer | only')
{
  const anywhere = missionLocations({ locations: { mode: 'anywhere', regions: [] }, geo_tiers: [] })
  const prefer: CareerMissionPreferences['locations'] = { mode: 'prefer', regions: ['Houston', 'the Midwest'] }
  const only: CareerMissionPreferences['locations'] = { mode: 'only', regions: ['Houston'] }

  check("'anywhere' is the resolved default", anywhere.mode === 'anywhere' && anywhere.regions.length === 0)
  check("'anywhere' does NOT filter", locationHardFilter({ locations: { mode: 'anywhere', regions: [] }, geo_tiers: [] }) === null)
  check("'prefer' does NOT filter — it is a ranking signal only", locationHardFilter({ locations: prefer, geo_tiers: [] }) === null)
  check("'only' DOES filter, and returns exactly its regions", JSON.stringify(locationHardFilter({ locations: only, geo_tiers: [] })) === '["Houston"]')

  check("'prefer' still ranks: it produces tier-1 ranking geography", JSON.stringify(rankingGeoTiers({ locations: prefer, geo_tiers: [] })) === JSON.stringify([{ tier: 1, locations: ['Houston', 'the Midwest'] }]))
  check("'anywhere' produces NO ranking geography (nothing to rank on)", rankingGeoTiers({ locations: { mode: 'anywhere', regions: [] }, geo_tiers: [] }).length === 0)
  check('authored geo_tiers win over a derived dial', rankingGeoTiers({ locations: prefer, geo_tiers: [{ tier: 1, locations: ['Detroit'] }] })[0].locations[0] === 'Detroit')

  check("geoTiersForLocations('anywhere') is empty", geoTiersForLocations({ mode: 'anywhere', regions: ['ignored'] }).length === 0)
  check("geoTiersForLocations('only') still only ranks — the filter lives in locationHardFilter", JSON.stringify(geoTiersForLocations(only)) === JSON.stringify([{ tier: 1, locations: ['Houston'] }]))

  // A dial pointed at nowhere is not a filter that rejects everything.
  check("'only' with no region resolves to 'anywhere', never to a filter that rejects every job", missionLocations({ locations: { mode: 'only', regions: [] }, geo_tiers: [] }).mode === 'anywhere')
  check("'only' with no region hard-filters nothing", locationHardFilter({ locations: { mode: 'only', regions: [] }, geo_tiers: [] }) === null)

  // A pre-017 row has no `locations` key at all.
  const legacy = missionLocations({ locations: undefined, geo_tiers: PRE_V2_DEFAULT_GEO_TIERS })
  check("a pre-017 row's tiers read back as 'prefer' — a ranking signal, never a filter", legacy.mode === 'prefer' && legacy.regions.includes('New York City'))
  check('a pre-017 row is never read as a hard filter', locationHardFilter({ locations: undefined, geo_tiers: PRE_V2_DEFAULT_GEO_TIERS }) === null)
  check("a pre-017 row with no tiers reads back as 'anywhere'", missionLocations({ locations: undefined, geo_tiers: [] }).mode === 'anywhere')
}

console.log('sanitizeLocations / sanitizePreferences')
{
  check('a valid dial survives', JSON.stringify(sanitizeLocations({ mode: 'prefer', regions: [' Houston ', ''] })) === JSON.stringify({ mode: 'prefer', regions: ['Houston'] }))
  check('an unknown mode is not a dial', sanitizeLocations({ mode: 'nearby', regions: ['x'] }) === null)
  check('a non-object is not a dial', sanitizeLocations('anywhere') === null && sanitizeLocations(null) === null && sanitizeLocations(['only']) === null)
  check('regionless prefer/only collapse to the neutral default', JSON.stringify(sanitizeLocations({ mode: 'only', regions: [] })) === JSON.stringify(DEFAULT_LOCATION_PREFERENCE))

  const p = sanitizePreferences({ locations: { mode: 'only', regions: ['Houston'] } })
  check('a dial with no authored tiers derives the ranking tiers, so the two never disagree', JSON.stringify(p.geo_tiers) === JSON.stringify([{ tier: 1, locations: ['Houston'] }]))
  check('the dial is stored as given', p.locations?.mode === 'only')

  const legacy = sanitizePreferences({ geo_tiers: PRE_V2_DEFAULT_GEO_TIERS })
  check('preferences with tiers but no dial keep their tiers untouched', JSON.stringify(legacy.geo_tiers) === JSON.stringify(PRE_V2_DEFAULT_GEO_TIERS))
  check("…and derive 'prefer', never 'only'", legacy.locations?.mode === 'prefer')

  check('empty preferences fall back to the neutral shipped geography', sanitizePreferences({}).geo_tiers.length === 0 && sanitizePreferences({}).locations?.mode === 'anywhere')

  // The WRITE-side half of the "no stale city can score" guarantee. Ranking code
  // reads the TABLE (normalize stamps location_tier from it), so a dial pointed
  // at 'anywhere' has to clear it on the way in, not only suppress it on the way
  // out. rankingGeoTiers() is the read-side half; both are needed.
  const cleared = sanitizePreferences({ locations: { mode: 'anywhere', regions: [] }, geo_tiers: PRE_V2_DEFAULT_GEO_TIERS })
  check("saving 'anywhere' clears a stale tier table outright", cleared.geo_tiers.length === 0, JSON.stringify(cleared.geo_tiers))
  check('…and nothing that survives the save names a city', bannedIn(JSON.stringify(cleared)).length === 0, bannedIn(JSON.stringify(cleared)).join(', '))
}

// ─── 3. Direction is a mode ─────────────────────────────────────────────────

console.log('direction modes')
{
  check('no direction → off', missionDirectionMode({ direction: null }) === 'off')
  check('blank direction → off', missionDirectionMode({ direction: '   ' }) === 'off')
  check('a direction with no mode → boost (the default)', missionDirectionMode({ direction: 'genomics' }) === 'boost')
  check('a stated boost stays boost', missionDirectionMode({ direction: 'genomics', direction_mode: 'boost' }) === 'boost')
  check('a stated exclusive stays exclusive', missionDirectionMode({ direction: 'genomics', direction_mode: 'exclusive' }) === 'exclusive')
  check('a mode without a direction to apply it to is off', missionDirectionMode({ direction: '', direction_mode: 'exclusive' }) === 'off')
  check('an unknown mode falls back to boost, never to exclusive', missionDirectionMode({ direction: 'x', direction_mode: 'strict' as never }) === 'boost')

  const p = sanitizePreferences({ direction: 'genomics research', direction_mode: 'exclusive' })
  check('sanitizePreferences keeps a chosen exclusive', p.direction_mode === 'exclusive')
  check('sanitizePreferences defaults a direction with no mode to boost', sanitizePreferences({ direction: 'genomics research' }).direction_mode === 'boost')
  check('sanitizePreferences omits direction_mode when there is no direction', !('direction_mode' in sanitizePreferences({ direction_mode: 'exclusive' })))
  check('sanitizePreferences drops a malformed mode back to boost', sanitizePreferences({ direction: 'x', direction_mode: 'nope' as never }).direction_mode === 'boost')
}

// ─── 4. renderMission — the text every agent actually reads ─────────────────

console.log('renderMission')
{
  const none = renderMission(MISSION())
  check('with no direction it says explore broadly from the evidence', /none stated — explore broadly from the evidence/i.test(none), none.split('\n')[0])
  check('the no-direction line is FIRST — an agent reads it before anything else', none.split('\n')[0].startsWith('DIRECTION: none stated'))
  check('with no direction it names no city and no coastal language', bannedIn(none).length === 0, bannedIn(none).join(', '))
  check('it states the location behaviour explicitly', /LOCATIONS: ANYWHERE in the United States — no place preference/.test(none))
  check('it tells the planner not to put a city in a query', /Do not put a city in a query/i.test(none))
  check('no GEOGRAPHY tier line is printed when there is nothing to rank on', !none.includes('GEOGRAPHY RANKING TIER'))
  check('company types are NOT demoted when no direction is set', none.includes('COMPANY TYPES: high-quality startups'))

  const boost = renderMission(MISSION({ direction: 'chemical engineering internships', direction_mode: 'boost' }))
  const exclusive = renderMission(MISSION({ direction: 'chemical engineering internships', direction_mode: 'exclusive' }))
  check('boost and exclusive render DIFFERENTLY', boost !== exclusive)
  check('boost says search hardest here AND keep strong adjacent postings', /DIRECTION — BOOST \(search hardest here, and still take strong adjacent postings\)/.test(boost), boost.split('\n')[0])
  check('exclusive says restrict discovery and ranking to it', /DIRECTION — ONLY THIS \(restrict discovery and ranking to it/.test(exclusive), exclusive.split('\n')[0])
  check('both put the direction first', boost.split('\n')[0].includes('chemical engineering internships') && exclusive.split('\n')[0].includes('chemical engineering internships'))
  check('a direction demotes the default company types to examples', boost.includes('COMPANY TYPES (default examples'))
  check("direction text with mode 'off' renders as the broad, no-direction plan", renderMission(MISSION({ direction: 'genomics', direction_mode: 'off' })).split('\n')[0].startsWith('DIRECTION: none stated'))

  const prefer = renderMission(MISSION({ locations: { mode: 'prefer', regions: ['Houston'] }, geo_tiers: [{ tier: 1, locations: ['Houston'] }] }))
  check("'prefer' is rendered as a RANKING signal and says so", /LOCATIONS — PREFERRED \(a RANKING signal only, never a filter\): Houston/.test(prefer))
  check("'prefer' explicitly keeps everywhere else in scope", /still in scope and still worth surfacing/.test(prefer))
  check("'prefer' prints its ranking tier as a SOFT signal", prefer.includes('GEOGRAPHY RANKING TIER 1 (soft signal): Houston'))

  const only = renderMission(MISSION({ locations: { mode: 'only', regions: ['Houston'] }, geo_tiers: [{ tier: 1, locations: ['Houston'] }] }))
  check("'only' is rendered as a HARD FILTER and says so", /LOCATIONS — ONLY THESE \(a HARD FILTER, already applied in code; a role outside them is out of scope\): Houston/.test(only))
  check("'prefer' and 'only' render differently", prefer !== only)

  // The bug this whole workstream exists to kill: a stale tier table reasserting
  // coastal cities in the prompt even after the user said "anywhere".
  const stale = renderMission(MISSION({ locations: { mode: 'anywhere', regions: [] }, geo_tiers: PRE_V2_DEFAULT_GEO_TIERS }))
  check("'anywhere' suppresses a stale tier table entirely", !stale.includes('GEOGRAPHY RANKING TIER') && bannedIn(stale).length === 0, bannedIn(stale).join(', '))
}

// ─── 5. The migration predicate: exact match, or hands off ───────────────────

console.log('migration 017 predicate')
{
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

  check('the exact shipped pre-V2 geography matches', isShippedPreV2Geography(clone(PRE_V2_DEFAULT_GEO_TIERS)))

  const edited = clone(PRE_V2_DEFAULT_GEO_TIERS)
  edited[0].locations.push('Houston')
  check('ONE added city → no match, the row is left alone', !isShippedPreV2Geography(edited))

  const removed = clone(PRE_V2_DEFAULT_GEO_TIERS)
  removed[1].locations = ['Boston', 'Seattle', 'Los Angeles']
  check('ONE removed city → no match', !isShippedPreV2Geography(removed))

  const reordered = clone(PRE_V2_DEFAULT_GEO_TIERS)
  reordered[0].locations = ['New York City', 'San Francisco / Bay Area']
  check('the same cities in a different ORDER → no match (order is a choice too)', !isShippedPreV2Geography(reordered))

  const redescribed = clone(PRE_V2_DEFAULT_GEO_TIERS)
  redescribed[1].description = 'other large cities'
  check('an edited tier-2 description → no match', !isShippedPreV2Geography(redescribed))

  const extraTier = clone(PRE_V2_DEFAULT_GEO_TIERS)
  extraTier.push({ tier: 3, locations: ['Anywhere else'] })
  check('an added tier 3 → no match', !isShippedPreV2Geography(extraTier))

  const extraKey = clone(PRE_V2_DEFAULT_GEO_TIERS) as unknown as Record<string, unknown>[]
  extraKey[0].description = 'my favourites'
  check('an added key on a tier → no match', !isShippedPreV2Geography(extraKey))

  check('empty tiers (already migrated) → no match, so re-running changes nothing', !isShippedPreV2Geography([]))
  check('a non-array → no match', !isShippedPreV2Geography(null) && !isShippedPreV2Geography(undefined) && !isShippedPreV2Geography({ tier: 1 }))
  check('null inside the array → no match', !isShippedPreV2Geography([null, PRE_V2_DEFAULT_GEO_TIERS[1]]))

  check('the exact shipped pre-V2 objective matches', isShippedPreV2Objective(PRE_V2_DEFAULT_OBJECTIVE))
  check('a one-character edit to the objective → no match', !isShippedPreV2Objective(`${PRE_V2_DEFAULT_OBJECTIVE} `))
  check('the new neutral objective → no match, so re-running changes nothing', !isShippedPreV2Objective(NEUTRAL_DEFAULT_OBJECTIVE))

  check('a structural clone still matches — the predicate compares values, not identity', isShippedPreV2Geography(clone(PRE_V2_DEFAULT_GEO_TIERS)))
}

// ─── 5b. The SQL predicate and its TypeScript twin cannot drift ─────────────
//
// `isShippedPreV2Geography()` and the `where` clause in 017 are the same test
// written twice, in two languages, and only one of them ever runs against the
// founder's database. So the literal is read OUT of the SQL and fed to the
// TypeScript predicate: if somebody edits one and not the other, this fails.

console.log('migration 017 SQL ↔ TypeScript')
{
  const sql = read('supabase/migrations/017_mission_neutrality.sql')

  const geoLiteral = sql.match(/where preferences -> 'geo_tiers' = '([\s\S]*?)'::jsonb/)
  check('017 carries a geo_tiers predicate literal', !!geoLiteral)
  if (geoLiteral) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(geoLiteral[1])
    } catch (e) {
      check('the SQL geography literal is valid JSON', false, String(e))
    }
    check("the SQL's geography predicate IS the TypeScript one — byte for byte", isShippedPreV2Geography(parsed), JSON.stringify(parsed))
  }

  // Adjacent SQL string literals concatenate; join them back before comparing.
  const sqlString = (block: string): string => (block.match(/'[^']*'/g) ?? []).map((q) => q.slice(1, -1)).join('')
  const objWhere = sql.match(/where objective =\n([\s\S]*?);\n/)
  check('017 carries an objective predicate literal', !!objWhere)
  if (objWhere) check("the SQL's objective predicate IS the TypeScript one", isShippedPreV2Objective(sqlString(objWhere[1])), sqlString(objWhere[1]).slice(0, 60))

  const objSet = sql.match(/set objective =\n([\s\S]*?),\n\s+mission_migration_notes/)
  check('017 writes the neutral objective the code ships', !!objSet && sqlString(objSet[1]) === NEUTRAL_DEFAULT_OBJECTIVE, objSet ? sqlString(objSet[1]).slice(-40) : '')

  // Every city 017 deletes from evidence_preferences is one the old default put
  // in a tier — the migration may not invent a place to remove.
  const seeded = PRE_V2_DEFAULT_GEO_TIERS.flatMap((t) => t.locations)
  const deleteBlock = sql.slice(sql.indexOf("delete from evidence_preferences"))
  for (const city of seeded) {
    check(`017 removes the seeded evidence preference "${city}"`, deleteBlock.includes(`'${city}'`))
  }
  check('017 also removes "location" from the seeded optimize_for list', /category = 'optimize_for'[\s\S]{0,80}value = 'location'/.test(deleteBlock))
  check('017 only ever removes rows it can prove it wrote (not a hard constraint)', /hard_constraint = false/.test(deleteBlock))

  // Re-running is the normal operating condition (CLAUDE.md). A note the founder
  // has dismissed must not come back, so the guard is the ledger, not the note.
  check('the review notes are guarded by the durable ledger, not by their own presence', /mission_migrations_applied @> '\["017:geography_review"\]'/.test(sql) && /mission_migrations_applied @> '\["017:evidence_geography_review"\]'/.test(sql))
  check('the ledger column is created, and nothing in the app can clear it', /add column if not exists mission_migrations_applied/.test(sql))
  check('the app never writes the ledger — sanitizeMissionPatch does not know the key', !read('lib/career/missions/store.ts').includes('mission_migrations_applied'))
  check("a founder who chose \"only these places\" is not told their choice is a ranking preference", /coalesce\(preferences -> 'locations' ->> 'mode', ''\) <> 'only'/.test(sql))
}

// ─── 6. The API boundary rejects loudly ─────────────────────────────────────

console.log('missionPatchError')
{
  check('a good body passes', missionPatchError({ preferences: { locations: { mode: 'only', regions: ['Houston'] } } }) === null)
  check('a bare body passes', missionPatchError({}) === null)
  check('preferences must be an object', missionPatchError({ preferences: [] as never }) !== null)
  check('an unknown location mode is a 400, not a silent drop', (missionPatchError({ preferences: { locations: { mode: 'nearby' as never, regions: [] } } }) ?? '').includes('locations.mode'))
  check("'only' with no region is refused — it would filter out every job", (missionPatchError({ preferences: { locations: { mode: 'only', regions: [] } } }) ?? '').includes('every job'))
  check('an unknown direction mode is a 400', (missionPatchError({ preferences: { direction_mode: 'strict' as never } }) ?? '').includes('direction_mode'))
  check('a non-string direction is a 400', missionPatchError({ preferences: { direction: 42 as never } }) !== null)

  const merged = sanitizeMissionPatch({ preferences: { locations: { mode: 'prefer', regions: ['Houston'] } } }, DEFAULT_MISSION_PREFERENCES)
  const p = merged.preferences as CareerMissionPreferences
  check('a partial dial patch merges over the stored row and does not wipe the lists', p.company_types.length > 0 && p.locations?.mode === 'prefer')
}

// ─── 7. The words the founder actually reads ────────────────────────────────

console.log('UI copy and patches')
{
  const internal = /\bboost\b|\bexclusive\b|\bgeo[_ ]?tier\b|\bmode\b|\bpredicate\b/i
  for (const o of LOCATION_MODE_OPTIONS) {
    check(`location option "${o.label}" says what happens, in plain words`, !internal.test(o.label) && !internal.test(o.hint), `${o.label} / ${o.hint}`)
  }
  for (const o of DIRECTION_MODE_OPTIONS) {
    check(`direction option "${o.label}" says what happens, in plain words`, !internal.test(o.label) && !internal.test(o.hint), `${o.label} / ${o.hint}`)
  }
  check('the three location choices are offered, in escalating strength', LOCATION_MODE_OPTIONS.map((o) => o.value).join(',') === 'anywhere,prefer,only')
  check('"Anywhere in the US" is offered first, as the default', LOCATION_MODE_OPTIONS[0].label === 'Anywhere in the US')
  check('the direction choices are "search harder" and "only show me this"', DIRECTION_MODE_OPTIONS.map((o) => o.label).join(' / ') === 'Search harder for this / Only show me this')
  check('the "only these places" hint warns that it hides things', /hide|left out/i.test(LOCATION_MODE_OPTIONS[2].hint), LOCATION_MODE_OPTIONS[2].hint)

  check('locationsPatch writes the dial and the ranking table together', JSON.stringify(locationsPatch({ mode: 'prefer', regions: ['Houston'] })) === JSON.stringify({ locations: { mode: 'prefer', regions: ['Houston'] }, geo_tiers: [{ tier: 1, locations: ['Houston'] }] }))
  check("choosing 'anywhere' clears the ranking table too — no stale cities left behind", JSON.stringify(locationsPatch({ mode: 'anywhere', regions: ['Houston'] })) === JSON.stringify({ locations: { mode: 'anywhere', regions: [] }, geo_tiers: [] }))

  check('directionPatch still sends only the direction when no mode is given (an old caller keeps working)', Object.keys(directionPatch(' genomics ').preferences).join(',') === 'direction')
  check('directionPatch carries the mode when one is chosen', directionPatch('genomics', 'exclusive').preferences.direction_mode === 'exclusive')
  check('directionPatch never sends a mode with no direction', !('direction_mode' in directionPatch('   ', 'exclusive').preferences))
  check('directionModeFor defaults an unset direction to "search harder"', directionModeFor('genomics', null) === 'boost')
  check('directionModeFor keeps an exclusive choice', directionModeFor('genomics', 'exclusive') === 'exclusive')

  check('the scout line warns before a paid run when the direction hides things', scoutingLine('genomics', 'exclusive').startsWith('Scouting for ONLY:'))
  check('the scout line is unchanged for a boost', scoutingLine('genomics', 'boost') === 'Scouting for: genomics')
  check('the scout line with no direction says exploring broadly', /exploring broadly/i.test(scoutingLine(null)))

  // Both non-neutral choices need somewhere to point, and 'prefer' used to be
  // coerced back to 'anywhere' and reported as "Saved."
  check("'prefer' with no place is refused too, not silently turned into 'anywhere'", (missionPatchError({ preferences: { locations: { mode: 'prefer', regions: [] } } }) ?? '').includes('nothing to prefer'))
  check('the incomplete place choice is flagged for BOTH modes', locationChoiceIncomplete({ mode: 'prefer', regions: [] }) && locationChoiceIncomplete({ mode: 'only', regions: ['  '] }))
  check('a complete choice, and "anywhere", are never flagged', !locationChoiceIncomplete({ mode: 'prefer', regions: ['Houston'] }) && !locationChoiceIncomplete({ mode: 'anywhere', regions: [] }))
  check('each mode gets its own warning, in plain words', /nothing will get through/.test(LOCATION_EMPTY_WARNING.only) && /nothing to prefer/.test(LOCATION_EMPTY_WARNING.prefer))

  // Changing what the direction DOES is a change worth a paid run knowing about.
  const stored = { direction: 'genomics', direction_mode: 'boost' as const }
  check('switching to "only show me this" makes the card dirty', directionDialDirty('genomics', 'exclusive', stored))
  check('re-picking the stored choice does not', !directionDialDirty('genomics', 'boost', stored))
  check('a mode with no direction to apply it to is not a change', !directionDialDirty('', 'exclusive', { direction: null }))
  check('editing the text is still a change', directionDialDirty('genomics research', 'boost', stored))
}

// ─── 7b. The screens actually pass the dial through ─────────────────────────
//
// Every assertion above exercises a pure function. A pure function that no
// screen calls with the right arguments is a claim, not a behaviour — the
// "Scouting for ONLY:" warning passed its unit check for a whole review cycle
// while the panel called scoutingLine() with one argument and could never
// render it. These read the call sites.

console.log('call sites')
{
  const panel = read('app/dashboard/jobs/ScoutPanel.tsx')
  check('the Scout panel asks scoutingLine what the direction DOES, not just what it says', /scoutingLine\(direction,\s*directionMode\)/.test(panel))
  check('the Scout panel cannot be mounted without a mode (the prop is required)', /\n  directionMode: DirectionMode \| null\n/.test(panel))

  const jobs = read('app/dashboard/jobs/page.tsx')
  check('the Jobs page hands the Scout panel the resolved mode', /directionMode=\{mission \? missionDirectionMode\(mission\.preferences\) : null\}/.test(jobs))
  check('the direction card on the Jobs page offers the choice', /onModeChange=\{/.test(jobs) && /mode=\{directionMode\}/.test(jobs))
  check('and SAVES it — a choice that does not reach the mission is decoration', /directionPatch\(direction, directionMode\)/.test(jobs))
  check('changing only the choice lights up Save', /directionDialDirty\(direction, directionMode, mission\?\.preferences\)/.test(jobs))

  const missionPage = read('app/dashboard/jobs/mission/page.tsx')
  check('the Mission page refuses to save a place choice with nowhere to point', /disabled=\{saving \|\| !dirty \|\| placeIncomplete\}/.test(missionPage))
  check('…and says why, inline, for both modes', /LOCATION_EMPTY_WARNING\[locations\.mode/.test(missionPage))
}

// ─── 7c. Place is stated ONCE ───────────────────────────────────────────────
//
// The bug this exists for: `evidence_preferences` was seeded from the SAME old
// geography, and renderPreferences() prints those rows into the planner's and
// the fit evaluator's user message. Neutralising the mission alone left the
// model reading "no place preference" and "location: San Francisco / Bay Area
// (weight 1)" in the same breath.

console.log('withoutPlacePreferences')
{
  // Exactly what the founder's six live rows render as (lib/career/evidence/render.ts).
  const LIVE = [
    'location: San Francisco / Bay Area (weight 1)',
    'location: New York City (weight 1)',
    'location: Boston (weight 0.7)',
    'location: Seattle (weight 0.7)',
    'location: Los Angeles (weight 0.7)',
    'location: Washington DC (weight 0.7)',
    'company_type: advanced manufacturing (weight 0.6)',
    'optimize_for: learning (weight 1)',
    'optimize_for: location (weight 0.44)',
    'work_mode: remote (weight 0.5)',
  ].join('\n')

  const stripped = withoutPlacePreferences(LIVE)
  check('every place row is gone', bannedIn(stripped).length === 0, bannedIn(stripped).join(', '))
  check('"optimize for location" is gone too — it is the same instruction in another category', !/optimize_for: location/.test(stripped))
  check('everything that is NOT a place survives, untouched', stripped.includes('company_type: advanced manufacturing (weight 0.6)') && stripped.includes('optimize_for: learning (weight 1)') && stripped.includes('work_mode: remote (weight 0.5)'))
  check('a block that was ONLY places does not become an empty prompt section', withoutPlacePreferences('location: Boston (weight 0.7)') === '(no preferences recorded)')
  check('a hard place constraint a PERSON typed is NOT removed behind their back', withoutPlacePreferences('location: Houston [HARD]').includes('Houston'))
  check('a value that merely mentions a place is not a place row', withoutPlacePreferences('values: relocation support (weight 0.5)').includes('relocation'))

  // The end to end version of the same claim, through the real prompt builder.
  const fitWithLiveBank = fitEvaluatorPrompt.build({
    mission: renderMission(MISSION()),
    job: {
      title: 'Process Engineering Intern',
      company: 'Nowhere Chemicals',
      location_raw: 'Baton Rouge, LA',
      location_tier: null,
      work_mode: 'onsite',
      employment_type: 'internship',
      season_relevance: 'summer_2027',
      posted_at: null,
      deadline: null,
      description_excerpt: 'Work on a distillation column.',
      min_qualifications: [],
      preferred_qualifications: [],
      graduation_eligibility: null,
      work_authorization: null,
      skills: [],
      responsibilities: [],
      industry: 'chemicals',
      company_size_stage: null,
    },
    companyResearch: '(no research yet)',
    evidenceSummaries: '- chemical engineering intern',
    preferences: LIVE,
    feedbackContext: [],
  })
  check('an "anywhere" mission reaches the FIT evaluator with no city anywhere in the message', bannedIn(fitWithLiveBank.user).length === 0, bannedIn(fitWithLiveBank.user).join(', '))

  const plannerWithLiveBank = jobMissionPlannerPrompt.build({
    mission: renderMission(MISSION()),
    evidenceSummaries: '- chemical engineering intern',
    skills: 'process simulation',
    preferences: LIVE,
    watchlist: { targets: [], watching: [], explore: [], ignored: [], learned: '' },
    recentFeedback: [],
  })
  check('…and reaches the PLANNER with no city either', bannedIn(plannerWithLiveBank.user).length === 0, bannedIn(plannerWithLiveBank.user).join(', '))
  const plannerNoPrefs = jobMissionPlannerPrompt.build({
    mission: renderMission(MISSION()),
    evidenceSummaries: '- chemical engineering intern',
    skills: 'process simulation',
    preferences: '',
    watchlist: { targets: [], watching: [], explore: [], ignored: [], learned: '' },
    recentFeedback: [],
  })
  check('a user with no preferences at all still reads as "none stated", not as a stripped block', plannerNoPrefs.user.includes('(none stated beyond the mission)'))
}

// ─── 8. Prompts ─────────────────────────────────────────────────────────────

console.log('prompts')
{
  check('planner prompt version bumped past 1.3.0', jobMissionPlannerPrompt.version === '1.4.0', jobMissionPlannerPrompt.version)
  check('fit prompt version bumped past 1.2.0', fitEvaluatorPrompt.version === '1.3.0', fitEvaluatorPrompt.version)
  check('evidence matcher bumped too — its user message renders the job through the fit prompt', evidenceMatcherPrompt.version === '1.1.0', evidenceMatcherPrompt.version)

  const planner = jobMissionPlannerPrompt.build({
    mission: renderMission(MISSION()),
    evidenceSummaries: '- chemical engineering intern',
    skills: 'process simulation',
    preferences: '',
    watchlist: { targets: [], watching: [], explore: [], ignored: [], learned: '' },
    recentFeedback: [],
  })
  check('the planner is told geography is not the goal', /GEOGRAPHY IS NOT THE GOAL/.test(planner.system))
  check('the planner is told to go nationwide when there is no place preference', /geo_focus to nationwide/.test(planner.system))
  check('the planner is told a preference is not a filter', /a preference is not a filter/.test(planner.system))
  check('the planner is told what each direction mode does', /DIRECTION — BOOST/.test(planner.system) && /DIRECTION — ONLY THIS/.test(planner.system) && /DIRECTION: none stated/.test(planner.system))
  check('the planner is told no direction means a WIDER search, not a smaller one', /No direction is not a smaller search — it is a wider one/.test(planner.system))
  check('the planner is told discovery biases to recall', /RECALL IS THE POINT OF THIS STEP/.test(planner.system))
  // The system prompt names a coast exactly once, to say a coast is not the
  // point. The MISSION it is handed must name none — that is the founder's half.
  check('the neutral default mission reaches the planner with no city in it', bannedIn(planner.user).length === 0, bannedIn(planner.user).join(', '))
  check('the planner never treats a coast as the goal', !/coastal cit|vibrant/i.test(planner.system))

  const fit = fitEvaluatorPrompt.build({
    mission: renderMission(MISSION()),
    job: {
      title: 'Process Engineering Intern',
      company: 'Nowhere Chemicals',
      location_raw: 'Baton Rouge, LA',
      location_tier: null,
      work_mode: 'onsite',
      employment_type: 'internship',
      season_relevance: 'summer_2027',
      posted_at: null,
      deadline: null,
      description_excerpt: 'Work on a distillation column.',
      min_qualifications: [],
      preferred_qualifications: [],
      graduation_eligibility: null,
      work_authorization: null,
      skills: [],
      responsibilities: [],
      industry: 'chemicals',
      company_size_stage: null,
    },
    companyResearch: '(no research yet)',
    evidenceSummaries: '- chemical engineering intern',
    preferences: '(none)',
    feedbackContext: [],
  })
  check('the fit evaluator is told geography is a ranking signal, not a verdict', /GEOGRAPHY IS A RANKING SIGNAL, NOT A VERDICT/.test(fit.system))
  check('the fit evaluator is told an "anywhere" mission must not move a number', /must not move a single\s+number/.test(fit.system))
  check('the fit evaluator is told a posting need not resemble a previous title', /A POSTING NEVER HAS TO RESEMBLE A PREVIOUS TITLE/.test(fit.system))
  check('the fit evaluator is told boost is not a filter', /Boost is not a filter/.test(fit.system))
  check('the fit evaluator is told a hard location filter was already applied in code', /already been applied in code/.test(fit.system))
  check('a job with no location tier is no longer stamped "not in any mission geography tier"', !fit.user.includes('not in any mission geography tier'), fit.user.split('\n')[2])
  check('a job with no location tier says nothing at all about geography', fit.user.includes('Location: Baton Rouge, LA\n'))
}

console.log(failures ? `\nFAIL — ${failures} check(s) failed` : '\nPASS — all checks passed')
process.exit(failures ? 1 : 0)
