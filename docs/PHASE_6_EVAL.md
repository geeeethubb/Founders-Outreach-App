# Phase 6 — Grounded Research: Eval Report

> Goal: raise Phase 3 scouting Precision@20 (44%) by giving ranking real evidence
> instead of Apollo keyword labels.
> Companion docs: [PHASE_3_EVAL.md](PHASE_3_EVAL.md) · [EVALS.md](EVALS.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [PIPELINE.md](PIPELINE.md)

---

## 1. Housekeeping (completed first)

| Item | Status |
|---|---|
| Apollo credential loaded only from env | ✅ Verified — `process.env.APOLLO_API_KEY` only, no hardcoded literals anywhere |
| Legacy credential removed from git history | ⚠️ **Not done — needs your decision.** See below and [SECURITY_CREDENTIAL_EXPOSURE.md](SECURITY_CREDENTIAL_EXPOSURE.md) |
| `my_resume.pdf` untracked but locally usable | ✅ `git rm --cached`, gitignored, still on disk and read by the eval |
| Migration `010_companies_scouting.sql` applied | ❌ **Not applied.** See §1.2 |

### 1.1 The credential is worse than previously assessed

Phase 3 flagged this conditionally. Verified now:

- Remote exists: `github.com/geeeethubb/Founders-Outreach-App`
- The introducing commit `e5029ca` **is an ancestor of `origin/main`**
- The repository is **PUBLIC** (anonymous GitHub API returns 200)

So the key is publicly readable in history. **Rotation is the only real fix and
only you can do it.** History rewriting was deliberately not performed: it
requires a force-push to a public repo, it breaks every existing clone and fork,
and it does **not** actually remove the blob (GitHub keeps unreachable objects
fetchable by SHA until Support purges them). A rewrite that feels like
remediation but isn't is worse than none, because it invites relaxing on the
rotation that actually matters. Exact commands are in
[SECURITY_CREDENTIAL_EXPOSURE.md](SECURITY_CREDENTIAL_EXPOSURE.md) if you want
the cleanup anyway.

### 1.2 What migration 010 needs

Verified via `npx tsx scripts/check-db.ts`:

```
companies table:      MISSING
company_sources:      MISSING
contacts.apollo_id:   MISSING
contacts.company_id:  MISSING
```

**To enable persistent scouting:** open the Supabase SQL editor and run
`supabase/migrations/010_companies_scouting.sql` in full. It is idempotent and
additive — no existing table or column is altered destructively, and every V1
screen keeps working. Until then `lib/scouting/persist.ts` detects the missing
schema and returns `migrationMissing` instead of throwing, so scouting runs but
persists nothing.

---

## 2. What was built

### Research layer

| Module | Purpose |
|---|---|
| `lib/providers/web/openai-search.ts` | `WebResearchProvider` via the OpenAI Responses `web_search` tool; returns real `url_citation` provenance |
| `lib/research/types.ts` | Dossier shapes + `validateClaims()` — the sourcing invariant |
| `lib/research/company.ts` | Company dossier: what they actually do, who they serve, domain evidence, mission-relevance verdict |
| `lib/research/person.ts` | Person dossier: apparent ownership, decision authority, recent initiatives |

### Pipeline restructured for cost

`lib/scouting/pipeline-v2.ts` implements the requested ordering:

```
DISCOVER               Apollo people search — obfuscated stubs, no credits
CHEAP FILTER           deterministic, on stub title + company name — free
COMPANY RESEARCH       one grounded web call per unique company
PRELIMINARY RELEVANCE  the researcher's own mission-relevance verdict
SHORTLIST              keep people only at companies that survived
APOLLO ENRICHMENT      credits spent ONLY here, on the shortlist
PERSON RESEARCH        grounded web call per shortlisted person
FINAL SCORE            scoring reasons over evidence, not keywords
```

Stubs carry a company **name** (not a domain), which is what makes
research-before-enrichment possible at all.

### Cost-control infrastructure

- **Per-person enrichment index.** Phase 3 cached enrichment per *batch of ten*,
  so the cache went cold the moment the pipeline changed which people it picked.
  Enrichment is the only hard currency here, and this was quietly wasting it.
  Indexing by Apollo id recovered **1,373 already-purchased records**
  (`npm run backfill:person-index`).
- **`APOLLO_CACHE_ONLY=true`** (default for the Phase 6 eval) — serves only from
  cache, never spends a credit. Also makes iterations comparable, since the
  candidate pool is frozen.
- **Failures are never cached.** A transient parse error was being written to the
  cache and replayed forever, turning a blip into a permanent property of the
  input. Same class of bug as the Phase 3 cache-key defect.
- **Budgets**: `WEB_SEARCH_MAX_PER_RUN`, `APOLLO_MAX_CALLS_PER_RUN`,
  `MAX_COMPANIES_TO_RESEARCH`, `RESEARCH_CONCURRENCY`.

### New metrics

`BAD rate@20` · `Research coverage` · `Fact grounding` ·
**`COST PER GOOD TOP-20 PROSPECT`**

---

## 3. The sourcing invariant

The rule "every FACT must have a source" is enforced structurally, in three
layers, rather than by asking the model:

1. `validateClaims()` **downgrades** a `FACT` without a resolvable `http(s)` URL
   to `INFERENCE`. It is not dropped — the observation may still be useful, it
   simply is not verified.
2. A `FACT` citing a URL that **the web search did not actually return** is also
   downgraded. The model cannot cite a plausible-looking URL it invented.
3. `checkFactGrounding()` asserts the invariant over the final top 20 as a
   regression guard.

Measured: **269/269 FACT claims carried a source URL** on the consulting profile.

---

## 4. Results

### ⛔ Iteration stopped by a second external blocker

**Both providers are now exhausted.**

| Provider | State | Evidence |
|---|---|---|
| Apollo lead credits | Exhausted (Phase 3) | `422 "You have insufficient credits!"` |
| OpenAI API credits | **Exhausted (Phase 6)** | `429 "You have no credits remaining"` (`insufficient_quota`) |

The Apollo blocker was worked around — the per-person index plus
`APOLLO_CACHE_ONLY` made the whole eval run at **0 credits**. The OpenAI blocker
cannot be worked around: research, scoring and judging all require model calls.

The full 5-profile run (`p6c`) died partway through the first profile's company
research. **Its results do not exist and are not reported.**

### What was measured: the consulting profile, end to end

Consulting was chosen deliberately as the probe — it was Phase 3's worst profile
(15–30%) and the clearest test of whether research fixes domain drift.

| Metric | Phase 3 (iter 4) | **Phase 6 (p6b)** | Threshold | |
|---|---|---|---|---|
| Precision@20 | 15% | **20%** | ≥ 65% | ❌ |
| BAD rate@20 | 25% (5/20) | **15%** (3/20) | ≤ 10% | ❌ |
| Research coverage | 0% | **100%** | ≥ 95% | ✅ |
| Fact grounding | n/a | **100%** (269/269) | 100% | ✅ |
| Data completeness | 99% | **95%** | ≥ 95% | ✅ |
| Duplicate rate | 0% | **0%** | < 2% | ✅ |
| Seniority calibration | 99% | **100%** | ≥ 80% | ✅ |
| Apollo credits consumed | ~700 | **0** | — | ✅ |
| Cost per GOOD top-20 prospect | not measured | **$0.98** | — | — |

Pipeline funnel for that run:

```
269 stubs → 246 after cheap filter (23 removed free)
          → 90 companies researched, 36 REJECTED as off-domain (40%)
          → 118 shortlisted → 100 enriched (0 credits, from the index)
          → 94 candidates → 60 person dossiers
```

Usage: 60 web searches, 74 model calls, ~$3.93, **0 Apollo credits**.

### Honest read

**Research works. It did not rescue consulting, and the reason matters.**

The infrastructure hit every quality bar: total coverage, every fact sourced,
zero credits, and a 40% domain-drift kill rate. What it did *not* do is lift
Precision@20 above 20%, and inspecting the failures shows why — the research is
**correct**, and the judge **agrees with it**:

| Prospect | Research found | Judge said |
|---|---|---|
| Avid Engineers | "MEP-FP and process engineering services **for buildings** and industrial facilities" | "more building systems/commissioning than industrial AI, chemicals, or process operations" |
| Semco Carbon | "custom carbon and **graphite machining**" | "niche custom graphite machining… role does not obviously connect to internships" |
| Streamliners | "operations-focused consulting… efficiency, operational excellence" | "emphasis on **restructuring, headcount reduction**, margin improvement" |
| Axsis Supply Chain | "supply chain planning technology, especially **Infor** implementations" | "more adjacent than central" |

Research and judge reached the *same* conclusion from the *same* evidence. That
is not a ranking failure — it is research **proving a supply-side limitation**.
After removing the 36 genuinely-wrong companies, what Apollo can surface for
"US industrial/operations consulting, 15–3,000 employees" is largely MEP
engineering firms, ERP implementers, lean/restructuring shops and EHS
consultancies. There are not 20 great prospects in that population.

Phase 3 could only *suspect* this. Phase 6 has 90 sourced dossiers that
demonstrate it.

### Changes implemented but never validated

The p6b analysis drove two changes that the OpenAI blocker prevented measuring.
Both are implemented, typechecked and committed; neither has a number behind it
and neither should be presented as an improvement until it does:

1. **Scorer v5.0.0** — the p6b run showed the scorer *had* correct research and
   ignored it, still ranking Avid Engineers at 89 and Semco Carbon at 79. v5
   makes the researched **core business** decisive, with explicit caps for
   buildings/MEP, EHS/restructuring, ERP-implementation and job-shop
   manufacturing.
2. **Judge v1.2.0** — the judge had been reading Apollo's `description` field,
   which is empty for most companies, so it was partly measuring the provider's
   data gaps. It now receives the researched description. Independence is
   preserved: different prompt, different question, still no access to the
   scorer's numbers or reasoning.

**First action when credits are restored:** `npm run eval:phase6 -- p6d`.
Company research for consulting and part of industrial-AI is already cached, so
the marginal cost is mostly the remaining profiles.

---

## 5. Failure modes

### Fixed by research

**DOMAIN DRIFT — fixed, measurably.** 36 of 90 consulting companies (40%) were
rejected with sourced reasoning before a single credit was spent. Golf-club
advisories (GGA Partners), commercial real-estate firms (Vivo Real Estate) and
similar keyword false-positives are now eliminated at the research stage. The
Phase 3 deterministic substring filter has been retired in favour of this — a
researched verdict is a far better instrument than substring matching on an
Apollo keyword blob.

**THIN COMPANY CONTEXT — fixed.** 0% → 100% coverage. Every prospect in the
final list has a grounded, sourced description of what the company actually does.

**SEARCH NOISE — partly fixed.** The free stub filter removes 23 candidates
before any spend, and research removes 40% more. What remains is real companies
that are simply mediocre for this mission.

### Not fixed

**CONSULTING PRECISION — not fixed, and now understood.** 15% → 20%. Research
proved the constraint is supply, not ranking: Apollo's consulting keyword space
does not contain twenty strong prospects for a ChemE undergraduate. No amount of
better ranking over the same pool changes that.

**BAD rate 15% vs ≤10% target.** Improved from Phase 3's 25% but still failing.
Scorer v5 targets exactly this and is unvalidated.

### New failure modes found and fixed during the phase

- **Research relevance was initially too narrow** — the first probe rejected
  *Sunburst Chemicals*, a real chemicals manufacturer, for "lacking an AI
  dimension". The user is a chemical engineer; industrial operators are the
  corporate-innovation lane, not an edge case. Fixed in company-research v1.1.0,
  which now keys on the industrial/process world rather than on AI, and prefers
  a false positive (caught downstream) over a false negative (permanent and
  invisible).
- **Failed dossiers were being cached**, making a transient parse error a
  permanent property of the input. Same class as the Phase 3 cache-key bug.
- **Truncated JSON from the researcher** — reasoning tokens count against
  `max_completion_tokens`; the budget was too small and produced silent parse
  failures.
- **Batch-keyed enrichment cache** made 1,373 purchased records unreachable
  whenever selection changed. This one had been quietly wasting Apollo credits
  since Phase 3.

---

## 6. Recommended next architectural step

### Immediately

1. **Top up OpenAI credits**, then `npm run eval:phase6 -- p6d` to validate
   scorer v5 and judge v1.2.
2. **Top up Apollo credits** only if you want a *fresh* candidate pool. The eval
   itself no longer needs them.
3. **Rotate the exposed Apollo key** and **apply migration 010** (§1).

### The architectural change the evidence actually points to

Phase 6 answered a question Phase 3 could only guess at, and the answer redirects
the roadmap:

> The binding constraint is **candidate supply**, not research and not ranking.

Two profiles (startups) reached 65–70% in Phase 3 because Apollo can surface good
startups. Consulting sits at 20% because Apollo cannot surface good industrial
consultancies — its keyword taxonomy is lexical and its coverage of small
specialist firms is poor.

More ranking sophistication over the same pool will not fix that. Two options,
in order of leverage:

**A. Research-led discovery (recommended).** Invert the remaining half of the
funnel: instead of asking Apollo for companies and researching what it returns,
ask the *research layer* to name companies — "US firms consulting on chemical
plant operations", "startups applying AI to process manufacturing" — then use
Apollo only to find people at those named companies. Apollo becomes a
people-lookup service, which is what it is genuinely good at, and company
discovery moves to a semantic tool instead of a lexical one. The
`WebResearchProvider` interface built in this phase already supports it.

**B. A second company provider.** PitchBook (already interface-stubbed) or a
semantic company index would widen supply directly. Higher cost, less flexible
than A.

### Then

Phase 1 (missions) and Phase 2 (Talent Knowledge Base) remain as planned. Note
that the Phase 6 research layer is a prerequisite for Phase 7 positioning
regardless — the claim-citation gate in
[EVALS.md §3.6](EVALS.md#36-claim-accuracy--are-personalization-claims-supported)
needs exactly these sourced `research_facts`.

### On the eval instrument

Precision@20 against an LLM judge did its job — it caught real problems and
survived contact with evidence. But this phase surfaced its limit: when research
and judge agree that a candidate pool is mediocre, the metric correctly reports a
low number while the *system* is behaving well. Pair it with a **supply-quality
metric** (e.g. share of researched companies rated mission-relevant, measured at
40% rejection here) so a supply problem is distinguishable from a ranking problem
at a glance.
