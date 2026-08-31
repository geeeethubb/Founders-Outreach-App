# Job source matrix

> Candidate sources for Job Discovery V2, with what was actually verified and
> what was not. Companion to [JOB_DISCOVERY_V2_AUDIT.md](JOB_DISCOVERY_V2_AUDIT.md).
> Verified entries were fetched live on **2026-08-31**; anything unverified says
> so rather than guessing. Principle: **a portfolio of independent sources**,
> each optional behind an env var, so the app runs with none and improves with
> each one added.

## The finding that should shape the portfolio

The obvious free source — the SimplifyJobs / Pitt CSC Summer 2027 list — is a
**software/AI/quant list**, and this founder is a **chemical engineer**.
Measured from the real file:

| Simplify `Summer2027-Internships` | count |
|---|---|
| Total listings in the file | 14,964 |
| Active **and** visible | 2,284 |
| Active **and** term = Summer 2027 | **775** |
| …of those, category AI/ML/Data · Software · Quant · Product · Hardware | 281 · 242 · 115 · 72 · 63 |
| …of those, **chemical / process / materials / manufacturing-adjacent titles** | **5** |
| Unique companies among active Summer 2027 | 207 |

Integrating it is still right — it is free, refreshed daily (newest posting seen
`2026-08-31T14:35Z`), and its `url` is the **canonical employer ATS link** — but
it cannot be the answer to this founder's recall problem. Chemical-engineering
internship recall has to come from **broad ATS coverage of industrial employers**
plus **a paid job index**, not from a curated SWE list.

## A. Free, verified

### SimplifyJobs / Pitt CSC — Summer 2027 ✅ verified, implement
- **Fetch**: `https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json` — HTTP 200, 11.2 MB, one JSON array.
- **Schema** (every field present on all 14,964 records):
  `source · category · company_name · id · title · active · terms[] · date_updated (unix) · date_posted (unix) · url · locations[] · company_url · is_visible · sponsorship · degrees[]`
- **Closed listings** are `active: false` (12,680 of them); `is_visible: false` appears once — treat either as not-open.
- **Season** is `terms[]` (`"Summer 2027"`, `"Fall 2026"`, …), so filtering is exact rather than inferred.
- **Canonical URLs** are first-party: greenhouse 65, ashby 21, iCIMS 20, Workday (`*.myworkdayjobs.com`) 34+, Oracle Fusion (`*.fa.us2.oraclecloud.com`) 47, plus employer sites. Excellent dedupe keys and a free way to discover new ATS tenants.
- **Cost** none. **Terms**: public GitHub repository; no licence file is declared in the repo root, so treat it as source-available data to read, not to redistribute.
- **Verdict: implement as a pull feed.** Cheap, fresh, high volume, and its canonical URLs seed the ATS adapters. Expect ~5 directly relevant postings for this founder and hundreds of AI/manufacturing-adjacent ones.

### First-party ATS APIs ✅ already implemented
Greenhouse · Lever · Ashby · SmartRecruiters · Workable · **Workday** (added
2026-08-31; 18 of 91 boards in a live sweep). Free, unauthenticated, canonical,
full descriptions. These remain the backbone.

### ATS families seen in the wild but **not yet adapted**
From the Simplify canonical hosts and the founder's own watchlist failures:
**Oracle Fusion recruiting** (`*.fa.*.oraclecloud.com`, 47 hits — used by large
industrials), **iCIMS** (`*.icims.com`, 20), Taleo, SuccessFactors. Each is a
concrete, testable adapter and each unlocks employers a chemical engineer wants.
*Not yet verified whether each exposes an unauthenticated JSON endpoint — that
verification is the first task of the adapter work, before any code.*

## B. Paid — partially verified

### SerpApi (Google Jobs engine) ⚠️ pricing verified, terms not
- **Pricing verified live** on `serpapi.com/pricing`: Free **250 searches/mo**;
  Starter **$25/mo → 1,000**; Developer **$75/mo → 5,000**; Production
  **$150/mo → 15,000**; Big Data **$275/mo → 30,000**.
- **Why it matters**: Google Jobs aggregates LinkedIn, Indeed, employer sites and
  many boards, so one legitimate API reaches markets this app cannot otherwise
  touch — without scraping any of them.
- **Not yet verified**: the Google Jobs engine's exact pagination depth and
  result cap per query, freshness, and — most importantly — whether the terms
  permit **storing** results. Verify before spending.
- **Env var**: `SERPAPI_KEY`. **Budgeting**: at $75/mo → 5,000 searches, a broad
  run using ~200 queries costs ≈ $3.

### Adzuna ❌ likely rejected
A partial research pass reported Adzuna's current terms as **restrictive** for
this use. Not adopted without re-reading the terms in full.

### Careerjet ⚠️ candidate
Supports `locale_code=en_US`; a partner API exists. Pricing/terms unverified.

### Unverified, still worth evaluating
JSearch (RapidAPI) · Jooble · Coresignal · Techmap · Mantiks · Bright Data ·
DataForSEO. **Four separate research agents stalled** while fetching these, so
none is recorded as verified here. They are deliberately left as gaps rather
than filled with guesses.

## C. Explicitly out of scope

Direct scraping of LinkedIn, Indeed, Glassdoor, ZipRecruiter or Handshake.
Coverage of those markets must come through Google Jobs / a licensed provider /
indexed search results followed by canonical-page verification — never by
bypassing authentication, CAPTCHAs, robots.txt or platform protections.

## Recommended portfolio

| Tier | Source | Why | Cost |
|---|---|---|---|
| 1 | ATS adapters (6 today → + Oracle Fusion, iCIMS) | canonical, free, full descriptions, the backbone for industrial employers | $0 |
| 1 | Simplify Summer 2027 feed | free, daily, 775 active S2027 postings, canonical URLs that seed ATS tenants | $0 |
| 1 | Company-first sweep (Targets/Watching) | early sight of postings before they are indexed | $0 |
| 2 | SerpApi Google Jobs | the only verified-pricing route to LinkedIn/Indeed-surfaced postings | $25–75/mo |
| 3 | A second independent job API | provider diversity so no single vendor defines coverage | TBD |

Every paid source is optional: `isConfigured()` false without its env var, and a
run reports it as "not configured" rather than failing.

## Verification debt

1. SerpApi Google Jobs: pagination depth, result cap, freshness, **storage terms**.
2. Oracle Fusion / iCIMS / Taleo / SuccessFactors: is there an unauthenticated
   listing endpoint, and what is its shape?
3. Every provider in "unverified" above.
4. Simplify: no licence file — confirm acceptable use before redistributing
   anything derived from it (reading it for personal search is the current use).
