# Phase 9 — Approval, send, response tracking

The gap this closes: the system could find the right person and write them a good
email, and then the email evaporated on refresh.

`MISSION → SCOUT → RESEARCH → RANK → POSITION → DRAFT` now continues into
`APPROVE → PERSIST → SEND → TRACK → RESPOND → OUTCOME`.

---

## 1. What was reused, and what was built

The audit came first, and it changed the design. The email layer is strong and
CLAUDE.md forbids rewriting it — so the question was not "how do I send?" but
"what is the smallest thing I can add so the existing sender works for scouted
prospects?"

**Reused unchanged:** `lib/email/resend.ts` (Gmail API send, MIME, Message-ID
minting), `lib/email/accounts.ts` (encrypted tokens), `lib/google/oauth.ts`,
`lib/email/sync.ts` (Gmail polling, thread resolution, backfill, idempotent
import), `conversations`, `messages`, `emails`.

**Built:** one table, a state machine, a deterministic gate, an idempotent send
wrapper, a reply linker, two agents, and the review queue.

The payoff is concrete: **reply tracking required zero changes to the email
layer.** The send path writes an `emails` row carrying `gmail_thread_id`, which
is exactly what `syncReplies` already looks for. `lib/outreach/replies.ts` runs
afterwards and joins on that id.

---

## 2. `outreach` is a relationship, `emails` is a message

