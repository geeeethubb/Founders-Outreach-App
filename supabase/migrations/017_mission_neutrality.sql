-- 017_mission_neutrality.sql
--
-- Geography stops being a built-in preference.
--
-- WHY. The shipped default mission put "San Francisco / Bay Area" and "New York
-- City" in geography tier 1 and four coastal cities in tier 2. Nobody asked for
-- that. It was written into `defaultMission()` at seed time, it was printed into
-- every planner and fit-evaluator prompt by `renderMission()`, and it was
-- appended to deterministic search queries — while the founder's own stated
-- direction read "I don't care about location or which company". A preference
-- the PRODUCT invented was outranking the one the USER stated.
--
-- WHAT CHANGES. After this migration geography has three named behaviours and
-- they are never conflated (lib/career/missions/preferences.ts; ADR-042):
--
--   locations.mode = 'anywhere'  no place preference at all   ← the new default
--   locations.mode = 'prefer'    a RANKING signal only
--   locations.mode = 'only'      a HARD FILTER
--
-- Geography lived in TWO tables, and both are handled here: `career_missions`
-- .preferences (the tiers and the objective prose) and `evidence_preferences`
-- (six coastal `location` rows plus `location` in `optimize_for`, seeded from
-- the same defaults and printed into the same prompts). Neutralising one and
-- not the other would have left the planner reading "no place preference" and
-- "location: San Francisco / Bay Area (weight 1)" in the same message.
--
-- WHAT IS AND IS NOT TOUCHED. The old geography is system-generated, so it is
-- migrated. A mission somebody EDITED is not — not one city of it. The test is
-- byte identity with the shipped pre-V2 default, compared as jsonb, which is
-- the same comparison `isShippedPreV2Geography()` makes in TypeScript
-- (lib/career/missions/store.ts). Anything that differs by so much as a comma
-- is left exactly as it is and gets a note this migration writes to
-- `career_missions.mission_migration_notes`, which the Mission page surfaces as
-- a suggestion the founder can act on or dismiss. Nothing is silently
-- overwritten, and nothing is deleted.
--
-- Additive and idempotent; re-running is the normal operating condition.
-- Run `npm run check:sql -- 017` before applying.

-- ---------------------------------------------------------------------------
-- 1. Somewhere to record a suggestion instead of overwriting a preference
-- ---------------------------------------------------------------------------

alter table career_missions add column if not exists mission_migration_notes jsonb;

comment on column career_missions.mission_migration_notes is
  'Append-only jsonb array of { kind, migration, created_at, message, ... } notes. '
  'A migration that declines to change a user preference writes one here so the UI '
  'can surface it as a review suggestion. Never a filter, never read by an agent. '
  'DISMISSIBLE: the Mission page removes an element and PATCHes the shorter array, '
  'so this column can never be used as the "have I run yet?" guard — that is what '
  'mission_migrations_applied is for.';

-- The DURABLE marker. `mission_migration_notes` is a mailbox the founder empties;
-- this is the ledger, and nothing in the app writes it (`sanitizeMissionPatch`
-- does not know the key exists, so a PATCH cannot clear it). Every step below
-- that writes a note guards on this instead of on the note's own presence —
-- otherwise dismissing a suggestion would bring it back on the next re-run, and
-- CLAUDE.md is explicit that re-running a migration is the normal condition.

alter table career_missions add column if not exists mission_migrations_applied jsonb not null default '[]'::jsonb;

comment on column career_missions.mission_migrations_applied is
  'Append-only ledger of migration steps already run against this row, as string keys '
  'like "017:geography_review". Written ONLY by migration SQL and never by the app, so '
  'dismissing a suggestion in the UI cannot cause a re-run to write it again.';

-- career_missions already has RLS and the "Users manage own …" policy from
-- 014_career_os.sql; a new column on an existing table needs no policy change.

-- ---------------------------------------------------------------------------
-- 2. Neutralise the SYSTEM-GENERATED geography, and only that
-- ---------------------------------------------------------------------------
--
-- The predicate is the exact tier arrays as they shipped. jsonb equality is
-- order-sensitive for arrays and insensitive to key order and whitespace, so
-- this matches the shipped value and no near-miss of it.

update career_missions
set preferences =
      jsonb_set(
        jsonb_set(preferences, '{geo_tiers}', '[]'::jsonb, true),
        '{locations}',
        '{"mode":"anywhere","regions":[]}'::jsonb,
        true
      ),
    mission_migration_notes =
      coalesce(mission_migration_notes, '[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object(
        'kind', 'geography_neutralized',
        'migration', '017',
        'created_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'message', 'The default San Francisco / New York geography was system-generated, not something you chose. It has been replaced with "anywhere in the US". Set a place preference on the Mission page if you want one.',
        'replaced', preferences -> 'geo_tiers'
      ))
where preferences -> 'geo_tiers' = '[
        {"tier": 1, "locations": ["San Francisco / Bay Area", "New York City"]},
        {"tier": 2, "locations": ["Boston", "Seattle", "Los Angeles", "Washington DC"],
         "description": "other large, vibrant East or West Coast cities — genuinely strong urban markets"}
      ]'::jsonb;

-- The objective named the same cities in prose, and it is printed into every
-- prompt too. Same rule: replaced only when byte-identical to what shipped.

update career_missions
set objective =
      'Find high-quality Summer 2027 internships where I will learn fast, own real work, and sit with '
      'intelligent colleagues on technically interesting, important problems — anywhere in the United States.',
    mission_migration_notes =
      coalesce(mission_migration_notes, '[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object(
        'kind', 'objective_neutralized',
        'migration', '017',
        'created_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'message', 'The default objective ended "in the Bay Area or New York first, other strong coastal cities second". That clause was shipped, not chosen, and has been removed.',
        'replaced', to_jsonb(objective)
      ))
