# ATS endpoints — what is actually public, probed live

> Every "yes" below was confirmed by a live HTTP request on **2026-08-31**, not
> read off a blog. Where a widely-repeated write-up turned out to be wrong, the
> correction is stated. Companion to [JOB_SOURCE_MATRIX.md](JOB_SOURCE_MATRIX.md)
> and [JOB_DISCOVERY_V2_AUDIT.md](JOB_DISCOVERY_V2_AUDIT.md).
>
> **Why this document is the centre of Job Discovery V2 for this founder.**
> Simplify is a software list (5 chemical-engineering postings out of 775).
> Google Jobs costs money and returns 10 results a request. But Merck, DuPont,
> Corning, ExxonMobil, 3M, Illumina and every other large industrial employer
> runs one of the systems below, and most of them answer an unauthenticated GET.
> Free, canonical, full-fidelity — this is where the recall is.

## Build first — one call, no auth, description included

| Platform | Endpoint | Notes |
|---|---|---|
| **Greenhouse** | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | already implemented; docs state plainly that GET needs no auth |
| **Recruitee** | `GET https://{company}.recruitee.com/api/offers/` | 56 fields, ~8.7 k chars of HTML description, `published_at`, structured city/country/remote, salary object. A missing tenant returns a clean `404`. |
| **Gem** | `GET https://api.gem.com/job_board/v0/{slug}/job_posts/` (**trailing slash required**) | Officially documented as unauthenticated. **Greenhouse-compatible schema** — near drop-in for the existing adapter. `content` + `content_plain`, `first_published_at`. |
| **Teamtailor** | `GET https://{company}.teamtailor.com/jobs.json` | JSON Feed 1.1 with `content_html` **plus** an embedded schema.org `_jobposting` carrying `datePosted` and `validThrough`. Pages with `?page=N`. **Undocumented** — treat schema stability as best-effort. |
| **Personio** | `GET https://{company}.jobs.personio.de/xml?language=en` | Full descriptions, `createdAt`. **Returned HTTP 429 after ~5 tenant probes — throttle this one explicitly.** |

## Build second — no auth, but the description needs a second call

| Platform | List | Detail | The gotcha that costs an afternoon |
|---|---|---|---|
| **Workday** | `POST .../wday/cxs/{tenant}/{site}/jobs` `{appliedFacets:{},limit:20,offset:0,searchText:""}` | **GET** `.../wday/cxs/{tenant}/{site}{externalPath}` | `limit: 21` returns **HTTP 400**, not a truncation — 20 is the hard max. `postedOn` is relative text ("Posted 13 Days Ago"), not a date. |
| **Oracle ORC** | `GET .../hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber={site},limit=25,offset=0,sortBy=POSTING_DATES_DESC` | `...recruitingCEJobRequisitionDetails?finder=ById;Id="{Id}",siteNumber={site}` | **`limit`/`offset` go INSIDE the finder string.** Site discovery is *also* public: `recruitingCESites` — filter `StatusCode == 'ORA_ACTIVE'` or you crawl Oracle's inactive reference copies. One probed tenant reported **2,147 jobs**. |
| **Taleo** | `POST https://{tenant}.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal={portalId}` | HTML `.../jobdetail.ftl?job={contestNo}` | **The CSRF-token dance every guide describes is unnecessary.** The one load-bearing requirement is a **`tz: GMT-04:00` header** — without it the same request returns HTTP 500. `column` is positional and tenant-configured: use `linkedColumn`/`locationsColumns` as index hints, never hardcode. **~50 % of tenants fail, some returning HTTP 200 with an HTML error page — detect by content-type.** `/rest/jobboard/getJob` does not exist. |
| **ADP Workforce Now** | `GET https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?cid={uuid}` | `.../job-requisitions/{itemID}?cid=...` | `$top` is silently ignored (page size fixed at 20) and **`$skip` is 1-based — `$skip=0` returns 19 items.** Start at 1, then 21, 41. Carries `payGradeRange`, which almost no other feed does. |
| **Eightfold** | `GET https://{company}.eightfold.ai/api/apply/v2/jobs?domain={domain}&start=0&num=10` | `.../api/apply/v2/jobs/{pid}?domain={domain}` | **`num` is capped at 10** whatever you ask for, while `count` reports the true total — budget `count/10` requests. Their robots.txt explicitly says `Allow: /api/apply`. |
| **Phenom** | `POST https://{host}/widgets` body `{"ddoKey":"refineSearch","from":0,"size":100,"siteType":"external","jobs":true}` | second `POST /widgets` with `{"ddoKey":"jobDetail","jobSeqNo":…}` | **The three endpoint patterns in circulation (`/api/jobs`, `/services/jobs`, `/widgets/jobs`) are all wrong** — they 500 or 303. `ddoKey` goes in the **body**. Real `from`/`size` pagination, 200 records per call. |
| **BambooHR** | `GET https://{company}.bamboohr.com/careers/list` | `/careers/{id}/detail` | No posted date at all. A missing tenant **302s to marketing** — that redirect is the "no such tenant" signal. |
| **Rippling** | `GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs` | `.../jobs/{uuid}` | Officially documented, no auth. **The list repeats the same `uuid` once per work location** — deduplicate on `uuid` or triple-count. No posted date. |

