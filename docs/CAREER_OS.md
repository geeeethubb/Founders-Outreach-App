# Career OS — architecture note

> Status: **built and live-verified against the founder's database (2026-08-28)** · Extends Outreach OS into a job search + application package system.
> Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [AGENTS.md](AGENTS.md) ·
> [AGENT_RUNTIME.md](AGENT_RUNTIME.md) · [DATA_MODEL.md](DATA_MODEL.md) · [EVALS.md](EVALS.md)

This is the note written before the build, then kept current as it lands. It records what the
audit of the existing system found, what is reused, what is new, and the decisions that shape
the new code. Read it before touching anything under `lib/career/`, `lib/agents/*` added for
Career OS, `app/dashboard/{jobs,applications,companies,evidence}` or `app/api/career/`.

---

## 1. What the audit found — and what is reused

Outreach OS already has most of the machinery a job-search system needs. Nothing below is
rebuilt; it is extended.

| Existing capability | Where | How Career OS uses it |
|---|---|---|
| Bounded agent tool loop — `submit_result` is the only exit, output validated at the boundary, evidence pool harvested from real retrievals, invalid output retried then escalated, truncation handled | `lib/agents/runtime/loop.ts` | **Every** Career OS agent runs on it. No second runtime. |
| Single-shot structured calls with retry + content-addressed cache | `anthropicStructured` in `lib/providers/anthropic/client.ts` | Cheap classification (JD extraction, verifier on ambiguous pages), eval judges |
| Model tiers `cheap / standard / premium`, env-overridable, cost accounting per call and per tier, web-search billing | `lib/ai/models.ts`, anthropic client | Unchanged. Judgment-heavy agents (fit, tailor, verifier, letter) run `standard`; the fact verifier may escalate to `premium` on failure only. |
| Agent observability — `agent_runs` rows with prompt version, model, tools, tokens, cost, latency | `lib/agents/runtime/persist.ts`, migration 011 | Reused verbatim. `scouting_runs` gains a `kind` column so job-scout and package runs attach traces exactly like outreach runs do. |
| Grounded research facts with a DB constraint (`FACT` requires `source_url`) | `research_facts`, ADR-006 | Company research for jobs writes here, keyed by `company_id`. The cover letter's company claims must resolve to these rows. |
| Deterministic claim-safety gate (quantities, entities, superlatives, responsibility) | `lib/outreach/grounding.ts`, ADR-023 | The same instrument, pointed at résumé bullets and cover-letter text with an evidence pool built from the Evidence Bank. |
| Companies as a first-class entity with domain dedupe | `companies`, migration 010 | Extended with careers URL, ATS identity and a watchlist status. No parallel "target companies" table. |
| Contact index + ranked search + relationship history | `contact_index`, `search_contact_index()`, `lib/network/*` | Warm-path finding searches this. Nothing new is indexed. |
| Provider cache on disk, successes only | `lib/providers/cache.ts` | ATS board listings, page fetches and every agent result are cached by entity key so iteration is free. |
| Manual, idempotent migrations checked by `npm run check:sql` | `supabase/migrations/`, `scripts/check-sql.ts` | Migration `014_career_os.sql` follows the pattern exactly. |
| The eval style — deterministic checks first, an **independent** judge second, thresholds that are never weakened to pass | `evals/agentic/judge.ts`, `evals/phase6/checks.ts` | `evals/career/*` copies the shape. |
| UI language — Tailwind, slate/indigo, dense cards, inline expand, client pages fetching route handlers | `app/dashboard/scout/page.tsx` | New pages follow it; no component library is introduced. |

**What did not exist and is new:** a structured, provenance-carrying model of the user
(Outreach OS still reads a hand-written fixture, `evals/phase3/user-profile.ts`); anything
about jobs, ATSs, postings, freshness, deduplication of postings, fit scoring for *roles*;
résumé tailoring; document generation; an application tracker.

**What is deliberately not touched:** `lib/email/*`, OAuth, crypto, RLS patterns, the
outreach state machine. Career OS hands an approved opportunity to Outreach OS for messages;
it does not send anything itself.

---

## 2. The workflow, as built