[ADR-022](ARCHITECTURE.md#adr-022). One row per (user, contact). It carries the
state machine, the positioning snapshot, the draft *and* the user's edit kept
separately, the send result, the reply, the outcome, and the analytics
dimensions.

```
draft ──▶ ready_for_review ──▶ approved ──▶ sending ──▶ sent ──▶ replied ──▶ meeting
  │              │                │            │                    │        referred
  └──▶ skipped ◀─┘                └──▶ failed ─┘                    └──▶ closed
```

Three invariants the transition table exists to hold, each with a test:

- **only `approved` reaches `sending`** — and `failed`, which is reachable only
  from `sending`, which is reachable only from `approved`
- **nothing declares itself `sent`** except the send path, out of `sending`
- **a sent draft is frozen** — no edit, no re-approval, no redraft. The stored
  text must keep matching what the recipient read, or every later answer to
  "what did we say to them" is a guess.

An edit at any earlier point drops the row back to `draft` and demands
re-approval. Approving text A must never approve text B.

---

## 3. The claim-safety gate

[ADR-023](ARCHITECTURE.md#adr-023). Deterministic, blocking, and it runs on the
text that will actually be sent — at approval and again at send, because editing
is how an unsupported claim gets back into a draft that already passed.

**Blocking** (a false negative is a lie in someone's inbox):

| kind | what it catches |
|---|---|
| quantity | money, percentages, multipliers, rankings, counts ≥10 or carrying k/M/B |
| entity | acronyms and multi-word proper nouns — the shape an invented initiative takes |
| superlative | "largest", "flagship", "first-of-its-kind" |
| responsibility | "you lead X", "your team owns Y" |

**Warning** (a false positive gets the gate switched off, and then it protects
nothing): a lone capitalised word, "most"/"best"/"top", anything genuinely
ambiguous.

Quantities are normalised before comparison, so `$3M+` matches
`$3M+ projected annual savings` and `73k` matches `73,000`. Percentages must come
from percentages — `40%` borrowed from `40 people` is a different claim wearing
the same digits.

Every blocking finding carries the sentence, the reason, and a **grounded
revision** — the figures that *are* on record, or the sentence with the
superlative removed.

### What running it taught

Five findings, four of them bugs somewhere other than the gate.

**An infinite loop, found by running not reading.** `String.replace` with a `/g/`
regex resets that regex's `lastIndex`. The superlative scanner used one object
for both scanning and rewriting, so it restarted from zero and allocated until
the process died at 4GB.

**The first run blocked 9 of 10 real drafts — and was right.** The cause was the
evidence pool, not the gate. The writer was handed proof-point *summaries*, which
omit the site name and the scale; those live on the résumé item's `org` field.
So the writer took "P&G's largest global manufacturing site" from the positioning
brief, where it is an argument, not evidence. The fix was two pools
([ADR-023](ARCHITECTURE.md#adr-023)), not a looser gate.

**A dropped backslash was shredding company facts.** The eval's evidence builder
used `/(?<=.)s+/` where it meant `/(?<=\.)\s+/`. Unescaped, the dot is "any
character" — it was splitting on the letter **s**, producing evidence lines like
`"ection the candidate already ha"`. Invisible until the gate started reading the
same pool. `lib/outreach/evidence.ts` is now the single builder for both the
writer and the gate, so the two cannot drift again.

**A 3-character prefix match let "there" ground itself against "the"**, which
waved through *"You lead the quantum photonics roadmap there."* The
responsibility check now demands an exact match against non-filler words.

**"P&G" is Procter & Gamble.** An initialism of something on record is not an
invented name. Acronyms now also match the initials of multi-word evidence names.

### Measured

| | |
|---|---|
| Real drafts cleared | **9/10** |
| Fabrications blocked | **8/8** |
| The one block | correct — "Operator Agent", a product name no research mentions |

---

## 4. Send

[ADR-024](ARCHITECTURE.md#adr-024). Five preconditions, all checked before
anything leaves: approved and unsent, recipient has an address, gate passes on
the final text, Gmail connected and the token mints, daily cap intact.

Nothing before the compare-and-swap has side effects, so failing out of any
precondition is free. After it, exactly one caller holds the row.

The `emails` row is written **before** the Gmail call, so a crash mid-send leaves
evidence rather than a silent gap, and a retry reuses that row instead of
accumulating orphans.

A failure goes to `failed` with the reason stored, never to `sent`.

---

## 5. Two agents, both suggestion-only

Neither can send. Both are bounded, neither searches, both cache.

**Conversation Agent** reads the newest inbound message and answers what happened
and what to do about it. The interesting failure it is built against is
politeness inflation: *"this sounds like interesting work, unfortunately my plate
is full"* is `NOT_NOW`, not `POSITIVE`. Classification → state is a lookup in
`states.ts`, not a judgement — the agent judges, the code computes.

**Follow-Up Agent** starts from **no**. Silence is information, and a second
email that adds nothing converts a neutral non-response into an active negative.
It may only recommend sending if it can name something the first email did not
contain. "Just following up", "circling back", "in case this got buried" and six
more are rejected in `validate()` rather than discouraged in the prompt — a draft
needing one of those is a draft with nothing new to say.

**One suggested follow-up per cold outreach**, enforced against a column, and the
counter increments on a *no* as well as a *yes*: the cap is on how many times it
is asked, or a no can be re-rolled into a yes.

Both suggestions go through the same claim gate as the original email.

### Conversation eval

14 hand-written fixtures, no judge — the ground truth is written down, so an LLM
judge would only add cost and a second opinion nobody asked for.

| | |
|---|---|
| Classification | **14/14** |
| Action | **14/14** (target ≥90%) |
| Critical misses | **0** |
| Ungrounded suggested replies | **0** |
| Cost | **$0.0009 / reply** |

**Two fixtures were corrected after the first run, which scored 86%.** Both
disagreements were my labels, not the agent:

- `resume-request` — the fixture's own note, written before the run, said
  "POSITIVE is also defensible". Scoring it wrong measured my inconsistency.
- `flat-no` — I wrote *"not hiring interns **this cycle**"* and expected
  `NO_FIT`. "This cycle" is a temporal qualifier and the agent's `NOT_NOW` was
  defensible. The **reply text** was rewritten to remove the qualifier, rather
  than the expected answer being widened — the fixture now tests fit, which is
  what it claimed to test.

Widening an expectation after seeing a result is how an eval stops measuring
anything. `alsoAcceptable` is documented as settable only from reasoning about
the reply. **The pre-correction number was 86% and is recorded here.**

---

## 6. Funnel

Deterministic arithmetic over one table. No ML — this phase's job is clean
structured data for a later Learning Agent, and the fastest way to poison that is
to start fitting things to twenty data points.

```
Prospects scouted → Drafts generated → Approved → Sent → Replies → Conversations → Opportunities
```

Broken down by segment, company type, role, angle, proof point, CTA shape and
email length. **Every rate carries its denominator, and no rate is reported below
5 sends** — a 100% reply rate on one email is the single most misleading number
this file could emit.

---

## 7. Cost

| | |
|---|---|
| Approve → Send | **$0** — no model call anywhere in the path |
| Conversation Agent | ~$0.001 per reply |
| Follow-Up Agent | ~$0.002 per suggestion |
| Pilot preparation (5 prospects) | **$0.00** — fully cached from Phase 8 |

The gate is regex and set arithmetic. The state machine is a lookup table. The
funnel is counting. Nothing on the critical path calls a model.

---

## 8. What the user can do

`/dashboard/scout` → open a prospect → **Build positioning + draft**. The draft
is persisted immediately and the card shows its state.

`/dashboard/outreach` is the review queue: everything grouped by state, the
funnel above it, and per prospect — edit, **Approve**, **Skip**, then a separate
**Send** with a confirm step. **Sync replies** pulls Gmail and links what it
finds. After a reply: **Interpret reply**, and a suggested response. Before one:
**Suggest a follow-up**. An outcome dropdown on every sent prospect.

Approve and Send are deliberately two buttons. A combined one puts the
irreversible action one mis-click from the reversible one.

---

## 9. Remaining gaps

1. **Migration 012 must be applied by hand** before any of this stores anything.
   `npm run check:outreach` says so explicitly and exits 2.
2. **The suggested reply and follow-up are copy, not sends.** They are shown for
   the user to paste into the Gmail thread. Threading a reply through the send
   path is a small addition and deliberately not in this phase.
3. **No scheduler.** `followup_due_at` is stored and displayed; nothing fires on
   it. A cron that surfaces due follow-ups is the natural next increment.
4. **The résumé is still a hand-built fixture** (`evals/phase3/user-profile.ts`).
   The two-pool design in ADR-023 makes this more pressing, not less: the gate's
   verification corpus is only as complete as that file.
