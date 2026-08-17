# Product — Outreach OS V2

> Status: specification · Supersedes the V1 product described in [CURRENT_STATE.md](CURRENT_STATE.md)

---

## 1. What this is

Outreach OS is an **autonomous opportunity discovery and relationship-building system**.

It is not an email automation product. Email is the last 5% — the visible output of a much
larger process of figuring out *where* an opportunity might exist, *who* controls it, and
*why that specific person should care about this specific user*.

The user states a goal. The system does the rest, stopping for approval before anything
leaves the building.

> "Find me a high-value winter internship or short-term project."

---

## 2. North Star

> **Meaningful conversations with relevant decision-makers that advance the user's goal.**

For the initial mission, the primary conversion event is:

> **A relevant person agrees to a 20–30 minute conversation.**

### Secondary positive conversions

- Referral to another relevant person
- Request for résumé or work samples
- Introduction to a hiring or project owner
- Discussion of a concrete potential project
- An explicit invitation to continue the conversation

### Explicitly rejected metrics

These are **not** goals, and the product must not optimize for or prominently display them:

| Rejected | Why |
|---|---|
| Emails sent | Volume is the enemy of the North Star. More sends dilute quality and burn the user's name. |
| Number of leads | A large list of weak prospects is worse than a small list of strong ones. |
| Open rate | Structurally unmeasurable on the Gmail send path, and a poor proxy for interest. |
| Amount of personalization | Personalization is a means. A densely personalized email to the wrong person is still a failure. |

**A run that produces 6 excellent prospects and 6 sent emails is a better run than one that
produces 60 mediocre prospects.** The system's job is to be selective, not productive.

---

## 3. Design consequences of the North Star

These are product rules, not implementation details. They exist because a system that can
generate 200 drafts will tempt its operator into sending 200 drafts.

1. **Per-mission outreach caps are enforced in code, not left to discipline.**
   A mission declares `max_active_outreach` (default **20**). The approval queue will not
   accept new drafts beyond it while earlier ones are unresolved.

2. **One person per company at a time.**
   A second contact at the same company is not drafted until the first resolves (replied,
   declined, or aged out). Two cold emails into one company in the same week reads as a mail
   merge and costs the user credibility.

3. **The system may return fewer prospects than asked for.**
   If the mission asks for 10 and only 4 clear the bar, it surfaces 4 and explains the
   shortfall. It must never pad the list to hit a number.

4. **Nothing cold leaves without a human.**
   See §6.

5. **Every recommendation is accountable.**
   For any prospect the user can ask "why this person?" and for any draft "why this email?"
   and get a real answer with evidence, not a restatement.

---

## 4. The Mission system

A **Mission** is the unit of intent. It generalizes V1's five hardcoded outreach goals into
a first-class object so future missions reuse the same engine with no code changes.

A mission carries:

| Field | Meaning |
|---|---|
| `objective` | Free text. "Find a high-value winter internship or short-term project." |
| `hard_constraints` | Non-negotiable. A candidate violating one is **eliminated**, not penalized. |
| `soft_preferences` | Weighted desirables. Influence ranking, never eliminate. |
| `scoring_weights` | Per-mission override of the default scoring model (§5). |
| `max_active_outreach` | The cap from §3. |
| `timing_window` | When the opportunity is live — e.g. December–January. |
| `autonomy_level` | `approval_required` (default) or `autonomous` (§6). |

### Hard vs soft — why the distinction is load-bearing

If everything is a weighted preference, a spectacular company that fails an absolute
requirement will still rank highly and waste the user's attention. If everything is a hard
filter, the funnel collapses to zero. Both failure modes are common in ranking systems.

- **Hard constraint** → deterministic elimination in code, before any LLM sees the candidate.
  Cheap, auditable, and it protects the scoring budget.
- **Soft preference** → contributes to a component score with an explanation.

Preference *dimensions* are open-ended, not an enum. The initial set includes geography,
industry, company size, startup vs. corporation, role type, opportunity type, seniority,
working environment, technical domain, and timing — but the schema must accept dimensions
nobody has thought of yet.

### Initial mission: Winter Internship / Project

- **Timing:** approximately December–January.
- **Opportunity types:** short-term project, internship, founder project, industrial
  innovation work, AI project, consulting project, research/technical project.
- **Company categories:** startups, growth-stage companies, corporations, industrial,
  chemical, manufacturing, energy, enterprise AI, consulting firms, innovation organizations.

None of this is hardcoded. It is seed data for one mission row.

---

## 5. Scoring

Every company and every person carries **component scores**, not a single number.

| Dimension | Default weight | Question it answers |
|---|---|---|
| Opportunity Fit | 25% | Does the kind of opportunity the user wants plausibly exist here? |
| Decision-Making Power | 20% | Can this person actually create or influence it? |
| User Differentiation | 20% | Is the user unusually interesting to *them*, versus generically qualified? |
| Probability of Response | 15% | Realistically, will they reply? |
| Company Attractiveness | 10% | Is this somewhere worth spending the user's one shot? |
| Timing / Trigger | 10% | Is there a reason this lands *now* rather than any other week? |

