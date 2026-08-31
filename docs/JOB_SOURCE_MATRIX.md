# Job source matrix

> Candidate sources for Job Discovery V2, with what was actually verified and
> what was not. Companion to [JOB_DISCOVERY_V2_AUDIT.md](JOB_DISCOVERY_V2_AUDIT.md).
> Verified entries were fetched live on **2026-08-31**; anything unverified says
> so rather than guessing. Principle: **a portfolio of independent sources**,
> each optional behind an env var, so the app runs with none and improves with
> each one added.

## Shipped status — 2026-08-31

This document is the research record: what was probed, and what the probe found. What is
now **wired into `discoveryRegistry()`** is narrower and is listed here so the two are never
confused.

| | Sources |
|---|---|
| **ATS, free, no key (12)** | greenhouse · lever · ashby · smartrecruiters · workable · workday · **oracle-orc** · **taleo** · **recruitee** · **gem** · **teamtailor** · **personio** |
| **Feed, free (1)** | simplify |
| **Search, paid (1)** | dataforseo — *unconfigured*, needs `DATAFORSEO_LOGIN` |

The six in bold shipped in wave 2. **Oracle ORC was the biggest single unlock**, exactly as
this document predicted: the three boards the recall benchmark had recorded as unreadable
(Honeywell, Vertiv, CSX) all answered, and a free sweep of the Oracle tenants named by the
Simplify file returned 40 live internships across 46 employers.

Still unimplemented, and still honestly described below: **iCIMS** (sitemap + JSON-LD; tenant
subdomains unguessable), **Phenom**, **ADP**, **Eightfold**, **SuccessFactors**. Endpoint
detail for all of them is in [ATS_ENDPOINTS.md](ATS_ENDPOINTS.md).

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

## B. Paid job indexes — researched live 2026-08-31

The only legitimate route into the LinkedIn / Indeed / Glassdoor / ZipRecruiter
market is **Google Jobs**, which aggregates them, read through a SERP provider.
Google's own docs (updated 2025-12-18) confirm the job-search experience is alive
with no deprecation notice; the *hosted* "Google Jobs API" (Cloud Talent
Solution) died in 2021 — different things, routinely conflated.

**Three degradations to design around:** SerpApi's `chips` and `ltype` params
(the historical internship / employment-type filters) are marked *"deprecated by
Google"*; offset pagination (`start`) is discontinued in favour of tokens; and a
2026-03-30 Google layout change moved job descriptions into a separate request
per job.

### DataForSEO — the value winner, recommended
- **`employment_type` accepts `intern` as a first-class filter value** — the
  structured internship filter SerpApi has lost.
- **`depth` up to 200 results per task**, billed per 10-result page.
- **$0.0006 per 10 results** standard queue (up to 5 min), $0.0012 priority.
  200 results = **$0.012**; the same 200 on SerpApi Production = **$0.20**.
  Roughly **17x cheaper per result**. $50 minimum, pay-as-you-go.
- Results retained **30 days** and re-retrievable — the closest thing to storage
  permission found anywhere in this survey.
- **Terms** (updated 2026-06-12) 7.1: data must not be used *"to compete with or
  adversely affect the business interests of the search engine providers"*; 7.2
  the customer indemnifies DataForSEO. **No customer-facing indemnity.**
- Task-queued, not synchronous. Rate limits undocumented.
- Env: `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`.

### SerpApi — the risk-managed choice
- Best documentation; supports the `after:YYYY-MM-DD` query operator plus
  AND/OR/wildcards, which replaces the lost date filter.
- **10 results per page**, token pagination, no documented depth cap (assume
  ~100 until measured). Returns `description`, `apply_options[]`,
  `job_highlights`.
- Free 250/mo · Starter $25 to 1k · Developer $75 to 5k · **Production $150 to 15k**.
- **The only customer indemnification in this market**: a $2M "US Legal Shield"
  (ToS 13, updated 2026-04-08) — but it **excludes** Free, Starter and Developer,
  so it begins at $150/mo.
- **No storage or caching clause exists in their terms at all.** That is absence,
  not permission.
- **Google LLC v. SerpApi is live litigation.** Filed 2025-12-13 (DMCA 1201,
  ToS/robots); SerpApi's **motion to dismiss was granted 2026-07-20** (the DMCA
  does not protect uncopyrighted search results); Google filed an **amended
  complaint 2026-08-10** pivoting to licensed content. SerpApi is bootstrapped at
  ~$3M revenue against Google. **This is why the provider interface is mandatory
  rather than nice-to-have.**

### Bright Data — scale, and the strongest litigation record
- Jobs is a confirmed SERP vertical; proxy-based integration (`brd_json=1`).
- **5,000 free records/month** (best free tier here by 20x), then $1.5/1K
  pay-as-you-go, $499/mo for 380K. Unlimited concurrency on every tier.
