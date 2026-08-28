# Outreach OS

**An autonomous opportunity discovery and relationship-building system.**

You state a goal. Outreach OS figures out where the opportunity might be, who controls it,
why that person should care about you specifically, and what to say — then stops and asks
before anything is sent.

> "Find me a high-value winter internship or short-term project."

---

## North Star

> **Meaningful conversations with relevant decision-makers that advance your goal.**

Not emails sent. Not leads generated. Not open rate. Not how personalized something looks.

A run that surfaces 6 excellent prospects is a better run than one that surfaces 60 mediocre
ones. The system is built to be selective, and it will tell you when it found fewer good
prospects than you asked for rather than padding the list.

---

## How it works

```
MISSION → strategy → YOUR EXISTING NETWORK → is that enough?
        ├── yes → shortlist                      (no discovery spend at all)
        └── no  → company discovery → company ranking → people discovery
                → people ranking → research → merge with your network
        → positioning → outreach → quality control → YOUR APPROVAL → send
        → response tracking → learning
```

Explicit state between every stage. Deterministic code does the deterministic work (API
calls, dedupe, scoring arithmetic, delivery, and the decision about whether to spend). LLM
agents do the work requiring judgment (strategy, retrieval, interpretation, research
synthesis, positioning, writing).

**It looks at the people you already have first.** Every run searches your existing contacts
before it spends anything discovering strangers, and tells you why it did or did not go
looking further.

**Nothing cold is sent without your approval.** That is the default and it is enforced at the
database level.

Full walkthrough: [docs/PIPELINE.md](docs/PIPELINE.md)

---

## What makes it different

**Grounded research.** Every fact about a prospect carries a source URL. The database rejects
a claim typed as `FACT` without one. Every factual claim in a draft email must cite a stored
research fact — a check that resolves as a foreign key, not a matter of trusting the model.

**Selective positioning.** Your background lives in a structured Talent Knowledge Base, not a
résumé blob. For each prospect the system picks the 1–3 things that make you unusually
interesting *to that person*, and records why.

**Explainable ranking.** Six scored dimensions, each with an explanation and evidence.
Weights are configurable per mission, and re-weighting re-ranks instantly — the model judges
components, the code does the arithmetic.

**Your network, searchable by goal.** Contacts you already have are indexed once — normalized,
classified, and joined to what happened last time you wrote to them. A new goal searches them
first, and a person who is wrong for one mission stays available for the next: scores are
stored per mission, never stamped onto the person.

**Emails that sound like you.** Paste one real email into a campaign and every draft in it is
written to match — its length, its warmth, its way of asking. Not a template: no brackets, no
variables, no placeholders. The system tells you what it learned from your example, and you
can replace the example whenever the voice should change.

**Quality gates.** Eight evaluation criteria before a draft reaches you, including a claim
accuracy check and a cringe test. Drafts that fail are revised. Drafts that still fail reach
you anyway, flagged — the system never silently discards its own failures.

---

## Career OS

The same engine, pointed at Summer 2027 internships. State a mission (cities in tiers, company
types, what to optimize for); the system plans role families from your evidence, discovers real
postings through public ATS boards and a bounded web scout, verifies they are open, scores fit
along ten dimensions with an eligibility verdict, researches the company with sourced facts,
maps your evidence to the role, finds warm paths in the contacts you already have — and, on
request, builds an application package: a conservative résumé patch with an independent fact
verifier on every changed bullet, a one-page DOCX + PDF generated from your master résumé
template, and a company-specific cover letter whose every company claim resolves to a research
fact. You review the diff, approve, download, apply through the company's own link, and track
the outcome. Nothing is submitted for you.

```
Evidence   /dashboard/evidence      your facts, with provenance and approval
Jobs       /dashboard/jobs          ranked, verified openings · Scout now · Generate Package
Companies  /dashboard/companies     the watchlist: target · watching · opening available
Applications /dashboard/applications the tracker, locked documents after you apply
```

Read [docs/CAREER_OS.md](docs/CAREER_OS.md).

## Documentation

| Doc | What it covers |
|---|---|
| [PRODUCT.md](docs/PRODUCT.md) | What this is, the North Star, missions, scoring, approval |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Target architecture and 29 decision records |
| [PIPELINE.md](docs/PIPELINE.md) | The state machine, stage by stage |
| [AGENTS.md](docs/AGENTS.md) | The thirteen agents: inputs, outputs, boundaries |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | Schema, new tables, migration sequence |
| [EVALS.md](docs/EVALS.md) | Quality criteria and thresholds |
| [CURRENT_STATE.md](docs/CURRENT_STATE.md) | How the app works **today** |
| [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | The 11-phase migration |
| [BUILD_LOG.md](docs/BUILD_LOG.md) | What changed and why |
| [CLAUDE.md](CLAUDE.md) | Conventions for AI-assisted development |

Start with [PRODUCT.md](docs/PRODUCT.md) for the *what* and
[ARCHITECTURE.md](docs/ARCHITECTURE.md) for the *how*.

---

## Status

**Phase 10 complete.** Phases 0, 3, 6, 7, 8, 9 and 10 have shipped. The loop runs end to end:
state a goal, get a ranked shortlist drawn from your own network first, read why each person
is there, approve a draft, send it from your Gmail, and see the reply come back.

| | |
|---|---|
| Latest write-up | [PHASE_NETWORK_AND_REFERENCE.md](docs/PHASE_NETWORK_AND_REFERENCE.md) |
| What changed and why, per phase | [BUILD_LOG.md](docs/BUILD_LOG.md) |
| What is still V1 | [CURRENT_STATE.md](docs/CURRENT_STATE.md) |

**Two founder actions are outstanding**, and the app tells you about both:

```bash
# 1. Apply supabase/migrations/013_network_and_reference.sql in the Supabase SQL editor.
# 2. Then index the contacts you already have — once, about $1.60 for ~900 people.
npm run index:network
```

Until then the scout searches an empty network index and says so in the run log.

**Not built yet:** missions as a database object (they are run parameters today), the Talent
Knowledge Base (a fixture at `evals/phase3/user-profile.ts`), the `no_response` timer, send
pacing, and the learning surface. See
[IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

---

## Stack

Next.js 14 (App Router) · React 18 · TypeScript · Tailwind · Supabase (Postgres, Auth, RLS) ·
OpenAI · Gmail API (per-user OAuth2 for both sending and reply sync) · Apollo for contact data

---

## Setup

See [SETUP.md](SETUP.md) for first-time setup.

> **Note:** `SETUP.md` and `.env.local.example` still reference Resend, which the app no
> longer uses — it sends through each user's own Gmail via OAuth. Both are corrected in
> Phase 1. The variables actually required today are Supabase (URL, anon key, service-role
> key), `OPENAI_API_KEY`, `APOLLO_API_KEY`, the four `GOOGLE_*` OAuth values,
> `EMAIL_TOKEN_ENCRYPTION_KEY`, and `NEXT_PUBLIC_APP_URL`.

```bash
npm install
npm run dev          # http://localhost:3000
npx tsc --noEmit     # typecheck
```

Database migrations in `supabase/migrations/` are applied by hand in the Supabase SQL editor,
in numeric order.

---

## Security

- Row Level Security on every table
- Gmail refresh tokens AES-256-GCM encrypted at rest; readable only by the server's
  service-role client
- Narrow OAuth scopes — `gmail.send` and `gmail.readonly`, never full mailbox access
- All credentials from environment variables; `.env*` is gitignored

**Never commit API keys.**