where objective =
      'Find high-quality Summer 2027 internships where I will learn fast, own real work, and sit with '
      'intelligent colleagues on technically interesting, important problems — in the Bay Area or New York '
      'first, other strong coastal cities second.';

-- ---------------------------------------------------------------------------
-- 3. Everything else: a suggestion, not an edit
-- ---------------------------------------------------------------------------
--
-- A mission that still has geography after step 2 has geography the founder
-- wrote (or edited). Leave every character of it alone and say so once.
--
-- TWO THINGS MAKE THIS SAFE TO RE-RUN AND HONEST TO READ:
--
--   the guard is the LEDGER, not the note. A founder who dismisses the
--   suggestion has answered it; keying on `mission_migration_notes @> …` would
--   hand it back to them every time this file is pasted again.
--
--   a row whose dial already says 'only' is SKIPPED. That founder chose "Only
--   these places" deliberately, and telling them "they are now a ranking
--   preference, never a filter" would be the exact opposite of what they chose.
--
-- No `locations` key is written for these rows on purpose: `missionLocations()`
-- reads a pre-017 row's tiers as mode 'prefer', which is exactly what tiers
-- already meant. Writing the key would be inventing a preference; deriving it
-- at read time is not.

update career_missions
set mission_migration_notes =
      coalesce(mission_migration_notes, '[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object(
        'kind', 'geography_review',
        'migration', '017',
        'created_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'message', 'Your mission names specific places. They are now a RANKING preference, never a filter — jobs elsewhere are still discovered and still shown. Choose "Only these places" on the Mission page if you meant them as a filter, or "Anywhere in the US" to drop them.',
        'geo_tiers', preferences -> 'geo_tiers'
      )),
    mission_migrations_applied = mission_migrations_applied || '["017:geography_review"]'::jsonb
where jsonb_typeof(preferences -> 'geo_tiers') = 'array'
  and jsonb_array_length(preferences -> 'geo_tiers') > 0
  and coalesce(preferences -> 'locations' ->> 'mode', '') <> 'only'
  and not mission_migrations_applied @> '["017:geography_review"]'::jsonb;

-- ---------------------------------------------------------------------------
-- 3b. The SAME geography, in the OTHER table
-- ---------------------------------------------------------------------------
--
-- `evidence_preferences` is the per-row view of the same preferences, and the
-- seed (lib/career/evidence/preferences.ts) wrote the old geography into it:
-- six coastal cities as `location` rows at the tier weights, plus `location`
-- itself in `optimize_for`. `renderPreferences()` prints those rows verbatim
-- into the planner's and the fit evaluator's user message — so neutralising the
-- mission alone would have left the prompt saying "no place preference" and
-- "location: San Francisco / Bay Area (weight 1)" in the same breath.
--
-- Same rule as everywhere else in this file: a row is removed ONLY when it is
-- byte-identical to what the seed wrote — the exact value, the exact weight,
-- the exact "tier N" note, and not a hard constraint. A weight the founder
-- nudged, a note they typed, a city they added: untouched, and flagged.
--
-- (The prompt does not depend on this having been run. `withoutPlacePreferences()`
-- strips place lines out of the rendered block whatever the table still holds —
-- ADR-042. This is the database catching up with the contract, not the contract.)

delete from evidence_preferences
where category = 'location'
  and hard_constraint = false
  and (value, weight, coalesce(note, '')) in (
    ('San Francisco / Bay Area', 1.0, 'tier 1'),
    ('New York City',            1.0, 'tier 1'),
    ('Boston',                   0.7, 'tier 2'),
    ('Seattle',                  0.7, 'tier 2'),
    ('Los Angeles',              0.7, 'tier 2'),
    ('Washington DC',            0.7, 'tier 2')
  );

delete from evidence_preferences
where category = 'optimize_for'
  and value = 'location'
  and weight = 0.44
  and note is null
  and hard_constraint = false;

-- Anything still calling itself a place preference here is the founder's. Say so
-- once, on their missions, guarded by the ledger so a dismissal sticks.

update career_missions m
set mission_migration_notes =
      coalesce(m.mission_migration_notes, '[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object(
        'kind', 'evidence_geography_review',
        'migration', '017',
        'created_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'message', 'Your Evidence Bank still lists places under "location". Place is now set in one spot only — the location choice on this page — so those rows no longer reach the search. Delete them on the Evidence page, or move what you meant into the location choice here.'
      )),
    mission_migrations_applied = m.mission_migrations_applied || '["017:evidence_geography_review"]'::jsonb
where exists (
        select 1 from evidence_preferences p
        where p.user_id = m.user_id and p.category = 'location'
      )
  and not m.mission_migrations_applied @> '["017:evidence_geography_review"]'::jsonb;

-- ---------------------------------------------------------------------------
-- 4. Verify by hand after applying
-- ---------------------------------------------------------------------------
--
--   select id, name,
--          preferences -> 'geo_tiers'  as geo_tiers,
--          preferences -> 'locations'  as locations,
--          mission_migration_notes,
--          mission_migrations_applied
--   from career_missions;
--
--   select category, value, weight, note from evidence_preferences
--   where category = 'location' or (category = 'optimize_for' and value = 'location');
--
-- Expected on the founder's row: geo_tiers [], locations {"mode":"anywhere",…},
-- two notes (geography_neutralized, objective_neutralized), NO geography_review
-- note, and NO evidence_geography_review note — because the second query should
-- return zero rows.
--
-- Then re-run this whole file. Nothing should change: no new notes, no new
-- ledger entries, no rows deleted. That is the property being defended.