```
JOB MISSION (editable preferences, weights, an optional DIRECTION in the user's words)
  → MISSION PLANNER            agent · role families from the DIRECTION (evidence argues credibility) or,
                                       without one, inferred from the Evidence Bank; search strategies,
                                       seed target companies, adjacency rules
  → DISCOVER                   agent session (job-first, web) + deterministic (company-first, ATS APIs)
  → NORMALIZE                  code · title→role family, location→city/state/tier, season, employment type
  → EXTRACT                    cheap agent · JD → qualifications, eligibility, work auth, skills (cached by hash)
  → DEDUPLICATE                code · canonical cluster; first-party/ATS record wins
  → VERIFY                     code · ATS API / canonical page; agent only for ambiguous page text
  → FIT                        agent · 11 component scores + eligibility verdict; code computes the total
  → RESEARCH                   agent · company research with sourced FACTs (one per company, cached)
  → MATCH EVIDENCE             agent · which experiences/facts/metrics/skills matter for THIS job
  → WARM PATHS                 code retrieves · cheap agent judges strength / why / action
  ─────────────────────────── human: Generate Package ───────────────────────────
  → TAILOR                     agent · minimal résumé patch, edit levels 0–4, fact ids on every change
  → FACT-VERIFY                independent agent + deterministic pre-checks · clause-level verdicts
  → HUMAN REVIEW (diff)        approve / reject / edit / approve-all-safe
  → GENERATE DOCUMENTS         code · DOCX from the master template, PDF via Word (LibreOffice fallback)
  → COVER LETTER               agent · growth narrative; every company claim → research_facts row
  → DOCUMENT QA                code · opens, one page, no overflow, fonts, filenames, content match
  → READY FOR REVIEW → READY TO APPLY → (human applies) → APPLIED → OA … OFFER / REJECTED
  → OUTCOME + FEEDBACK         stored; ranking reads explicit feedback; no ML
```

The mission's `preferences.direction` is what the user wants to scout for, in their own words ("life
sciences / genomics research — my chemical engineering background transfers"); `renderMission()` puts it
first, so it leads the planner's role families, strategies and seed companies, and the Fit Evaluator
judges `role_fit` and `mission_interest_fit` as transferability toward it rather than as a match to past
titles. Where it disagrees with the default company types it takes precedence (they are relabelled as
examples); when it is empty every agent behaves exactly as before, inferring from the evidence. The
`--direction` flag on `npm run career:scout` overrides it for one run without saving it — for the plan,
retrieval and fallback strategies only; that run skips post-scout ranking (and says so), because fit
rows persist against the saved mission and would otherwise be judged against a direction nobody saved.
A fit row records the direction it was judged toward (`prompt_version` is `<version>+direction.<sha>`
when one is set), so saving or editing the direction invalidates every stored rank: the next rank —
post-scout or **Re-rank** — re-evaluates each job at cost, exactly as a prompt bump would.

Two loops feed back deliberately and narrowly:

- **Feedback → ranking.** `LOVE / INTERESTED / MAYBE / NOT_INTERESTED` with reasons adjusts
  soft preferences (never hard constraints) through a bounded, inspectable modifier.
- **Two-page résumé → shrink.** If the tailored résumé spills to page 2, code retries by
  restoring shorter approved phrasing and dropping the lowest-value addition. Never fonts,
  never margins.

---

## 3. Agents added, each against the AGENTS.md test

The test is unchanged: *a judgment problem no existing agent owns.* Deterministic work stays
in code. Twelve pass; three candidates were rejected.

| Agent | Judgment it owns | Tier | Searches |
|---|---|---|---|
| **Job Mission Planner** | "What roles could this person plausibly do, where would they be posted, and which companies are worth watching before they post?" — role taxonomy is *inferred* from the Evidence Bank, not hard-coded | standard | ≤3 |
| **Job Scout** | "Is this search surface productive, what is it returning, and what should I try next?" — a multi-round session with bounded tools (web search, ATS board lookup, page fetch); the same shape as Market Discovery | standard | ≤4/round |
| **Job Extractor** | "What does this posting actually require, and is it a Summer 2027 internship?" — interpretation of unstructured JD text into structured fields | cheap | no |
| **Job Verifier** | "Does this page say the job is still open?" — only for pages where deterministic signals are ambiguous; ATS APIs and explicit closed banners never reach it | cheap | no |
| **Company Researcher** | "What is genuinely interesting about this company for an intern — the problems, the technology, the people — and what is the evidence?" Serves both fit and the cover letter, so it runs once per company | standard | ≤5 |
| **Fit Evaluator** | "Along eleven dimensions, how does this job fit this person?" Emits components + eligibility verdict; never a total | standard | no |
| **Evidence Matcher** | "Which 1–3 experiences, which facts, which metrics make this person interesting for THIS job, and what must not be claimed?" | standard | no |
| **Network Pathfinder** | "Of these contacts with a plausible connection to this company, who is a real warm path, how strong, and what is the right ask?" Candidates are retrieved by code | cheap | no (one internal tool) |
| **Resume Tailor** | "What, if anything, should change on this résumé for this job, and at what edit level?" | standard | no |
| **Resume Fact Verifier** | "Is every factual clause in this proposed bullet supported by the Evidence Bank?" Independent of the tailor by construction: different prompt, different input framing, never sees the tailor's reasoning | standard, escalates to premium on failure | no |
| **Cover Letter Writer** | "Say why this company, this person, and growth — specifically, briefly, and only with claims that resolve" | standard (writing role) | no |
| **Resume Importer** | "Which atomic facts, metrics and skills does this résumé text actually assert, and to which experience does each belong?" — proposes; the human approves | standard | no |

