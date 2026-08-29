# Knowledge Base Dedup Plan

> Status: **plan** — the safe subset shipped on 2026-08-28 (normalized keys, alias table,
> title-similarity matching with a date guard, within-import dedupe, old-master bullet
> demotion, no-duplicate manual adds). The rest needs a dedicated implementation pass.

## Current problem

Importing the same experience from several sources — résumé, LinkedIn text, notes — can create
several `evidence_experiences` rows for one role, and the same achievement worded two ways
becomes two `evidence_facts` rows, each remembering only one source. Downstream agents read the
rows as they are, so duplicates double up in fit, matching and tailoring prompts.

## Root cause

1. **Matching was string equality.** Experiences deduped on exact lowercase `org::title`; facts
   on exact statement under the experience id. `P&G` ≠ `Procter & Gamble`; `President` ≠
   `President, Founders`. *(Fixed: normalized keys, alias table, similarity + date guard.)*
2. **Dedupe runs after extraction, blind to the bank.** Pasted text goes to the importer agent
   with `experiences: []` and `allow_new_experiences: true`, so the agent must *invent* a block
   for a role the résumé already defines; only then does code compare strings.
3. **Provenance is one column.** `evidence_facts.source` / `source_location` hold one source.
   A fact corroborated by two sources keeps the first and drops the second. *(Partial: the
   dropped source is now reported as "corroborated" at import time, not stored.)*
4. **Sources are not records.** Only DOCX uploads have a `resume_documents` row; pasted
   LinkedIn/profile text exists only as the label `pasted.linkedin L4`.
5. **No project / organization / role entities.** Organization and role are text columns on the
   experience; "project" is a `kind` value. Related work under one org is linked by string only.
6. **No canonical view.** Renderers iterate raw rows (summaries take the first two facts by
   insertion order); the older outreach loop reads a hardcoded fixture instead of the bank.

## Desired model

```
evidence_sources (résumé.docx · linkedin.txt · post A · profile.personal_context)
      │  many
      ▼
evidence_experiences  ── canonical: organization (aliased) · role title · dates · summary
      ├── evidence_projects     (Forge 2026, AI hackathon, a P&G project)  ← optional, kind-agnostic
      ├── evidence_facts        (atomic, safest supported wording)
      │       └── evidence_fact_sources (fact ↔ source, location, confidence)   ← many-to-many
      ├── evidence_metrics · deliverables · stories
      └── merge_status / merge_candidate_of  (CONFIRMED · LIKELY · CONFLICTING · NEEDS_REVIEW)
```

More sources → more confidence and detail on the same canonical rows; never more rows.

## Safe migration approach

All additive, idempotent, RLS in the existing pattern (`015_evidence_provenance.sql`):

1. `evidence_sources` (id, user_id, kind, label, sha256, text or storage_path, imported_at).
   Backfill one row per existing `resume_documents` and one per distinct `source_location`
   prefix already present in `evidence_facts`.
2. `evidence_fact_sources` (fact_id, source_id, location, confidence, imported_at, unique).
   Backfill from each fact's current `source`/`source_location`. Keep the old columns as
   "first seen" so nothing downstream changes.
3. `evidence_experiences.canonical_summary text`, `merge_status text default 'CONFIRMED'`,
   `merge_candidate_of uuid null`, `organization_norm text` (generated from the alias
   normalizer at write time, indexed).
4. `evidence_projects` (id, user_id, experience_id, name, description, fact_ids[], approved)
   — populated only by explicit user action or a future importer field; never by guessing.
5. Import contract change (prompt version bump): `importFromText` passes the **existing
   experiences** to the importer with `allow_new_experiences: true`, so the agent files facts
   under existing ids and proposes a new block only when none fits; the deterministic matcher
   remains as the second check.
6. A **consolidation pass** (`npm run career:consolidate`, dry-run by default) that runs the
   matcher over the existing bank, merges only CONFIRMED pairs, writes LIKELY pairs as
   `merge_candidate_of`, and prints everything it did.

## Entity matching rules (already the shipped logic; extend, do not replace)

| Signal | Rule |
|---|---|
| Organization | normalize (case, diacritics, `&`→and, parentheticals, legal suffixes) then alias table (`P&G`, `UIUC`, `Founders`…). Same normalized org is **required** for any merge. |
| Title | token Jaccard ≥ 0.6, or prefix/containment, after dropping qualifiers ("President, Founders"→"president"). Below 0.3 never merges; 0.3–0.6 becomes a **near-miss suggestion**. |
| Dates | parsed month/year where present; overlapping or touching ranges are compatible; null is compatible. Non-overlapping ranges **block** the merge (two P&G internships in different years stay separate). |
| Kind | `education` and `award` rows never merge with experiences. |
| Relationship | a source line that names a project ("Organized Forge 2026") attaches to the experience whose org matches; it does not create an experience. |
| Agent context | when the importer is shown existing experiences, its filing decision is a signal, verified by the rules above, never the sole decider. |

## Fact merging rules

- Key: experience + normalized statement (case, whitespace, punctuation, quotes, dashes,
  markdown). Identical → one row; the second source is recorded (today: reported; after
  migration: `evidence_fact_sources`).
- Near-duplicates (same numbers, ≥ 0.8 token overlap) → **suggestion**, not automatic. The
  surviving wording is the **weaker, mutually supported** claim; a stronger claim ("largest AI
  hackathon in UIUC history") stays a separate fact with only its own source.
- Numbers are never harmonized across facts ("200+" and "400+" are two facts).
- Manual edits set `edited_by_user = true` (new column) and are never overwritten by re-import.

## Conflict handling

- Same experience, conflicting dates or titles across sources → `merge_status = CONFLICTING`,
  both values kept in a `conflicts jsonb` ({field, values: [{value, source}]}); the résumé
  value stays canonical (most deliberate source), the row is shown on the Experiences tab with
  a "Needs review" badge and a one-click "use résumé / use LinkedIn / keep both".
- Trivial differences (punctuation, `Present` vs `present`, "May 2026" vs "5/2026") are
  normalized, not surfaced.
- Downstream renderers never read a CONFLICTING field's alternative values; they read the
  canonical one and, for the verifier, the union (so a true claim from either source passes).

## Tests

- Offline (`scripts/test-career-evidence.ts`): every rule above with positive and **negative**
  cases — Head of Events vs President (no merge), two P&G years (no merge), alias merges,
  near-miss reported not merged, stronger claim not folded, corroboration recorded, same résumé
  twice → 0 new rows, same text twice → 0 new rows, text after résumé → 0 new experiences.
- Consolidation dry-run on the real bank prints proposed merges with the rule that fired; the
  first live run is reviewed by hand before `--apply`.
- Downstream regression: token count of `renderExperienceSummaries` and `buildTailorInput`
  must not rise after a second-source import (it should fall or stay flat).

**A dedicated implementation pass is warranted** for items 1–6 of the migration approach; the
shipped subset stops the common duplicates but does not give facts multi-source provenance,
merge suggestions, or conflict status.
