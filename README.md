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
MISSION → strategy → company discovery → company ranking
        → people discovery → people ranking → research → positioning
        → outreach → quality control → YOUR APPROVAL → send
        → response tracking → learning
```

Thirteen stages with explicit state between each one. Deterministic code does the
deterministic work (API calls, dedupe, scoring arithmetic, delivery). LLM agents do the work
requiring judgment (strategy, interpretation, research synthesis, positioning, writing).

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

**Quality gates.** Eight evaluation criteria before a draft reaches you, including a claim
accuracy check and a cringe test. Drafts that fail are revised. Drafts that still fail reach
you anyway, flagged — the system never silently discards its own failures.

---

## Documentation

| Doc | What it covers |
|---|---|
| [PRODUCT.md](docs/PRODUCT.md) | What this is, the North Star, missions, scoring, approval |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Target architecture and 12 decision records |
| [PIPELINE.md](docs/PIPELINE.md) | The 13-stage state machine, stage by stage |
| [AGENTS.md](docs/AGENTS.md) | The seven agents: inputs, outputs, boundaries |
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

**Phase 0 complete** — repository audited, V2 architecture designed and documented, type-only
scaffolding in place.

Currently shipping and usable: the V1 workflow — manual contact import, AI research, email
generation, an approval queue, Gmail sending, and reply tracking. See
[CURRENT_STATE.md](docs/CURRENT_STATE.md).

Next: Phase 1, missions and preferences. See
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