**Rejected candidates.**

- *Document QA agent.* Page count, overflow, fonts, filenames and content match are all
  measurable. A model asked "does this look right?" would be less reliable than `pdfjs`
  counting pages. Deterministic code, with the results shown to the human.
- *Cover Letter Researcher* as a separate agent. It would ask the Company Researcher's exact
  question with a different framing and pay for the answer twice. One researcher, deeper
  output, cached per company.
- *Deduplicator / Freshness agent.* Clustering on company + normalized title + location +
  requisition id + description similarity is arithmetic. Verification is an HTTP call and a
  string match, and it is exactly the kind of thing that must be reproducible.

Rules carried over unchanged: agents never touch the database, never call each other, always
declare a schema, always own a versioned prompt, and every run writes an `agent_runs` row.

---

## 4. Data model

Migration: `supabase/migrations/014_career_os.sql`. All additive, all idempotent, RLS on every
table in the existing pattern. Full column lists live in the migration; this is the shape.

### The Personal Evidence Bank

```
evidence_experiences    organization · title · dates · location · kind · approved
  └─ evidence_facts     statement · category · source · source_location · confidence · approved
       ├─ evidence_metrics       value · unit · context · fact_ids[]
       ├─ evidence_deliverables  description · fact_ids[]
       ├─ evidence_skills        name · evidence_fact_ids[]
       └─ evidence_stories       situation · task · actions · result · learning · evidence_fact_ids[]
resume_documents        the master DOCX (and alternates), hashed, with a paragraph map
resume_bullets          one per bullet in a résumé document · experience_id · evidence_fact_ids[] · approved
evidence_preferences    category · value · weight · hard_constraint
```

**Provenance is a column, not a convention.** Every fact carries `source` and
`source_location`. Every bullet carries the fact ids it rests on. A tailored bullet that
cannot cite fact ids is rejected by validation before any verifier runs — the same move as
`fact_requires_source`.

**Approval is a column too.** Imported material lands `approved = false` and is not usable
by the tailor until the human approves it. The Evidence page exists for that.

### The canonical view and the Review tab (migration 015)

`supabase/migrations/015_evidence_canonical.sql` adds organizations, projects, source
records, per-fact/per-experience provenance rows, merge suggestions, conflicts and
snapshots. The Evidence page reads it through two tabs and three routes; all of them run
on a 014-only database and say `migration015: false` instead of failing.

| Route | Does |
|---|---|
| `GET /api/career/evidence/canonical` | Bank grouped by organization (`organization_id`, else `normalizeOrg`), tombstones out, pending rows badged; key facts from `summary_fact_ids` or category rank + support; source chips per fact |
| `GET /api/career/evidence/review` | `buildConsolidationPlan` over approved + pending rows, kept-separate pairs suppressed, open `evidence_conflicts` |
| `POST /api/career/evidence/review` | `merge` (POSSIBLE needs `allowPossible`), `keep_separate`, `merge_all_high` (HIGH only, `backfill: false`), `resolve_conflict`; 400 before 015 |
| `POST /api/career/evidence/consolidate` | `{dryRun:true}` → plan + report text; `{dryRun:false}` → HIGH apply with the bank-wide backfill; 400 before 015 |