- Won *Meta v. Bright Data* (summary judgment Jan 2024, dropped Feb 2024) and
  *X Corp v. Bright Data* (dismissed May 2024, partly revived Nov 2024).
- No compliance/KYC or indemnification language found on the SERP pages.

### Screened out — no Google Jobs vertical at all
**Serper.dev · Zenserp · Scale SERP · ValueSERP · HasData.** Scale SERP and
ValueSERP are one vendor (Traject Data / ScraperAPI). **Scrapingdog** has a jobs
endpoint but its documented response carries **no `description` and no
`job_id`**, and it still lists the deprecated `chips`/`ltype` params — stale
docs, and disqualifying for resume-to-posting matching.

### Also considered
- **Adzuna** — genuinely free (1,000 calls/mo) but **US coverage is weak**
  (strongest in UK/Western Europe), and an earlier pass read its terms as
  restrictive.
- **JSearch (RapidAPI)** — largely a **wrapper over Google Jobs** with a ~30%
  marketplace markup and a ~200-request free cap: paying a middleman for the
  same data.
- **USAJOBS API** — free, official, federal internships (Pathways). Not fetched;
  worth a look for a chemical engineer (DOE and the national labs).

## A-bis. More free, no-auth ATS endpoints worth adapting

**Twenty-three ATS platforms were probed live on 2026-08-31 — the full results,
with the exact endpoint, the response shape and the gotcha for each, are in
[ATS_ENDPOINTS.md](ATS_ENDPOINTS.md).** Headline: **thirteen** answer an
unauthenticated request, five of them returning the full description in one
call. Two widely-repeated write-ups are wrong — Taleo needs a `tz` header rather
than the CSRF dance everyone describes, and all three commonly-cited Phenom
endpoints 500 or 303. **Oracle ORC is the biggest single unlock for industrial
employers**: site discovery is itself public, and one probed tenant held 2,147
requisitions. Dayforce, JazzHR, ApplicantPro and Handshake are closed and are
not to be attempted.


Verified patterns (Cavuno, 2026-04-03) beyond the six already implemented:

| ATS | Endpoint | Auth |
|---|---|---|
| Recruitee | `GET https://{company}.recruitee.com/api/offers/` | none |
| Personio | `GET https://{company}.jobs.personio.de/xml?language=en` (XML) | none |

Plus the two families Simplify's canonical URLs revealed: **Oracle Fusion
recruiting** (`*.fa.*.oraclecloud.com`, 47 hits) and **iCIMS** (`*.icims.com`,
20) — both heavily used by large industrial employers, both currently unadapted.
Whether each exposes an unauthenticated listing endpoint is verification debt,
to be settled before an adapter is written.



## The unit economics that decide it

Google Jobs SERP providers return **10 results per request**, so cost per
*request* understates cost per *job* by 100x. Normalised to **$ per 1,000 jobs**:

| Provider | $ / 1,000 jobs | Internship filter | Notes |
|---|---|---|---|
| **DataForSEO** | **~$0.06** | **`employment_type: intern`** | 200 results/task, 30-day retention |
| Scrapingdog | ~$4.50 | none | no `description` or `job_id` in docs — disqualifying |
| Bright Data SERP | ~$15 | unverified | **5,000 requests/month free**; won *Meta* and *X Corp* |
| SearchApi.io | ~$25 | none | Bearer header; 100 free |
| SerpApi | ~$100 | `chips` deprecated | the only $2M indemnity, from $150/mo |
| **TheirStack** (aggregator, not SERP) | $6–$32 | **`employment_statuses_or: internship`** | billed **per job returned**; storage explicitly permitted |
| **ATS public APIs** | **$0** | Lever `commitment`; else title | canonical URL by construction |

DataForSEO is ~75x cheaper per job than the next usable SERP option and is the
only one with a real internship filter. That settles the paid slot.

## Two more providers worth knowing about

### TheirStack — the best filters, and a purpose clause to settle first
236M postings from 356k sources (job boards, ATS platforms, career pages);
`employment_statuses_or: "internship"`, regex title/description filters,
`property_exists_or: ["final_url"]` to require a resolved apply URL, and
**storage is explicitly permitted** — *"perpetual license to retain and continue
to use internally, after termination, all TheirStack data lawfully obtained"*.
$49/mo for 1,500 jobs down to $1.10/1,000 at volume, **billed per job returned**,
4 requests/second. Two cautions: their terms scope permitted use to
*"business-to-business sales, marketing, recruiting, or business development"* —
a consumer job-search app is none of those four, and that needs written
clarification before building on it — and their privacy policy says they source
by *"scanning the web… company LinkedIn site"*, so their rows inherit LinkedIn's
objections. Filterable away with `url_domain_or`.

