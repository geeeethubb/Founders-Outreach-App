# Agents — Outreach OS V2

> Seven agents. Their responsibilities, tools, inputs, structured outputs, and boundaries.
> Companion docs: [PIPELINE.md](PIPELINE.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [EVALS.md](EVALS.md)

**These are runtime product agents — TypeScript modules under `lib/agents/`.**
They are not Claude Code subagents. See
[ARCHITECTURE.md §9](ARCHITECTURE.md#9-claude-code-vs-the-products-runtime-ai).

---

## Rules that apply to all seven

1. **An agent is a pure function of its input.** It never reads or writes the database. The
   orchestrator loads inputs and persists outputs. This is what makes agents testable.
2. **Structured output only.** Every agent declares a schema; output is validated before use.
   Invalid output is a retryable failure.
3. **Versioned prompts.** `prompt.ts` exports `{ version, build(input) }`. `version` is bumped
   by hand on any semantic change and recorded in `agent_runs.prompt_version`.
4. **Model by role, never by ID** — `fast` / `reasoning` / `writing` from `lib/ai/models.ts`.
5. **Every run is traced** to `agent_runs`.
6. **Uncertainty is stated, not smoothed over.** An agent that does not know says so. This is
   enforced structurally where it matters (research typing, confidence fields), not by asking
   politely in a prompt.
7. **No agent calls another agent.** Composition is the orchestrator's job. This keeps the
   pipeline a readable sequence instead of an uninspectable swarm.

### Why exactly seven — and what has been added since

Seven maps to the seven distinct *judgment* problems in the original pipeline. Discovery,
dedupe, scoring arithmetic, sending, and reply polling are deliberately absent — those are
deterministic and belong in code. Do not add an agent without a judgment problem that none
of the existing ones owns.

Six have earned their place since, each against that test:

| Agent | The judgment problem no existing agent owned | Phase |
|---|---|---|
| **Person Triage** | "which 2–3 of these Apollo candidates are worth paying to research?" — a *selection* decision made before evidence exists, where Ranking needs evidence to work at all ([ADR-021](ARCHITECTURE.md#adr-021)) | 7 |
| **Conversation** | "what did this reply actually mean?" — `"sounds interesting, my plate is full"` and `"sounds interesting, let's talk"` differ by intent, not by keyword | 9 |
| **Follow-Up** | "is there anything left worth saying to someone who did not answer?" — a judgement whose correct answer is usually *no* | 9 |
| **Contact Classifier** | "what IS this person, in terms a future search can use?" — asked once per contact, mission-independent, and therefore cacheable in a way nothing else here is ([ADR-026](ARCHITECTURE.md#adr-026)) | 10 |
| **Network Retrieval** | "given a mission, which people ALREADY in the database matter, and what vocabulary finds them?" — the Mission Strategist plans an external market and Market Discovery searches the web; neither can look inward ([ADR-025](ARCHITECTURE.md#adr-025)) | 10 |
| **Style Analyst** | "what makes this email sound like this person?" — reading a real email the user sent and extracting a reproducible voice from it ([ADR-028](ARCHITECTURE.md#adr-028)) | 10 |

**Thirteen now.** Each addition has been argued individually against the same test, and the
test still applies to the fourteenth. Three of these were rejected during Phase 10 design and
are worth recording: a "network gap analyst" (the retrieval agent already reports gaps as part
of its own output), a "relationship interpreter" (who was emailed and what they replied are
facts in the database — interpreting them is arithmetic, `lib/network/relationship.ts`), and
an "edit learner" (one edit is not evidence of a preference; the data is retained in
`outreach_edits` until there is enough of it to be worth a judgment).

Everything around them stayed deterministic: persistence, the Gmail API, timestamps, status
transitions, dedupe, retries, sending, and funnel arithmetic are all code. Classification →
state, in particular, is a lookup table in `lib/outreach/states.ts` — the agent judges what
the reply meant, the code decides what that implies.

---

## 1. Mission Strategist

**Stage** 1 · **Model role** `reasoning` · **Frequency** once per run

Converts an ambiguous human goal into a concrete, executable search plan.

### Input
- Mission objective (free text)
- Hard constraints and soft preferences
- Timing window
- Talent Knowledge Base **summary** — kinds, domains, and seniority signals only, not full items

### Output
```ts
{
  target_industries:  { name, rationale, priority }[]
  company_archetypes: { label, description, size_range, stage, rationale }[]
  target_roles:       { title_patterns: string[], seniority: string[], rationale }[]
  geographic_strategy:{ primary: string[], secondary: string[], rationale }
  search_hypotheses:  { hypothesis, reasoning, confidence }[]
  discovery_queries:  { provider, params: object, expected_yield, rationale }[]
  rationale:          string
}
```

### Boundaries
- **Produces a plan, never an action.** It does not call providers. `discovery_queries` are
  executed by deterministic code in stage 2.
- `params` must validate against the target provider's query schema. Invalid params are a
  retryable failure, not something the discovery layer works around.
- Must generate **diverse** hypotheses. Ten variations of one idea is a failure mode: it
  produces a homogeneous funnel that looks productive and explores nothing.

### Notes
This is the only stage where creative breadth is the point, and it is cheap — one call. It is
also the highest-leverage place for human review: editing the strategy before discovery runs
costs nothing, while correcting a bad funnel afterwards costs the whole run's API budget.

---

## 2. Company Scout

**Stage** 2–3 (interpretation) · **Model role** `reasoning` · **Frequency** batched, ~10 companies/call

Interprets raw provider output into evaluable candidates. **It does not do the searching** —
deterministic code does that.

### Input
- Raw candidates from Apollo / PitchBook / web, with provenance
- Mission strategy
- Hard constraints (already applied — survivors only)

### Output
```ts
{
  companies: {
    candidate_id:     string
    interpretation:   string   // what this company actually does, in plain English
    archetype_match:  string | null
    opportunity_signals: { signal, evidence, source_url? }[]
    concerns:         string[]
    worth_pursuing:   boolean
    reasoning:        string
  }[]
}
```

### Boundaries
- Never invents companies. Every output maps to an input `candidate_id`.
- `opportunity_signals` must cite evidence from provider data or a web finding.
- Distinguishes "this company is impressive" from "this company plausibly has the opportunity
  the user wants." Only the second matters. This is the company-level analogue of V1's
  fame-vs-fit problem, and it is worth stating in the prompt explicitly.

### Tools
`CompanyProvider` results (passed in, not called) · `WebResearchProvider` for a light
disambiguation pass when provider data is thin.

---

## 3. People Scout

**Stage** 4–5 (interpretation) · **Model role** `reasoning` · **Frequency** batched, ~10 people/call

Interprets people found inside a target company and judges who is actually worth approaching.

### Input
- Candidate people for one company: name, title, seniority, department, LinkedIn URL, email availability
- The company and its interpretation
- Mission and role strategy
- Talent KB summary

### Output
```ts
{
  people: {
    candidate_id:      string
    role_interpretation: string   // what this title likely means AT THIS company
    can_help:          { score: number, reasoning: string }
    reason_to_care:    { score: number, reasoning: string }
    likely_owner_of:   string[]   // initiatives this person plausibly owns
    concerns:          string[]
    worth_pursuing:    boolean
  }[]
}
```

### Boundaries
- **Explicitly not a seniority ranker.** The objective is the intersection of two things:
  1. enough ability to create or influence an opportunity, and
  2. a plausible reason to care about *this* user.

  A Director who owns the relevant initiative beats a CEO who does not. A CEO at a 12-person
  startup and a CEO at a 40,000-person corporation are entirely different prospects, and
  `role_interpretation` exists to force that distinction rather than let title matching paper
  over it.
- Titles are interpreted **in company context**. "Head of Innovation" means something very
  different at a chemical manufacturer than at a Series A startup.
- Must not assume email deliverability. Reachability is a deterministic check, recorded
  separately.

---

## 4. Research Agent

**Stage** 6 · **Model role** `reasoning` · **Frequency** once per person (the linchpin stage)

Builds a grounded dossier on a person and their company.

### Input
- Person: name, title, company, LinkedIn URL
- Company: name, domain, description, provider data
- Mission (to focus research — this is not open-ended browsing)

### Tools
`WebResearchProvider` — multiple targeted searches per dossier. **This is the only agent with
live retrieval**, which is precisely why grounding is enforceable here.

### Output
```ts
{
  facts: {
    claim:      string
    type:       'FACT' | 'INFERENCE' | 'UNKNOWN'
    source_url: string | null      // REQUIRED when type === 'FACT'
    source_title: string | null
    confidence: number             // 0–1
    relevance:  string             // why this matters for this mission
  }[]
  recent_developments: { description, date_approx, source_url, significance }[]
  role_interpretation: string
  likely_priorities:   { priority, reasoning, evidence_refs: number[] }[]
  relevant_initiatives:{ initiative, evidence_refs: number[] }[]
  conversation_hooks:  { hook, why_it_lands, evidence_refs: number[] }[]
  uncertainties:       string[]
}
```

### Boundaries — the strictest in the system

- **`type: 'FACT'` requires a resolvable `source_url`.** No exceptions. A claim without a
  source is an `INFERENCE` by definition, and the schema enforces it.
- **Never present an inference as a verified fact.** This is not a tone request; it is what
  the three-way type exists to make structurally impossible.
- **`UNKNOWN` is a first-class output.** "I could not determine who owns AI initiatives here"
  is genuinely useful: it stops positioning from assuming, and it can itself become an honest
  question in the email. An agent that emits no `UNKNOWN` items on a thinly-documented person
  is not being thorough — it is fabricating.
- Research is **mission-scoped**. Do not build a biography. Find what bears on whether this
  person could create this opportunity and what they care about right now.
- Personal information beyond public professional context is out of scope.

### Failure mode this is designed against
V1 asks the model what it remembers and spends 40% of its prompt begging it not to make things
up. That is unverifiable — you can only read the output and hope. Here, a fabricated `FACT`
fails a deterministic source check before it reaches positioning, and an uncited claim fails
again at the eval gate ([ADR-011](ARCHITECTURE.md#adr-011)).

---

## 5. Fit & Ranking Agent

**Stages** 3 and 5 · **Model role** `reasoning` · **Frequency** batched, ~10 subjects/call

Judges component scores for companies and for people. **It does not compute the overall
score** — see [ADR-004](ARCHITECTURE.md#adr-004).

### Input
- Subjects to score (companies or people), batched
- Mission, strategy, and available research
- Talent KB summary
- The scoring dimension definitions

### Output
```ts
{
  scores: {
    subject_id: string
    components: {
      dimension:   ScoringDimension
      score:       number    // 0–1
      explanation: string    // WHY this score — required, never boilerplate
      evidence:    string[]  // references to facts or provider data
    }[]
    confidence: number       // 0–1: how much evidence backs this at all
    summary:    string       // one sentence a human can act on
  }[]
}
```

### Dimensions
`opportunity_fit` · `decision_making_power` · `user_differentiation` ·
`probability_of_response` · `company_attractiveness` · `timing_trigger`

Default weights and their meanings are in [PRODUCT.md §5](PRODUCT.md#5-scoring).

### Boundaries
- **Emits components only.** Weighting, summation, thresholds, and ranking are
  `lib/scoring/compute.ts`. The agent never sees the weights — which prevents it from
  reverse-engineering a target overall score and back-filling components to reach it.
- `explanation` is mandatory per component and must be specific. "Good fit" is a failure.
- `confidence` must be **low when evidence is thin**, independent of the score. A high score
  on thin evidence is a legitimate and useful output; a high *confidence* on thin evidence is
  a bug.
- Scores are calibrated **relative to the batch**, which is why batching exists. Absolute
  calibration across separate calls drifts badly.

---

## 6. Positioning Agent

**Stage** 7 · **Model role** `reasoning` · **Frequency** once per person

**The most important agent in the system.** It answers:

> Why should this exact person care about this exact user?

### Input
- Mission
- Company dossier
- Person dossier (facts, priorities, initiatives, hooks)
- **Retrieved** talent items — a pre-ranked shortlist (~10–15), never the whole KB

### Output
```ts
{
  their_priorities:      { priority, evidence_refs: number[] }[]
  user_relevant_evidence:{ talent_item_id, relevance_reasoning }[]
  credibility_signals:   { signal, talent_item_id, strength }[]
  intersection:          string   // what is unusual about this specific pairing
  thesis: {
    them:         string   // what appears to matter to this person
    you:          string   // what evidence the user has
    intersection: string   // why the combination is unusual or relevant
    angle:        string   // how to frame the outreach
  }
  selected_proof_points: { talent_item_id, why_this_one, rank }[]  // 1–3, ordered
  what_not_to_mention:   { item, reasoning }[]
  suggested_ask:         { ask_type, phrasing_guidance, reasoning }
  confidence:            number
}
```

### Boundaries
- **Selects 1–3 proof points. Never more.** The cap is the product requirement, not a
  stylistic preference — the whole point is selectivity. An agent allowed five will use five.
- Every selected item references a real `talent_item_id`. It cannot invent user experience.
- **`what_not_to_mention` is required output, not optional.** Knowing a user's crypto project
  will land badly at a regulated industrial firm is as valuable as knowing which project to
  lead with, and nothing else in the pipeline captures it.
- The thesis is **concise**. Four short fields, not four paragraphs. If the intersection needs
  a paragraph to explain, it is probably not a real intersection.
- May recommend an ask other than the default 20–30 minute conversation when strategically
  stronger, and must say why.

### Why retrieval happens outside this agent
Two jobs — "find candidate proof points" and "choose the best ones and build a thesis" — need
different context windows and different failure handling. Retrieval is `lib/talent/retrieve.ts`
(deterministic tag/embedding match). Selection is this agent, working over a shortlist. This
is the concrete replacement for V1's "paste 2000 characters of résumé and hope."

---

## 7. Outreach Agent

**Stage** 8 · **Model role** `writing` · **Frequency** once per person, plus ≤2 revisions

Writes the email.

### Input
- Mission
- Person and company
- Research dossier (facts with ids)
- Positioning angle and selected proof points
- Sender identity and signature preferences
- On revision: the failing eval critique

### Output
```ts
{
  subject: string
  body:    string
  cta_type: 'conversation' | 'project_discussion' | 'advice' | 'referral'
          | 'introduction' | 'collaboration' | 'internship_discussion'
  citations: {
    claim_text: string   // the exact span in the body making a factual claim
    fact_id:    string   // the research_facts row supporting it
  }[]
  word_count:   number
  angle_used:   string
  self_critique: string
}
```

### The email must communicate four things
1. **Why them?** — something true and specific about this person or company
2. **Why me?** — the selected proof points, not a résumé
3. **Why now?** — why this conversation, this week
4. **What's the small ask?** — one ask, easy to say yes to

### Voice
**Aim for:** founder-to-founder energy · concise · intelligent · confident · curious ·
ambitious · human · direct · specific.

**Avoid:** generic networking language · corporate fluff · excessive compliments · résumé
dumping · long introductions · obviously-AI personalization · fake familiarity · unsupported
claims · desperate job-seeking language.

### Boundaries
- **Every factual claim about the recipient must appear in `citations`.** A deterministic check
  resolves each `fact_id`. This is [ADR-011](ARCHITECTURE.md#adr-011) — it converts
  "please don't hallucinate" into a foreign-key constraint.
- Only proof points selected by positioning may be used. No reaching into the wider KB.
- Anything in `what_not_to_mention` is forbidden.
- No signature — the sender's own is appended at send time (V1 behavior, preserved).
- Understandable in seconds. There is no fixed word count in the prompt; brevity is judged by
  the eval, which is a better instrument than an arbitrary number. V1's "120–160 words" rule
  produced padding to reach the floor.

### Notes
This is the only agent using the `writing` model role and a higher temperature. Everything
upstream is judgment and should be near-deterministic; only this stage benefits from variance.

---

## Agent boundaries at a glance

| Agent | Reads DB | Calls providers | Writes DB | Calls other agents |
|---|---|---|---|---|
| Mission Strategist | ✗ | ✗ | ✗ | ✗ |
| Company Scout | ✗ | ✗ (results passed in) | ✗ | ✗ |
| People Scout | ✗ | ✗ (results passed in) | ✗ | ✗ |
| Research | ✗ | ✓ **web only** | ✗ | ✗ |
| Fit & Ranking | ✗ | ✗ | ✗ | ✗ |
| Positioning | ✗ | ✗ | ✗ | ✗ |
| Outreach | ✗ | ✗ | ✗ | ✗ |

Exactly one agent touches the outside world, and it is the one whose entire job is grounding.
Everything else is a pure function. That is the property that makes this a pipeline rather
than a swarm.

The Phase 9 additions keep the property: **Conversation** and **Follow-Up** call nothing,
read nothing, and write nothing. They are handed the thread, the reply and the evidence pool,
and they return a judgement. The route persists it.

---

## Conversation Agent (Phase 9)

**Judgment problem:** what did this reply actually mean, and what should happen next?

**Input:** mission · sender · recipient · the email we sent · the thread so far · the newest
inbound message · the same verified-facts pool the writer had, plus the reply itself.

**Output:** `classification` (9 values) · `action` (5 values) · one-sentence `summary` ·
`suggested_subject` / `suggested_body` · `follow_up_after_days` · `confidence` · `reasoning`.

**Boundaries.** Cannot send. Cannot change state — `stateForClassification()` does that, in
code. Cannot search. An action requiring a response but producing none is invalid output and
is retried, so the user never gets an empty box where a draft should be.

**The failure it is built against** is politeness inflation. *"This sounds like interesting
work, unfortunately my plate is completely full"* is `NOT_NOW`, not `POSITIVE`, and reading
it as positive wastes the user's best follow-up energy on a closed door.

**The suggested response is held to the same claim gate as the cold email.** A warm reply
invites embellishment, which is exactly when grounding slips.

---

## Follow-Up Agent (Phase 9)

**Judgment problem:** is there anything left worth saying to someone who did not answer?

**It starts from no.** Silence is information; a second email that adds nothing converts a
neutral non-response into an active negative. Recommending *against* sending is a correct
answer, not a failure, and the output schema requires a `rationale` either way.

**Output:** `should_follow_up` · `rationale` · `new_value` (what this adds that the first
email did not) · `send_after_days` · `subject` · `body`.

**Boundaries enforced in `validate()`, not in the prompt:** ten banned openers
("just following up", "circling back", "in case this got buried", …) reject the draft
outright, and a body over 90 words is rejected. A draft that needs one of those phrases to
work is a draft with nothing new to say.

**One suggested follow-up per cold outreach**, enforced against `outreach.followup_count` in
the route. The counter increments on a *no* as well as a *yes* — the cap is on how many times
it is asked, or a no can be re-rolled into a yes.

---

## Migrating V1's AI modules

| V1 module | Fate |
|---|---|
| `lib/ai/research.ts` | **Replaced** by the Research Agent. Its anti-hallucination instincts were right; grounding replaces exhortation. |
| `lib/ai/personalize.ts` | **Replaced** by Positioning + Outreach. Its 5-part structure and hook taxonomy inform the new prompts. |
| `lib/ai/fill-template.ts` | **Kept.** User-authored templates remain a legitimate manual path alongside the mission pipeline. |
| `lib/ai/classify.ts` | **Extended** to the richer outcome vocabulary in [PIPELINE.md §5](PIPELINE.md#stage-12--response-tracking). Not an agent — a deterministic-adjacent classifier on the `fast` role. |
| `lib/ai/suggest-reply.ts` | **Kept.** Reply drafting is a different problem from cold outreach and works today. |
| `lib/ai/campaign-feedback.ts` | **Evolves** into the Phase 11 learning surface, grounded in `outcome_events` rather than a one-shot critique. |

`EMAIL_STYLES` from `types/index.ts` is retained as **mission-level tone configuration**.
Two of the ten styles (`student_angle`, `data_driven`) reference UIUC in their prompt text and
must be genericized when missions land in Phase 1.