## Partial — usable with a caveat

- **iCIMS** — no JSON or XML feed exists (`?format=json`, `?rss=1`, `/jobs/feed` are all silently ignored and return the HTML page). But a clean two-stage path needs **no HTML parsing**: `sitemap.xml` gives every job URL with `<lastmod>` (free incremental sync), then the job page carries a complete schema.org `JobPosting` in a single JSON-LD block. robots.txt permits both. Blocker: tenant subdomains are unguessable.
- **SuccessFactors** — `https://{rmk-domain}/sitemal.xml` — **the typo is real, `sitemal` not `sitemap`** — is RSS carrying full descriptions (1,108+ items on one probe). Unpaginated and very large; no posted date. The OData `JobRequisition` entity needs Recruiter permissions and is not a path to third-party data at any price.
- **Paylocity** — the documented feed wants an API key that cannot be obtained, and the careers-page UUID is **not** it (returns `200 {"jobs":[]}`). The working path is `window.pageData` embedded in the careers page; **descriptions are truncated to exactly 110 characters**.
- **Breezy** — `https://{company}.breezy.hr/json` is the public one (the `api.breezy.hr` v3 path returns `missingAccessToken`). No description in the list.
- **Avature** — RSS exists but is **hard-capped at 20 items and paging is broken**: every `jobOffset` returns the identical 20. One probed tenant advertised 55 results, so ~64 % is unreachable.
- **Jobvite** — HTML only. The "embedded JSON" premise is disconfirmed: no `__NEXT_DATA__`, no JSON-LD. No posted date anywhere. Cloudflare `__cf_bm` on every request.

## Do not attempt

- **Dayforce** — Cloudflare rejects non-browser POSTs **before routing** (a POST to a nonexistent route returns the same 403). Not fixable with headers, and not something to try. Its robots.txt additionally publishes content-signals expressly reserving rights over `ai-input`.
- **JazzHR**, **ApplicantPro** — feeds exist only per-customer, behind a token that is not discoverable.
- **Handshake** — `401`; the EDU API is restricted to Career Services partner institutions. No public tier.

## Rules for the implementer

1. **Respect what the probes found.** Personio 429s after about five requests — throttle it. Dayforce is off-limits. Cloudflare is passive on Workday, BambooHR, Rippling and Jobvite today; treat that as revocable and keep request rates modest.
2. **Detect failure by content-type, not status.** Taleo returns HTTP 200 with an HTML error page for roughly half of tenants.
3. **Tenant discovery is the real cost**, not the fetch. The Simplify feed already hands over 238 Workday and 127 Oracle/iCIMS tenants for free
   (`lib/career/sources/simplify.ts`), which is the cheapest tenant source we have.
4. **Priority for this founder**, in order of expected chemical-engineering
   recall per hour of work: **Oracle ORC** (site discovery is public and one
   tenant held 2,147 jobs) → **Taleo** (the `tz` header correction makes it
   cheap) → **Recruitee/Gem/Teamtailor** (one call, full description) →
   **ADP/Eightfold/Phenom** → iCIMS via sitemap.