### PredictLeads — the best legal posture, with an unverified middle
Crawls **company career pages and ATS integrations only** — no LinkedIn, no
Indeed, no Glassdoor. ~9.8M active openings, 1M+ found weekly, refreshed every
36 hours, and **up to 1,000 records per credit** ($40 minimum, $0.04/credit
falling to $0.002) — an order of magnitude cheaper per job than anything else
here. The apply URL is canonical by construction because the crawl target *is*
the employer's page. **But their docs would not render the query-parameter
tables, so whether an internship or date filter exists at all is unverified**,
and their public terms are a website ToS that bars "redistribute" rather than a
data licence. Worth a sales conversation; not a commitment.

## The LinkedIn question is settled: take none of it

- **Proxycurl is dead.** Sued by LinkedIn January 2025, settled, **shut down
  4 July 2025** at ~$10M ARR. Its founder's retrospective is the clearest
  statement of the risk: *"Legal does not mean safe"*, *"buying from vendors —
  the chain of custody doesn't cleanse exposure"*, and *"Do not build your
  company on LinkedIn data."*
- **LinkedIn v. ProAPIs** (filed October 2025) reportedly settled February 2026.
- LinkedIn's User Agreement §8.2 (effective 2025-11-03) reaches **downstream
  possession**, not just collection, and **survives account termination**.

Two suits in twelve months, both ending with the scraper gone. So: no LinkedIn
data, from any vendor, at any price — and where a broad aggregator mixes
LinkedIn-derived rows in, filter them out by source domain.

**Handshake** is closed to us: its EDU API is *"only allowed to Career Services
partners"*. **Built In** and **ZipRecruiter** publish no job-search API;
ZipRecruiter reaches us indirectly through Google Jobs.

## Cross-cutting facts that constrain every SERP provider

- **Google removed `&num=100` in September 2025.** Ten results per page is now
  the physical ceiling industry-wide, so any provider still advertising 100 per
  page has stale docs. DataForSEO's `depth: 200` is 20 internal pages, billed as
  20 SERPs — the arithmetic in this document already accounts for that.
- **Reddit, Inc. v. Perplexity AI, Oxylabs, AWMProxy and SerpApi** (S.D.N.Y.,
  filed October 2025) names SERP-scraping vendors as co-defendants for reselling
  Google-derived data — structurally the same activity as reading Google Jobs.
  Unresolved. Combined with *Google v. SerpApi*, the sensible posture is: treat
  every SERP vendor as replaceable, keep the free first-party ATS layer as the
  backbone, and never let one vendor define coverage.
- **Google Jobs itself is alive** (Google's structured-data docs, updated
  2025-12-18, list current regional availability). What died in 2021 was the
  hosted Cloud Talent Solution API; what died in 2024 was the *paid* Google Job
  Ads pilot. The organic surface `ibp=htl;jobs` still works.

### Additionally screened out after live docs review

- **Oxylabs** — marketing claims a Google Jobs vertical; **the developer docs
  contain no `google_jobs` source** (confirmed against their full docs corpus).
  The real mechanism is a generic Google-URL fetch plus **your own XPath against
  Google's rotating CSS class names**, with **no apply URL and no job description**
  extracted by their reference parser. Rendered results cost ~$1.25–1.35/1K and
  are capped at 13 rendered requests/second. Rejected: high maintenance, missing
  the two fields that matter most, and a co-defendant in the Reddit suit.
- **Scale SERP / ValueSERP** — no `jobs` search type at all, and the governing
  ScraperAPI terms (updated 2025-11-18) state products are *"intended to be used
  for personal purposes only"*. Rejected.
- **Zenserp** — no jobs endpoint, no jobs `tbm` value, and **no vendor-specific
  terms document could be found at all** (the marketplace terms defer to a
  "Vendor Terms" that is not published). Rejected.

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
| 1 | Recruitee + Personio adapters | two more free, no-auth ATS families | $0 |
| 2 | **DataForSEO Google Jobs** | `intern` filter, 200 results/task, **~$0.06 per 1,000 jobs** — ~75x cheaper than the next usable SERP option | $50 min, pennies per run |
| 3 | Oracle Fusion + iCIMS adapters | the ATS families large industrial employers actually run | $0 |
| 4 | SerpApi (optional second provider) | independent of DataForSEO, and the only $2M indemnity — but 17x the cost and live litigation | $150/mo if adopted |

Every paid source is optional: `isConfigured()` false without its env var, and a
run reports it as "not configured" rather than failing.

## Verification debt

1. SerpApi Google Jobs: pagination depth and result cap are undocumented, and
   **no storage/caching clause exists in its terms at all**.
2. DataForSEO: rate limits are undocumented, and whether a Live-mode Google
   Jobs endpoint exists (the docs show only task_post/task_get).
3. Whether Google Jobs results actually include Indeed today: SerpApi's docs
   example shows Indeed, while industry reporting says the two are
   competitors and not partners. Ten minutes on a free tier settles it.
4. Oracle Fusion / iCIMS / Taleo / SuccessFactors: is there an unauthenticated
   listing endpoint, and what is its shape?
5. Simplify: no licence file — confirm acceptable use before redistributing
   anything derived from it (reading it for personal search is the current use).
