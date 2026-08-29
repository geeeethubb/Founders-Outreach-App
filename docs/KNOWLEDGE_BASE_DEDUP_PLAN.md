# Knowledge Base Consolidation — status

> Status: **implemented 2026-08-28** (migration 015 applied, live bank consolidated once).
> This file records what shipped, how to run it, and what remains. Reasoning:
> [ADR-038](ARCHITECTURE.md#adr-038). Schema: [DATA_MODEL.md](DATA_MODEL.md).

## The model

```
evidence_sources (résumé.docx · LinkedIn export · one post · a profile field)   ← records, hashed
      │  many                                                                   ← evidence_fact_sources
      ▼                                                                            (location · quote · confidence)
evidence_organizations ── canonical name · aliases (P&G = Procter & Gamble = P&G, Tabler Station)
      └── evidence_experiences ── one row per role: head title · dates · canonical_summary
              ├── evidence_projects  (Forge 2026, Keywords, CoLini — only when a source names them)
              ├── evidence_facts     (atomic; support_count; VERIFIED / CORROBORATED / CONFLICTING)
              ├── evidence_metrics · deliverables · stories · resume_bullets
              └── status = merged, merged_into   ← tombstones; never deleted
evidence_merge_suggestions  HIGH / POSSIBLE / CONFLICT with why · data preserved · risk
evidence_conflicts          same field, different values, both kept with their sources
evidence_snapshots          the whole bank, before every apply
```

More sources → more confidence and detail on the same rows, never more rows.

## What shipped

| Piece | Where | Behaviour |
|---|---|---|
| Audit (read-only) | `npm run evidence:audit` | organization groups, duplicate candidates by class, facts without provenance, orphan metrics, conflicts, summaries → `.career-out/evidence/audit-*.json` |
| Dry run / apply | `npm run evidence:consolidate -- --dry-run` (default) · `--apply` · `--apply --pair keep:merge [--possible]` | KEEP / MERGE / WHY / DATA PRESERVED / RISK table; apply snapshots first, applies **HIGH only**, writes POSSIBLE / CONFLICT as open suggestions; re-run is a no-op |
| Engine | `lib/career/evidence/consolidate*.ts` | pure plan builder; rules in `consolidate-rules.ts`; mutations listed by `planMutations` before they run |
| Identity | `normalize.ts` (`ORG_ALIASES`, `normalizeTitle`, `parseResumeDate`) | edit the alias table when a new spelling appears |
| Sources + provenance | `sources.ts`, `provenance.ts`, `persist.ts` | one source per import (hashed); provenance for inserted **and** reused facts; conflicts recorded, résumé value kept |
| Importer sees the bank | `lib/agents/resume-importer` 1.2.0, `import.ts` | files under existing experiences; `corroborates` marks a restatement; code decides full (1.0) vs event-only (0.5) support by the numbers |
| Canonical summaries | `summary.ts` | deterministic, from approved facts, ≤240 chars, skipped for hand-edited rows |
| Retrieval | `retrieval.ts` `getRelevantPersonalEvidence` | the only way agents read the bank; benchmark `npm run evidence:benchmark` |
| UI | Evidence → **Canonical** (org → roles → projects → facts → sources) and **Review (N)** (Merge · Keep separate · Merge all high-confidence · conflicts) | `/api/career/evidence/{canonical,review,consolidate}` |
| Tests | `test:career-evidence` 130 · `test:career-provenance` 86 · `test:career-consolidation` 143 · `test:career-retrieval` 107 · `test:career-canonical-view` 51 | idempotency, aliases, VP ≠ President, two labs, two summers, different numbers, weaker restatements, event-only support, no-loss mutations, personas |

## Matching rules (as shipped)

| Signal | Rule |
|---|---|
| Organization | normalize (case, diacritics, `&`→and, legal suffixes, parenthetical / after-comma qualifier stripped) then the alias table. Equal keys are **required**; substrings never match (`PG Solutions` ≠ P&G). |
| Qualifier | the stripped part (`Tabler Station`, `Professor X's lab`). Different non-location qualifiers → POSSIBLE at most; a qualifier on one side with no dates on either → POSSIBLE. |
| Title | head title after dropping `; Formerly …`, `(previously …)`, `, prev. …`; equal, or token similarity ≥ 0.6 with containment only over seniority words → HIGH; 0.3–0.6 → POSSIBLE; a rank modifier (`Vice`, `Deputy`, `Assistant`, `Head of`) → never. |
| Dates | parsed months; `5/2026` = `May 2026`; `Present` ≠ a month (recorded as a conflict, still mergeable); disjoint ranges → never. Same org + ≥80 % period overlap + different titles → POSSIBLE with a title conflict. |
| Kind | education / award never merge with work; award↔award only on equal titles. |
| Keep side | hand-edited row, then the résumé row, then the older. Both edited → POSSIBLE. |
| Facts | equal normalized statement → HIGH; identical numbers + ≥0.8 word overlap → reused at import, POSSIBLE in the engine; 0.6–0.8 → POSSIBLE; a number-less restatement (content words ≥0.8 contained in the numbered one) → POSSIBLE `weaker_restatement`, never CONFLICT; two numbered statements with different numbers on similar text → CONFLICT. Safest wording = the subset statement, else the résumé's — except a `weaker_restatement`, where the numbered statement stays and the bare wording survives as a 0.5 quote. |
| Support | `support_count` and CORROBORATED count only provenance rows at confidence ≥0.9. A reused fact's row quotes the incoming wording at 1.0 when it carries the fact's numbers, 0.5 when it restates the event only (`corroborate.ts`); a 0.5 row shows as "… (event only)" and never makes a metric look supported. |
| Organization kind | name heuristic refined by the rows under it: award-only → `other`; "Self" / "Self (public profile)" → `other`; "Startup School" → `program`. Apply refreshes an existing organization's kind and aliases. |
| Metrics | equal normalized value + context overlap ≥ 0.5 → HIGH; an orphan links to the one fact under its experience that carries its number. |

## First live run (2026-08-28, user bank of 28 experiences / 59 facts / 25 metrics)

Dry run: 3 HIGH (Founders president, IBC project manager, P&G QA intern — each a résumé row
plus its LinkedIn-export twin), 4 POSSIBLE (Argonne analyst vs student researcher, LoopEra
founding team vs executive assistant, two UIUC education rows, the Mironenko lab vs the résumé's
undergraduate researcher), 1 POSSIBLE fact, 6 orphan metrics, 2 date conflicts. Apply: snapshot
`d1ff7e5d…`, 18 organizations, 4 backfilled sources, 59 + 28 provenance rows, 3 merges with 17
children re-pointed, **0 rows deleted**; second apply linked 1 orphan metric; third dry run:
nothing left to apply. The Review tab lists the POSSIBLE pairs.

## Remaining

- The four POSSIBLE experience pairs and the POSSIBLE fact are the founder's call (Review tab).
- Backfilled sources for pre-015 imports have no raw content (it was never stored); new imports do.
- `evidence_projects` is populated only when a source names a project; nothing has yet.
- Awards imported as one umbrella row ("Academic and Public Service Honors") beside per-award
  rows are left alone: an award-only organization is `kind = other`, and award rows merge only on
  equal titles.
- Older eval/probe scripts (`scripts/agentic-eval.ts`, `positioning-eval.ts`, …) still import
  `RESUME_ITEMS` directly; they are evals, not product paths.
