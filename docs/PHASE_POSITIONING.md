# Phase 8 — Positioning and Outreach

The gap this closes: scouting found the right people, but deciding *why they
should care* and *what angle to use* was still manual.

Two agents, two evaluators, and the prospect card that exposes them.

---

## 1. Why two agents rather than one

Positioning decides the argument. Outreach writes it. They are separate on
purpose.

A single agent that both chooses the angle and writes the email produces emails
whose failures are undiagnosable — a flat draft could be a writing problem or a
positioning problem, and you cannot tell which without re-running the whole
thing. Split, each has its own evaluator and its own failure signature. That
split paid for itself immediately: the email score moved four times during this
phase while positioning stayed fixed, and every movement was attributable.

Neither agent searches the web. Both reason over research the pipeline already
bought ([ADR-021](ARCHITECTURE.md#adr-021)). If positioning wants a fact nobody
gathered, it says so in `risks` rather than going and buying it.

---

## 2. Positioning — the job is subtraction

Ranking already cites background when it explains a score. On the measured
prototype run it cited **five items for one prospect**. Five items is not a
position; it is a résumé with a covering sentence.

Positioning picks **at most three** — enforced in `validate()`, not requested in
the prompt — and names what to leave out. `do_not_mention` is a first-class
output, and it earns its place. For the Argonne prospect it excluded the Y
Combinator selection, three founder roles, the entrepreneurship presidency, the
M&A screening work, and the GPA/scholar honours: all genuinely impressive, all
noise in an argument about closing the model-to-plant-floor gap.

Grounding is structural. A cited id that does not exist is stripped and reported
in `ungrounded_ids`; a brief with zero surviving proof points is invalid and
retried. An invented credential cannot reach a draft.

---

## 3. Measured iterations

Each run used a 3-prospect sample at roughly $0.3–0.9 — small enough to iterate,
which is the point.

### Positioning: 3.72 → 4.28 (target 4.2)

The failure was **specificity 2.67**. Theses anchored on job-type *categories* —
"a large CPG smart-manufacturing leader" — which fit hundreds of people, and the
same P&G proof points were reused for every recipient regardless of who they
were.

The fix was to require an anchor on a **concrete particular**: a named programme,
system, site, decision or stated priority, with an explicit substitution test —
swap in someone with the same title at a competitor, and if the sentence still
reads fine, it anchored on the category. Specificity 2.67 → 4.00.

### Email: 4.04 → 3.96 → 3.75 → 4.38 (target 4.3)

Three findings worth keeping:

**Forcing a concrete opener collapsed grounding to 2.50.** The writer invented
recipient details to satisfy the requirement. The root cause was mine: it was
treating the positioning brief as *evidence*, but a brief contains inferences.
Separating the two — *the brief is the argument, VERIFIED FACTS are the
evidence* — restored grounding to 5.00.

**Restricting to person-level facts starved thin-record prospects.** The judge
marked them down for having nothing specific to say, correctly. Company-level
verified facts are evidence too, and adding them took specificity 3.67 → 4.00.

**Stacking asks was the CTA failure.** Three requests give a busy person three
decisions, so they make none. One ask took `cta_clarity` 3.67 → 4.67.

**Reverted:** "write short from the start" bought brevity and cost more
personality (3.00), dropping the average to 3.75. The hard-ceiling framing was
restored.

---

## 4. Results

| Sample | Positioning | Email | Grounding |
|---|---|---|---|
| Top 3 prospects | **4.28** PASS | **4.38** PASS | 100% |
| All 10 prospects | 3.85 FAIL | 4.03 FAIL | 100% ids · 4.40 claims |

**The small sample was optimistic, and that is the finding, not an accident.**
The 3-prospect sample was the *strongest* three. Across all ten, the weak cases
are prospects scouting should not have shortlisted — "the personal fit to
Alasdair specifically is thin", on a project manager at a small consultancy that
was already the visible tail of the shortlist.

**Positioning quality tracks prospect quality.** There is no angle for someone
who is not a good target, and the agent correctly declines to invent one rather
than manufacturing a hook. Grounding held at 100% across every iteration
including the ones that failed on other dimensions.

Thresholds are unchanged and the full-sample result is recorded as a fail.

---

## 5. Cost

**$0.17 per outreach-ready prospect** against a $0.20 target.

| | |
|---|---|
| positioning | ~$0.14 |
| outreach drafting | ~$0.03 |
| judges (eval only, not product cost) | ~$0.03 |

Both agents run on STANDARD, neither searches, and both cache on
(prospect, prompt version, model, research). Briefs are generated **on demand**
from the card rather than for every prospect in a run — most are never opened.

---

## 6. What the user can do

`/dashboard/scout` → open a prospect → **Build positioning + draft**.

The card shows the thesis with a confidence figure, the 1–3 chosen proof points
with why each matters *to this recipient*, why-you-to-them, why now, the
recommended ask, and what not to mention. Then the draft: subject, word count,
editable body, alternate angle, and **Approve / Regenerate / Skip**.

Nothing sends. [ARCHITECTURE §10](ARCHITECTURE.md) holds and this milestone stops
at the draft deliberately.

---

## 7. Remaining gaps

1. **Positioning fails on weak prospects** (3.85 across all ten). The fix is
   upstream — a better shortlist — not a better positioning prompt.
2. **`credibility` is the persistent email weak spot** (3.60). Some of it is
   structural: the sender is an undergraduate writing to directors, and no
   phrasing changes that.
3. **Approve/Skip is client state only.** Decisions do not persist, and approved
   drafts do not become `emails` rows.
4. **The résumé is still a hand-built fixture.** `evals/phase3/user-profile.ts`
   is the source of truth for background items — the Talent Knowledge Base does
   not exist yet.
