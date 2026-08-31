# Résumé Tailoring V2 — queued workstream

> **Status: QUEUED. Not started.** Begins only after Job Discovery V2 wave 2 is
> finished, reviewed, committed, the recall and diversity benchmarks have run,
> `tsc` and the production build are clean, and a checkpoint commit exists.
> Discovery and tailoring changes must not share a commit.

## The objective, in the founder's words

> **MAXIMIZE ROLE RELEVANCE, SUBJECT TO 100% EVIDENCE-BACKED FACTUALITY.**

Two reversals from how the tailor was built:

1. **Minimal change is no longer the goal.** ADR-032 and the minimal-edit eval
   optimised for the smallest safe diff; the measured consequence is résumés
   that read as the master. Minimality was a proxy for safety, and the *actual*
   safety mechanism is the independent Fact Verifier, which stays exactly as it
   is.
2. **The master résumé is not the factual universe.** It is layout plus a good
   general-purpose starting version. The **canonical Evidence Bank is the
   factual universe.** An approved accomplishment that is relevant and absent
   from the master may be used, and a master bullet has no privilege merely
   because it is already in the DOCX.

Non-negotiable, unchanged: **unsupported factual clauses = 0**; every new or
materially rewritten bullet keeps its evidence ids; the independent Fact
Verifier is mandatory. **When tailoring quality and factuality conflict,
factuality wins** — then find another evidence-backed route to relevance.

## Step 1 — baseline before fixing anything

Run the *existing* pipeline over 8–10 **real, currently open** jobs from the
Jobs database (not synthetic JDs), spanning materially different hiring
arguments: chemical/process · manufacturing/operations · quality · materials/R&D ·
pharma/biotech process development · energy/industrial · industrial AI/automation ·
technical product/program · technical strategy · one surprising adjacent role.
Not five near-identical process jobs — the point is whether **one** Evidence
Bank can produce **different truthful** narratives.

Per job record: company · role · fit score · top 5 job themes · relevant
evidence available · master coverage · proposed changes · fact-verified changes ·
**actually applied** changes · final DOCX text hash · final PDF text hash ·
base↔final content difference.

**Locate where changes disappear. Do not guess.** The candidate root causes:

| | Hypothesis |
|---|---|
| A | Tailor proposes no changes |
| B | Tailor proposes, Fact Verifier rejects |
| C | Proposed + verified, but document generation fails to apply |
| D | Evidence Matcher does not retrieve the right material |
| E | The résumé representation cannot express swapping/reordering |
| F | The tailor prompt is too conservative |

The answer decides the fix. A prompt change that "feels better" is not evidence.

## Step 2 — a hiring argument before any patch

The tailor must first decide **what the hiring argument is**, then pick the top
3–5 experiences and the facts/metrics/deliverables that support it, and name
what current content is low value for it. Only then may it propose text. This
is what stops bullet-level edits that never change the story.

## Step 3 — role-theme coverage as the metric

Per job: 5–8 themes. For each — does the Evidence Bank support it? Is it strong
in the master? Is it strong in the tailored version? Count **only themes the
bank actually supports**. Report base coverage vs tailored coverage; tailoring
should materially improve it where truthful evidence allows.

## Transformations that count

Reordering · accomplishment swapping · evidence-backed rewriting · **adding a
verified accomplishment absent from the master** · dropping lower-value content ·
skill ordering, additions and removals · shifting emphasis inside one
experience · selecting different projects/deliverables.

**Not counted:** `used → leveraged`. No synonym churn. Twelve cosmetic edits are
worse than three meaningful swaps.

## Intensity, and the burden of proof for a no-op

`LOW` (master already matches) · **`STANDARD` (default)** · `HIGH` (career-adjacent
role where the bank has relevant evidence the general résumé under-plays).

A no-op is valid **only with a stated reason**: top role themes, current
coverage, the best available alternate evidence, and why none would materially
improve the résumé. *"No safe changes found"* is insufficient when useful
approved evidence exists. **A high no-op rate is suspicious, not reassuring.**

## The end-to-end guarantee

For every approved change, verify it exists **in the final DOCX and in the final
PDF**. If the tailor reports "4 changes applied" and the PDF carries master
text, **fail the package** — do not mark it READY FOR REVIEW. Conversely,
verify no rejected or unsupported change appears.

## The central acceptance test

Same master, same Evidence Bank, three archetypes — **process/chemical**,
**industrial AI/automation**, **technical strategy/product**. The PDFs must
remain clearly the same person while making **different hiring arguments**. If
strong evidence exists for those themes and the three PDFs are effectively
identical, that is a **FAIL**. Across ten résumés, if they cluster as one
document with wording variation, that is a **FAIL**; jobs falling into 3–5
archetypes should produce corresponding emphasis groups. Two genuinely similar
jobs are allowed to produce similar résumés.

## Measured per résumé

Unchanged / reordered / rewritten / swapped / new evidence-backed / removed
bullets · skill changes · content-selection delta · role-theme coverage delta ·
semantic emphasis delta. **Do not optimise raw edit count.**

## Formatting constraints hold

One page where the master is one page · fonts and margins intact · no clipping,
overflow, malformed bullets, missing dates or missing contact details · no
duplicate bullets · correct filenames. If stronger tailoring overflows, **drop
the lowest-value content for that job** — do not shrink fonts aggressively.

## Package UI

```
TAILORED FOR   Process Engineering
Hiring argument  Plant + process + quality engineer
Role themes supported  5 / 6
Master coverage  58%      Tailored coverage  92%
Meaningful changes  3 reordered · 2 rewritten · 1 swapped · skills reprioritised
Unsupported claims  0
```
Evidence and patches stay expandable beneath.

## Final acceptance report

Jobs tested · no-op rate · average meaningful changes per résumé · base vs
tailored role-theme coverage · fact-verification pass rate · **unsupported
claims (target 0)** · **DOCX application failures (target 0)** · **PDF
application failures (target 0)** · role-archetype differentiation · and the
**root cause of the old near-no-op behaviour**.

> Tailoring is fixed only when the **final generated PDFs** show stronger,
> job-specific emphasis while remaining fully evidence-backed. Not when the
> prompt changed.