**Canonical** is the first tab: organizations → roles → projects, key facts, metrics.
Read-only; edits live on Experiences. **Review (N)** lists HIGH / POSSIBLE / CONFLICT
cards as KEEP vs MERGE with Why · Data preserved · Risk; CONFLICT cards have no Merge
button, only Keep separate and the candidate values.

**What no button applies unattended.** `app/api/career/evidence/review/guard.ts` demotes
a HIGH experience pair to POSSIBLE when the merge side was `edited_by_user`, or when the
organizations differ by a qualifier and neither row has parsed dates (two labs named by
PI surname, one row without a qualifier, two plant sites). The card then needs a person;
`signals.downgraded` says why. Merges are tombstones (`status='merged'`,
`merged_into`), never deletes, and every apply writes an `evidence_snapshots` row first.

### Jobs

```
companies               (existing) + careers_url · ats_type · ats_identifier · watch_status · watch_priority
job_opportunities       the normalized record; verification_status; duplicate_cluster_id; is_canonical
  ├─ job_sources        every place the same posting was seen, with raw payloads
  ├─ job_snapshots      the description as it was — an application points at one forever
  ├─ job_fit_evaluations  components · weights_used · overall · eligibility · uncertainties · red flags
  ├─ job_evidence_maps  the Evidence Matcher's output, by fact ids
  ├─ warm_paths         contact_id · relationship · strength · why · suggested action
  └─ job_feedback       LOVE / INTERESTED / MAYBE / NOT_INTERESTED + reasons
career_missions         objective · season · preferences (geo tiers, company types…) · hard constraints · fit weights
scouting_runs           (existing) + kind ('outreach' | 'job_scout' | 'package') + career_mission_id
```

`duplicate_cluster_id` groups postings of the same job; exactly one row per cluster is
`is_canonical`, and the first-party/ATS record wins. The UI shows one job.

### Applications and packages

```
applications            state machine · job_snapshot_id · locked after APPLIED
  ├─ application_events  every transition with actor
  └─ application_packages  versioned · resume/cover paths · qa · snapshots of research, fit, evidence map
       ├─ resume_patches → resume_patch_changes   one row per change, with edit level, fact ids, verifier verdict
       └─ cover_letters                            paragraphs · claim map · grounding result
```

**Immutability after submission.** `applications.locked = true` is set when the state reaches
`APPLIED`. A locked application's package is `locked` too; a later redo creates a new version
and never overwrites the files that were submitted. Storage paths carry the package version, so
nothing can be written over.

**Redo.** "Redo package (new version)" on the job's Package tab (and "Redo package" on every
Applications row, which opens that tab with the confirm box) calls
`POST /api/career/packages/[id]/redo` → `lib/career/package/redo.ts` `redoPackage`: the normal
generate path for the job — intelligence reused when fresh, the résumé re-tailored, stop at
review — as version N+1. The old version becomes `superseded` unless it is `locked`, in which
case it stays exactly as submitted with the new version beside it. "Redo letter only" on the
letter panel rewrites just the letter for the current package. `clonePackageVersion` is the
no-model sibling: version N+1 carrying the old package's reviewed résumé patch and snapshots,
which `finishPackage({ letterFromStored })` then renders without calling the writer.

**The applicant's name.** `profiles.name` is the email local-part for anyone the signup
trigger named (`coalesce(full_name, split_part(email,'@',1))`), and the first live letter was
greeted and signed "zuyu.alex06". Every letter, sign-off and document header now resolves the
name through `lib/career/identity.ts` `resolveApplicantName`: profile name when it looks like a
person's name → the master résumé's name line → an approved education fact → `OUTREACH_SENDER_NAME`
→ `Applicant`. An email-like name (a token with a dot or digits, or anything with `@`) can never
be printed: `assembleLetter`, `buildLetterDocuments` and `buildCoverLetterDocx` each refuse one
at their own boundary. The outreach loop's `resolveSenderFrom` uses the same resolver.
`npm run career:fix-names [-- --dry-run]` repairs letters written before this: it rewrites
the email-like tokens in every `cover_letters` text column and, for the current letter of a
locked or ready package, renders a new package version from the corrected text.

---

## 5. Discovery

Two complementary strategies, both bounded:

- **Job-first.** The Job Scout runs a session per strategy from the Mission Planner. Its tools:
  Anthropic `web_search` (server-side, as everywhere else), `lookup_ats_board` (deterministic:
  detect the ATS for a company and list matching postings), `fetch_page` (bounded, robots-aware,
  text-only). It submits found postings with source URLs, a diagnosis of the surface and a next
  action, round after round, until it accepts, rejects the strategy, or hits the budget.