**These are defaults, not rules.** Weights are stored per mission and editable. Changing them
re-ranks instantly, because the arithmetic is deterministic code reading stored components —
no model re-run required. See [ARCHITECTURE.md](ARCHITECTURE.md#adr-004) for why.

Each component stores a **score**, an **explanation**, and **evidence**. Each overall score
stores a **confidence**. A high score built on thin evidence is a different object from a
high score built on solid evidence, and the product must show the difference.

### Deliberate ranking stance

**Seniority is not the objective.** A Director who directly owns the relevant initiative
outranks a CEO who does not. The system optimizes for the intersection of *can help* and
*plausible reason to care* — not for the most impressive title reachable.

---

## 6. Human approval

### Automated end-to-end

Planning · searching · ranking · research · positioning · drafting · evaluation

### Requires a human

**Sending any new cold outbound message.** Always, by default.

The user sees the draft, the positioning thesis behind it, the evidence supporting each
personalization claim, and the eval results — then approves, edits, or rejects.

Autonomous sending is **architecturally supported but off**. It is a per-campaign flag
(`autonomy_level`), never a global default, and enabling it is a deliberate act. The system
should be capable of it before it is trusted with it.

---

## 7. The Talent Knowledge Base

A first-class, structured record of the user — replacing V1's six free-text blobs on
`profiles`.

Supported item kinds: **experiences, projects, skills, accomplishments, stories, interests,
domain knowledge, proof points, quantified results.**

Each item is taggable across dimensions including industry, problem type, technical skill,
business skill, role, audience relevance, company stage, and credibility signal.

### The rule that matters

> **Never dump the user's entire résumé into a generation prompt.**

V1 does exactly this — it slices `resume_text` to 2000 characters and pastes it in with a
hopeful instruction to "pick the most relevant 1–2 facts." That conflates two jobs in one
call and leaves no record of what was chosen.

V2 makes selection an explicit, inspectable step. For every prospect the system answers:

> **Which 1–3 things about this user make them unusually interesting to *this* person?**

and stores that decision with its reasoning.

---

## 8. Quality control

Every outbound draft passes an evaluation gate before reaching the approval queue.
Eight criteria — relevance, specificity, positioning, brevity, personality, claim accuracy,
CTA, and the cringe test. A failing draft is revised, then re-evaluated.

Full rubrics and thresholds live in [EVALS.md](EVALS.md).

The **claim accuracy** check is the one with teeth: every factual assertion about the
recipient must trace to a stored research fact with a source. An email that says "saw your
Series B announcement" when no such fact was verified does not reach the queue.

---

## 9. Outreach voice

> **⚠ Superseded per campaign, by design.** Everything in this section is the *default* voice,
> used when a campaign has no reference email. When a campaign carries one — a real email the
> user actually wrote — that email defines the voice and overrides everything below, including
> the length guidance and the one-ask rule ([ADR-028](ARCHITECTURE.md#adr-028)).
>
> That is not a compromise of this section; it is what this section was trying and failing to
> express. The adjectives below compound: "confident" plus "concise" plus "direct" plus
> "founder-to-founder" produced drafts that were arrogant and over-compressed, in a voice
> belonging to nobody. A real email is evidence about a real person. Evidence beats adjectives.
>
> The rules that never yield to a reference are the ones that are not about style: grounding
> (§8), no placeholders, and no reuse of facts belonging to the reference's own recipient.

**Aim for:** founder-to-founder energy · concise · intelligent · confident · curious ·
ambitious · human · direct · specific.

**Avoid:** generic networking language · corporate fluff · excessive compliments · résumé
dumping · long introductions · obviously-AI personalization · fake familiarity · unsupported
claims · desperate job-seeking language.

An email should be understandable within seconds and communicate four things:

1. **Why them?** — something true and specific about this person or company.
2. **Why me?** — the 1–3 proof points selected for this recipient.
3. **Why now?** — why this conversation, this week.
4. **What's the small ask?**

**Default CTA:** a 20–30 minute conversation. The agent may propose a different ask —
project discussion, advice, referral, introduction, collaboration, internship discussion —
when it is strategically stronger, and must say why.

---

## 10. Outcomes and learning

Tracked outcomes: no response · positive response · negative response · referral ·
meeting booked · résumé requested · opportunity discussion · project created ·
internship created.

Analyzed across: company type, industry, seniority, title, outreach angle, proof point used,
CTA, subject style, email length, geography, discovery source, and timing.

### Deliberately not building an ML system

At the volumes this product targets — tens of sends per mission, by design — there is no
statistical signal to learn from. A model tuned on 20 outcomes learns noise and will confidently
mislead.

**Phase 11 builds structured event logging and descriptive analytics only.** Weight
auto-tuning stays off until the data justifies it. Until then the learning loop is:
the system surfaces patterns with sample sizes attached, and the human adjusts the mission.
That is a real learning loop; it just runs through a person.

---

## 11. Success criteria

V2 is working when the user can say:

> "Get me conversations with 10 people who could lead to a great winter opportunity."

…and Outreach OS determines where to search, who to contact, why they should care, what to
say, and how to adjust based on what happens — surfacing 10 defensible prospects with drafted,
evaluated outreach for approval, and explaining every choice it made.
