# Phase 10 — The existing network, and a voice you supply

> Status: implemented · Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md#adr-025) ·
> [PIPELINE.md](PIPELINE.md) · [EVALS.md](EVALS.md#12-phase-10--internal-retrieval-and-reference-writing)

---

## 1. The two problems

Both were found by using the product, not by reading it.

### 1.1 There were already ~900 people, and nothing could see them

The database held **897 contacts**: 830 with an email, 897 with a LinkedIn URL, 635 bought
from Apollo, 262 carrying a V1 research summary, 4,244 grounded person-level facts. Two
hundred and fifty had been emailed. Eleven had replied. Three had reached a meeting.

Every scouting run started by paying to discover strangers.

Not because the data was missing — because nothing indexed it. `contacts` has a `tags` column;
3 rows of 897 use it. Finding "who in here is relevant to summer consulting?" meant reading
897 rows by hand, which is exactly the work the product exists to remove.

### 1.2 The emails did not sound like the person sending them

The house voice was defined by adjectives: *founder-to-founder · concise · confident ·
high-signal*, plus a hard 60–120 word cap.

Adjectives compound. Each one is individually reasonable and the stack produced drafts that
were **arrogant and over-compressed** — a voice belonging to nobody, which the founder then
rewrote by hand every time. Worse, the failure was invisible to the evals, because the evals
scored drafts against the same adjectives that produced them.

---

## 2. What was built

```
MISSION
  → MISSION STRATEGIST
  → EXISTING NETWORK RETRIEVAL      a bounded agent over contact_index
  → INTERNAL RANKING                the SAME Ranking agent the external path uses
  → SUFFICIENCY DECISION            deterministic, with reasons
      ├── INTERNAL_SUFFICIENT       ─▶ stop. No Apollo, no web research.
      └── EXTERNAL_DISCOVERY_NEEDED ─▶ discovery → research → MERGE (never duplicate)
  → POSITIONING
  → OUTREACH                        in the campaign's voice, if it has one
  → APPROVE → SEND → TRACK
```

### 2.1 Making 897 contacts searchable without tagging them by hand

Three layers, cheapest first.

**Deterministic normalization** (`lib/network/normalize.ts`) — free. Seniority band and
function derived from the job title, geography parsed into city/state/country/region, company
name normalized. This matters because Apollo reports a `seniority` for only 71% of the stored
rows while 99% carry a title.

**Cheap batched classification** (`lib/agents/contact-classifier/`) — one Haiku call per ~15
contacts, keyed by a hash of exactly the material it reads. Emits industry, sub-industry,
function, company type and stage, technical and business domains, opportunity types, open
tags, and a 0–1 disposition for each of six uses (recruiting, mentorship, customer discovery,
investor, partnership, speaker/sponsor).

**A weighted `tsvector`** — identity at weight A, classification tags at B, research prose at
C. Ranking over a single blob makes a plant manager whose *title* says "manufacturing"
indistinguishable from a marketer whose research paragraph mentions it once.

Cost, measured: **$1.59 for all 897 contacts, once.** Re-running the indexer after a scouting
run classifies the new people and nobody else.

### 2.2 A retrieval agent, not a query

`lib/agents/network-retrieval/` gets one tool — ranked full-text search with structured
filters — and a search budget the tool enforces. It searches with several different
vocabularies, reads the counts, reformulates, and submits a ranked shortlist with component
scores, a reason, and the evidence each rests on.

It is an agent rather than a query because **the first vocabulary is always wrong**. A mission
stated as "summer 2027 consulting role" does not match a row that says "Engagement Manager,
operational excellence". Watching it work on the real database:

```
"operations consulting manufacturing transformation process"  → 385 above floor
"management consulting partner principal industrial practice" → 153
"continuous improvement lean operational excellence plant"    → 179
"Chicago consulting firm recruiting"                          → 127
"Deloitte Accenture McKinsey Kearney Big Four industrial"     →  61
"supply chain consulting industrial engineering internship"   →  99
```

That is six genuinely different searches, and the last two are the ones a keyword box would
never have been given.

### 2.3 The decision is code, not judgment

`lib/network/sufficiency.ts` counts candidates clearing **both** a score floor (0.62) and a
confidence floor (0.5), and compares that to the mission's target. Four search modes:
`internal_first` (default), `internal_only`, `both`, `external_only`.

The agent that would decide "have I found enough?" is the agent that benefits from searching
more. Every decision writes its reasons to `scouting_runs.internal_decision` and to the UI,
because *"why did this run cost $14?"* and *"why did this one cost nothing?"* are the same
question.

### 2.4 Scores are per mission, never on the person

`network_matches` is keyed `(run_id, contact_id)`. A person weak for winter industrial AI may
be strong for summer consulting or for mentorship. Writing a quality number back onto the
contact would let the first mission that ran poison every later one.

### 2.5 Relationship history, computed rather than asked

`lib/network/relationship.ts` reads `emails`, `conversations`, `messages` and `outreach` in
four queries and produces a status per contact: `met`, `referred`, `replied_positive`,
`in_conversation`, `contacted_no_reply`, `replied_negative`, `never_contacted`.

It reaches three places: the search index (so relationship is filterable), a small ranking
modifier (±0.15 at most — relationship is a tiebreaker on fit, never a substitute for it), and
the writer, which is told *"you have already met this person, reconnect rather than
cold-open"*.

### 2.6 Reuse before purchase

Before enrichment, every Apollo search stub is checked against an index of contacts this user
already owns. Search rows are obfuscated, so `apollo_id` is the only identifier available at
that point — and also the strongest one there is.

External discovery finding someone already in the database is a **merge**, labelled
`existing_rediscovered`, never a second row.

### 2.7 The campaign reference email

A campaign may carry one real email the user wrote. A **Style Analyst** reads it once and
extracts register, directness, context depth, how credentials appear, CTA shape, sentence
rhythm, the ordered structural beats, the distinctive moves — and `recipient_specific`, the
list of facts belonging to that email's own recipient.

That last field is the one that matters. It is what lets the writer be told *do not reuse
these*, which is the entire difference between imitating a voice and copying a template.

The writer then gets the reference, the analysis, the recipient's research, and the
positioning brief — and writes a finished email. **No placeholders, ever**: they are a
blocking deterministic gate, not an instruction.

**Length comes from the reference (±25%), not from a house rule.** In reference mode a draft
that undershoots is *rejected and retried*, because under-compression is the exact failure
this mode exists to stop.

---

## 3. What running it found

Five things, and the last two were only visible because something was measured.

### 3.1 Every search matched two-thirds of the database

The first eval run showed the agent making six well-chosen searches, each returning
**500–599 matches out of 897**. Terms are OR-ed, so almost any research paragraph contained
one of them somewhere. The count was noise, and the agent could not tell "my query was too
broad" from "this network is full of these people" — which is the judgment it exists to make.

Fixed with a **relevance floor set relative to the best match in the same query**, in both the
SQL function and the eval's backend. `ts_rank` values are not comparable across queries of
different lengths, so an absolute floor would have been arbitrary; "matches roughly as well as
the best thing here" is stable whatever was asked. The counts above in §2.2 are post-fix.

### 3.2 The agent treated the target as a quota

Asked for 10, it returned exactly 10 and stopped. The recall probe then found **ten further
people it had surfaced, that the judge called GOOD, and that it had silently discarded**.

Ranking cannot order candidates it never receives. The prompt now separates *how many the
mission needs* (which drives the sufficiency decision) from *how many to shortlist* (roughly
double), with instructions to score honestly and include generously.

### 3.3 An agent that appeared to hang was truncating and escalating

Two eval runs were killed on the assumption they had hung. Step-level logging showed the
truth:

```
step 1 — 3s,  tool_use,   called search_network ×4
step 2 — 4s,  tool_use,   called search_network ×2
step 3 — 60s, max_tokens, called submit_result
step 4 — 71s, max_tokens, called submit_result
```

`stop_reason: max_tokens`. A 20-person shortlist did not fit in the 6,000-token output budget,
so the tool call was cut off mid-JSON and failed validation. The loop then did the **worst
available thing**: it escalated a tier, and a stronger model wrote *more*, truncated again, and
charged several times as much to do it. One mission cost **$1.16** and several minutes.

Truncation is now handled as its own case in `lib/agents/runtime/loop.ts` — it does not
escalate, and it asks for a shorter answer instead of telling the model to re-read a schema it
understood perfectly. This fix applies to **every agent in the system**, not just this one.

Two permanent instruments came out of it: an optional `onStep` on the agent loop, and a
`retries` counter on Anthropic usage. A slow final turn, a retry storm, and a genuine hang
used to look identical from outside.

### 3.4 A dropped `\w*` had silently mislabelled most of the network

A unit test asserting *"a recruiter is not an engineer"* failed, and the cause was much larger
than the test:

```ts
/\b(manufactur|operation|technolog|consult|strateg|sustainab|recruit)\b/i
```

A trailing `\b` after a **truncated stem** requires a non-word character next — so
`manufactur\b` cannot match "Manufacturing", because the `i` is a word character. Every
inflected form fell through to `unknown`:

| Title | Before | After |
|---|---|---|
| Director of Manufacturing | `unknown` | `manufacturing` |
| VP Operations | `unknown` | `operations` |
| Chief Technology Officer | `unknown` | `technology` |
| Head of Sustainability | `unknown` | `sustainability` |
| Director of Strategy | `unknown` | `strategy` |
| Director Operational Excellence | `unknown` | `operations` |

The facet counts looked plausible and the function filters were nearly inert. Nothing about
the output looked wrong.

The fix also needed a second rule: "Technical Recruiter" then started matching `technology`,
because `technical` appears in that pattern. Recruiting, legal and finance are now
hard-matched *before* the ordered table — the same lesson `lib/scouting/filter.ts` records
learning once already.

### 3.5 A placeholder was reported twice

`Hi [First Name]` produced two findings — the bracket, and the stub name inside it — so the UI
said "2 placeholders" about one bracket. Overlapping spans are now claimed once.

---

## 4. Measurements

### 4.1 Internal retrieval — `npm run eval:network`

897 contacts indexed and classified. Five missions, same database, judged by
`evals/agentic/judge.ts` — the same instrument that produced Phase 7's
Precision@20 for externally discovered prospects.

| Mission | Pool | Surfaced | Shortlisted | **P@20** | BAD@20 | Decision | Cost |
|---|---|---|---|---|---|---|---|
| Summer 2027 industrial / engineering consulting | 897 | 75 | 19 | **84%** | 11% | INTERNAL_SUFFICIENT (11 strong / 10) | $0.74 |
| Industrial AI / manufacturing | 897 | 71 | 20 | **80%** | 0% | INTERNAL_SUFFICIENT (15 / 10) | $0.58 |
| Chemical / energy | 897 | 77 | 20 | **70%** | 0% | INTERNAL_SUFFICIENT (17 / 10) | $0.55 |
| Startup founders | 897 | 67 | 16 | **88%** | 0% | INTERNAL_SUFFICIENT (14 / 8) | $0.57 |
| Professional mentors | 897 | 81 | 16 | **88%** | 0% | INTERNAL_SUFFICIENT (10 / 8) | $0.51 |
| **Average** | | | | **82%** | **2%** | **5/5 skipped external discovery** | **$0.59** |

**The comparison that matters.** Industrial/engineering consulting is the profile
external discovery has always been worst at: Phase 3 measured **15%** precision on
it and Phase 6 got it to **20%** with grounded research and ~700 Apollo credits.
The same mission over the existing network scores **84%**, with no Apollo credits
and no web search.

That is not a claim that retrieval beats discovery in general. It is the specific
finding that the people worth writing to were **already in the database**, and the
system had been paying to look elsewhere for them.

| | Phase 3 | Phase 6 | Phase 10 (internal) |
|---|---|---|---|
| Consulting Precision@20 | 15% | 20% | **84%** |
| Apollo credits | ~700 | 0¹ | **0** |
| Cost per run | — | — | **$0.74** |

¹ Phase 6 ran on cached enrichment; the credits had been spent in Phase 3.

**Cost.** $1.59 once to classify all 897, then **$0.51–$0.74 per mission**, all of
it model tokens. A full external scouting run costs several dollars plus ~25
Apollo credits. Five missions avoided ~125 credits.

**The honest weakness — recall.** The probe judges the twelve highest-ranked
candidates the agent surfaced and did *not* shortlist. Six to twelve of them are
GOOD in every mission. So the network contains more good people than any one
shortlist returns.

That is a bounded-shortlist artifact rather than a ranking failure — the top of
the list is 82% good — and under the North Star ("6 excellent beats 60 mediocre")
it is the right trade. But it should not be reported as though retrieval found
everything, because it did not.

### 4.2 Reference writing — `npm run eval:reference`

Four campaigns, three recipients, all twelve pairings, each written twice — once
in reference mode, once in the house style — and judged blind in the same batch.

| | Reference mode | Control (house style) |
|---|---|---|
| **Reference similarity** | **3.83 / 5** | 2.00 / 5 |
| **"Same writer?"** | **83%** | 17% |
| **Over-compressed vs the reference** | **0%** | 58% |
| Placeholders | **0** | 0 |
| Reference-recipient facts reused | **0** | — |
| Recipient relevance | 4.17 / 5 | |
| Fact grounding | 3.75 / 5 | |
| Naturalness | 4.33 / 5 | |
| CTA fit | 4.08 / 5 | |
| Template avoidance | 4.00 / 5 | |
| Deterministic checks pass | 75% | |

**+1.83 on similarity, and 83% vs 17% on "would a reader believe one person wrote
both".** The control number is the important one: at 2.00/5 the house style does
not sound like this user, which is exactly the complaint that started this work,
now measured rather than asserted.

> **Read the delta, not the absolute.** Re-running reference mode *without* the
> control in the batch scored the identical drafts at 3.58 rather than 3.83 —
> batched judging calibrates against whatever else is in the batch. That drift is
> the reason the control exists, and it is why a bare "3.8 / 5 similarity" would
> not have been worth reporting.

**58% of house-style drafts were over-compressed** — under 70% of the reference's
length. Reference mode: zero.

**The length bands the analyst derived**, all from the same infrastructure:

| Campaign | Reference | Target band |
|---|---|---|
| Summer recruiting | 134 words | 101–168 |
| Startup founders | 89 words | 67–111 |
| Mentor outreach | 191 words | 143–239 |
| Founders sponsorship | 157 words | 118–196 |

The old fixed 60–120 band would have compressed the mentor campaign to a third of
its length.

**A deliberate trade, recorded because it goes the "wrong" way.** An earlier
iteration scored **4.25 similarity and 100% same-writer** — but its drafts
reproduced whole sentences from the reference, including the sponsorship
campaign's 22-word opening, verbatim, to every recipient. Prompt 2.1.0 forbids
copying sentences even when every fact in them is true and about the sender.
Similarity fell to 3.83 and same-writer to 83%; the deterministic pass rate rose
from 50% to 75%.

The lower number is the better system. Two recipients receiving an identical
opening paragraph is a mail merge whatever the facts say, and the North Star is
about the user's credibility, not about a judge's score.

---

## 5. What is deliberately not built

**No new vendor, no embeddings.** The requirement said not to add expensive infrastructure
unless the architecture genuinely required it. Postgres full-text search with weighted bands
and a relevance floor answers the retrieval question at this scale for nothing. The place
where semantic matching would help — bridging mission vocabulary to index vocabulary — is
handled by an agent that reformulates, which is cheaper, inspectable, and already needed for
other reasons.

**No auto-learning from edits.** `outreach_edits` retains every (generated, final) pair and
nothing reads it. One edit is not evidence of a style preference, and rewriting global rules
from it is precisely the overfitting the campaign-reference design replaces.

**Three agents were rejected during design**, each for failing the test in
[AGENTS.md](AGENTS.md): a *network gap analyst* (the retrieval agent already reports gaps as
part of its own output), a *relationship interpreter* (who was emailed and what they replied
are facts; interpreting them is arithmetic), and an *edit learner* (see above).

---

## 6. Founder action required

```bash
# 1. Apply in the Supabase SQL editor:
#    supabase/migrations/013_network_and_reference.sql
# 2. Then, once:
npm run index:network
```

Until both are done, internal-first scouting finds an empty index and says so in the run log
and in the UI. `npm run index:network` reports the missing migration and exits 2, matching
`npm run check:outreach`.