- **Company-first.** For every company on the watchlist and every seed company the planner
  names, code detects the ATS and lists internships. No agent. This is what makes "watching for
  an opening" possible: a company with no posting today is re-checked on the next run and on a
  schedule.

**Source adapters** implement one interface (`lib/career/sources/types.ts`): Greenhouse, Lever,
Ashby, SmartRecruiters and Workable public job-board APIs; a careers-page fetcher that detects
ATS links; and the web-search surface. Aggregators are treated as *leads*: an aggregator URL is
resolved to the canonical ATS/careers posting before it is stored as canonical.

**What is refused, structurally.** No login flows, no CAPTCHA handling, no `robots.txt`
bypass, no scraping of LinkedIn/Indeed/Handshake pages. The fetcher checks robots, identifies
itself, caps size and rate, and only reads public pages. Job platforms that require a session
are documented as manual-entry sources (the user pastes a URL; the system resolves and verifies
it).

**Freshness** is a verification status with a timestamp, never a boolean:
`UNVERIFIED → VERIFIED_OPEN | LIKELY_OPEN | STALE | CLOSED | ERROR`. ATS API presence is
`VERIFIED_OPEN`; a 200 careers page containing the title is `LIKELY_OPEN`; explicit closed
language or a 404 is `CLOSED`; unconfirmed for longer than the staleness window is `STALE`.
Saved and applied-to jobs are re-checked by `npm run career:verify` and by the cron route.

---

## 6. Fit

Eleven dimensions, weights editable per mission, arithmetic in code (ADR-004):

`role_fit · learning_upside · ownership · company_quality · mission_interest_fit · location_fit ·
career_optionality · people_mentorship · differentiation · application_urgency` plus
**eligibility**, which is a verdict (`QUALIFIED | STRETCH | NOT_QUALIFIED`), not a weight — a
job the user cannot apply to is flagged, not down-weighted. `STRETCH` is first-class: missing
preferred qualifications is not disqualification.

The agent sees the job, the company research, and a *shortlist* of Evidence Bank summaries —
never the whole bank (principle 5). It emits components with explanation and evidence,
uncertainties, red flags and missing qualifications. It never sees the weights.

**Gates, added by the fit eval.** The weighted mean alone ranked "a great job you cannot have"
above real options — a Summer 2026 posting scored 0.70 while `NOT_QUALIFIED`. Three deterministic
gates now sit between the components and the number, applied identically at evaluation time, on
every re-sum and in the eval: `NOT_QUALIFIED` halves the mean; a failed mission hard constraint
multiplies by 0.6 **and caps at 0.30** (a job that fails a mission rule can never leave the WEAK
band); `role_fit` below 0.35 scales the mean proportionally, because location 0.9 + company 0.7
+ ownership 0.75 were lifting software roles level with real process roles. `base_overall` keeps
the ungated mean and `gates` lists what applied. The model still only judges (ADR-004).

Explicit feedback adjusts ranking through `lib/career/fit/feedback.ts`: a small, bounded,
logged modifier derived from reasons (e.g. three `NOT_INTERESTED: too software-heavy` verdicts
lower `role_fit` for software-only role families by a capped amount). Hard preferences are never
altered by feedback.

---

## 7. Résumé tailoring and the two-agent guarantee

The tailor and the verifier are separate agents with separate prompts, and the verifier never
sees the tailor's reasoning — only the proposed text, the original, and the evidence for that
experience. Between them sit deterministic checks that do not need a model at all:

1. **Fact-id validation.** Every change must cite `evidence_fact_ids` that exist, are approved,
   and belong to the same experience as the bullet. Otherwise the change is rejected at the
   schema boundary.
2. **Quantity and entity check** (`lib/outreach/grounding.ts`, re-pointed). Every number,
   percentage, dollar amount, multiplier, acronym and proper noun in the proposed text must
   appear in the experience's evidence pool. A number that appears nowhere is a fabrication by
   construction and never reaches the verifier.
3. **Title lock.** Experience titles, organizations and dates are not editable by the tailor.
4. **Edit-level rules.** Level 3 must name an approved alternate bullet; Level 4 must cite at
   least two facts from one experience and is verified at a stricter threshold.

The verifier then judges each **atomic clause** — `SUPPORTED | UNSUPPORTED | UNCERTAIN` with
supporting fact ids — and the bullet passes only if every clause is `SUPPORTED`. On
`UNCERTAIN` the original is kept, and the UI says so. The minimum-edit objective is enforced by
measuring: each patch records a semantic-distance score and the eval fails a run that rewrites
more than it needed to.

---

## 8. Documents

- **Résumé.** The master DOCX is the template. `lib/career/documents/docx.ts` opens it with
  JSZip, maps each bullet paragraph to a `resume_bullets` row by paragraph index, and applies
  the approved patch by replacing runs *inside* the existing paragraph — paragraph properties,
  numbering, fonts and sizes are inherited, and bold spans that survive the edit verbatim are
  re-applied. Reordering moves whole `<w:p>` elements. Nothing is reconstructed.
- **Cover letter.** Generated with the `docx` library: Times New Roman 12 pt, 1" margins, 1.15
  line spacing, 6 pt after paragraphs, business-letter structure.
- **PDF.** `PdfRenderer` adapters, chosen by availability: Microsoft Word via COM (present on
  this machine, highest fidelity), LibreOffice `soffice --convert-to pdf` when installed. If
  neither exists the DOCX is still produced and QA reports the PDF as unavailable — an honest
  degraded state, not a low-fidelity fake.
- **QA** (`lib/career/documents/qa.ts`): DOCX is a valid package with well-formed XML; PDF
  opens; page count equals the master's (one); every approved bullet's text is present in the
  extracted PDF text; no paragraph is empty; only the template's fonts appear; filenames match
  `Zuyu_Liu_<Company>_Resume.{docx,pdf}` with the company name sanitized.
- **Storage.** Supabase Storage bucket `career-docs`, paths keyed by package version. A local
  mirror under `.career-out/` for scripts and evals.

---

## 9. Evals — `evals/career/`

| Suite | What it measures | Target |
|---|---|---|
| `discovery` | P@20 on a benchmark of known companies/boards; duplicate rate; closed-shown-as-open; canonical URL accuracy; location and internship classification | P@20 ≥ 80% · stale shown open < 3% · dupes < 3% · canonical ≥ 95% |
| `fit` | three Summer 2027 missions over a fixed JD set with planted negatives; rank order and eligibility verdicts; judge on top-k | negatives never in top-k; eligibility correct |
| `factuality` | adversarial JDs asking for things the bank does not contain; plus fabricated bullets fed straight to the verifier | unsupported claims in output = **0**; verifier catches every planted fabrication |
| `minimal-edit` | matched role → few/zero changes; mismatched → small targeted changes; edit distance | measured, thresholds recorded |
| `documents` | long/short/odd company names, bullet lengths → valid DOCX/PDF, filenames, page count | 100% |
| `cover-letter` | specificity, truthfulness, growth narrative, non-repetition, no filler; deterministic claim grounding | grounding 100%; judge means recorded |

Every suite is a `tsx` script under `scripts/`, like the existing ones, and reports its own
numbers. Deterministic parts run without credentials on fixtures; judged parts need
`ANTHROPIC_API_KEY`.

---

### Measured (2026-08-27/28, no-database mode on the real master résumé)

| Suite | Result |
|---|---|
| discovery | duplicates 0% · canonical URL 100% · stale-shown-open 0% · tier at HQ 100% · P@20 85% / 70% / 70% across three runs, pooled 75% (pool-limited; P@10 90–100%) |
| fit | rank violations 0 · eligibility 95.8% · judge P@10 100% |
| factuality | unsupported claims in output 0 · planted fabrications caught 16/16 |
| minimal-edit | distance 0 on matched, mismatched and adversarial JDs |
| cover-letter | grounded 6/6 · one page 6/6 · banned phrases 0 |
| documents | 40/40 valid, one page, correctly named |

Full tables and the fixes each failure produced: [EVALS.md §13](EVALS.md#13-phase-11--career-os-evals),
[BUILD_LOG.md](BUILD_LOG.md).

---

## 10. Boundaries the code enforces

- Nothing submits an application. The final human action is a link.
- Nothing sends outreach. Warm paths hand off to the existing approval queue.
- No personal fact is written by a model without `approved = false` first.
- Every agent run is bounded (steps, searches, tokens, run call budget) and traced.
- Every generated document is versioned and never overwritten after submission.
