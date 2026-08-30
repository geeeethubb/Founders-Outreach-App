# OutreachOS — Quick User Guide

OutreachOS is my personal system for two jobs: **finding and talking to the right people**
(mentors, founders, operators) and **finding and applying to the right internships**. It
researches, drafts, ranks and tracks; I approve. Nothing is sent or submitted without me.

Two generations of the outreach side coexist: the **modern loop** (Scout → Outreach) and the
**older manual loop** (Contacts → Compose → Draft Emails). Both send from my Gmail.

---

## 1. The Core Workflows

**A. Find & contact people (modern loop)**
`Scout → prospect card → Build positioning + draft → Outreach (review) → Send → Sync replies → Interpret → Outcome`
Use when I have a goal ("winter industrial-AI project", "mentors in Chicago"). Scout searches
the people I already have first, then discovers new ones, and explains why each fits. Every
draft it writes cites real research; the Outreach page is where I approve, send, and later
read what the reply meant. To answer a reply in-thread, go to Conversations.

**B. Email someone I already know (older loop)**
`Contacts → Compose → (Draft Emails) → Send → Conversations`
Use for one-off emails to people I add by hand or LinkedIn URL. Compose writes three variants
or fills one of my Templates; multi-contact runs land in Draft Emails for review.

**C. Find internships**
`Evidence (once) → Jobs → Mission → Scout now → react to cards → Save`
Builds a ranked, verified list of Summer 2027 openings. Companies holds the watchlist the
scout checks first. Love / Not interested feedback re-ranks instantly.

**D. Prepare an application**
`Job → Generate package → review résumé diff → build documents → cover letter → Ready to apply → Open application → I applied`
For a job worth applying to. The résumé is tailored conservatively — every changed line shows
its evidence and a verifier verdict; unsupported changes keep the original. I apply on the
company's site, then mark it applied; the submitted PDFs are locked forever. *Redo package*
(job's Package tab, or the Applications row) builds a new version beside them.

**E. Keep the system honest about me**
`Evidence (résumé, facts, skills, stories, preferences) · My Profile (identity, Gmail)`
Everything the job-search agents may claim about me comes from approved Evidence rows. See §4.

---

## 2. What Each Page Does

| Page | What it's for | When I use it |
|---|---|---|
| **Dashboard** | Counters + shortcuts for the older loop (contacts, emails sent, replies). Doesn't know about Scout/Outreach. | Rarely; a rough glance. |
| **Scout** | Describe a mission → ranked prospects with why-them / why-me → build a draft per person. Can write in a campaign's voice. | Start here for any people search. Results vanish on refresh; drafts survive on Outreach. |
| **Jobs** | Ranked, verified internship postings; **What I'm scouting for** (leads the search — a pivot goes here); Scout now; Add by URL; feedback; Generate package. Mission editor lives here. | Daily triage in recruiting season. |
| **Applications** | Tracker: Saved → Applied → OA → Interview → Offer/Rejected, with notes and the exact documents submitted. | After applying or hearing back. |
| **Companies** | Watchlist (target / watching / opening available). "Check now" reads one company's board. | Add dream companies; check one board. |
| **Evidence** | The Personal Evidence Bank. **Canonical**: organization → role → facts, each with its sources. **Review**: suggested merges and conflicts. Plus experiences, bullets, facts, skills, stories, preferences with approval. | Setup; after any import (check Review); when I gain a project or skill. |
| **Outreach** | Review queue + funnel for every Scout draft: edit, approve, send, interpret replies, one follow-up suggestion, record outcome. | After every Scout run; after sends. |
| **Contacts** | Address book: add by LinkedIn URL (Apollo), bulk, or manually; older "research" summaries; add to campaigns. | To add a known person or look one up. |
| **Templates** | My own email skeletons with `[bracketed]` slots the AI fills. | When I want my wording, AI only fills the person-specific bits. |
| **Compose** | One-off email to chosen contacts: template fill or three AI variants; sends directly. | Quick email to someone I already have. |
| **Draft Emails** | Queue of older-loop drafts (Compose multi-select, Campaign generate). Edit, send, discard, approve all. | After a batch generate. **Scout drafts are not here.** |
| **Campaigns** | Group contacts under a goal; batch-generate; stats; AI feedback; paste one **reference email** that sets the voice Scout imitates. | Batches, and to teach Scout my voice. |
| **My Profile** | Name/links/bio, **Gmail connection**, and free-text career context used by the older loop's research and drafting. | Connect Gmail first; update when my targets change. |
| **Conversations** | Inbox of replies pulled from Gmail; read the thread; AI-suggested reply; **send a reply in-thread**. | To actually answer someone. |

**Key actions:** Scout → *Build positioning + draft* · Outreach → *Sync replies*, *Interpret
reply* · Jobs → *Scout now*, *Add by URL*, *Generate package* · Job detail → *Approve all safe
changes*, *Mark READY TO APPLY*, *I applied* · Evidence → *Approve all*, *Upload as master*.

---

## 3. Where Do I Go If I Want To…

- **Find new founders / mentors / operators** → Scout
- **Email one person I already have** → Contacts → Compose
- **Review and send Scout's drafts** → Outreach
- **Review batch drafts from Compose or a Campaign** → Draft Emails
- **Make Scout sound like me** → Campaigns → paste a reference email → pick it on Scout
- **See who replied / answer them** → Conversations (Outreach shows the interpretation)
- **Find internships** → Jobs → Scout now
- **Pivot what the scout looks for (e.g. into genomics)** → Jobs → What I'm scouting for → Save
- **Change cities, priorities, fit weights** → Jobs → Mission
- **Watch a company for an opening** → Companies → Add company
- **Build a résumé + cover letter for a job** → Jobs → open job → Package tab
- **See what I applied with** → Applications (documents are locked after "I applied")
- **Change what the AI knows about me** → Evidence (jobs and Scout) · My Profile (older loop, Gmail)
- **Clean up duplicate experiences after an import** → Evidence → Review
- **See what a run cost** → Jobs → footer link *Runs*

---

## 4. How the Important Pieces Connect

### Evidence vs My Profile
- **Evidence** is the source of truth for the job-search side. Every experience, bullet and fact
  carries where it came from (`Zuyu_Resume.docx ¶6`) and an *approved* flag. Fit scoring,
  evidence matching, résumé tailoring and cover letters read **only approved rows**; a claim the
  bank can't support is rejected before I see it.
- **My Profile** holds identity (name, links, bio) and the Gmail connection, plus "Career
  Context" text. That text feeds only the older loop (Contacts research scores, Compose/Campaign
  drafts). It reaches Evidence only if I tick *include profile free text* when importing.
- Scout and its drafts read Evidence too: each prospect's proof points come from my approved
  experiences and facts, ranked for that mission. Edit Evidence and the next run changes.

**How imports work.** The master résumé creates experiences and bullets (approved as-is) and
proposes facts, metrics and skills (pending until I approve). A second source — pasted LinkedIn
text, a post, notes — is kept as a source record and files its sentences under the experiences I
already have (P&G = Procter & Gamble; different roles at one organization stay separate). A
sentence repeating a known fact adds a second source to it rather than a new row. Re-importing
the same text changes nothing. When two rows *might* be one role, nothing merges by itself —
the **Review** tab shows the pair with why, what is preserved and the risk; I click *Merge* or
*Keep separate*. A merge hides the extra row and moves its facts over; nothing is deleted.

### Scout vs Contacts
Scout is **discovery**: it searches my indexed network first, then the market, and ranks.
Contacts is the **address book**: everyone stored, however they arrived. Scout's finds land in
Contacts as "discovered"; people added in Contacts aren't visible to Scout until
`npm run index:network` is re-run.

### Outreach vs Compose vs Draft Emails vs Campaigns
- **Outreach** = review queue for **Scout's** drafts (claim-checked; approve → send → track).
- **Compose** = write to a contact now; single sends go immediately, multi-select → Draft Emails.
- **Draft Emails** = the older loop's queue only. Scout drafts never appear here.
- **Campaigns** = grouping + batch generation for the older loop, and home of the **reference
  email** — which shapes Scout's drafts, not the campaign's own Generate button.

### Jobs vs Companies vs Applications
`Company (watchlist) → Opening (a Job, verified open or not) → Application (once I save/track or generate a package)`
A company can be watched with no opening. A job can be saved without an application. An
application exists once I track it or generate a package, and locks its documents at "I applied".

---

## Things That May Be Confusing

- **Two "Saved"s on Jobs**: the card's *Save* marks the job; the *Saved* application state means a tracked application. They are independent.
- **Two sync buttons**: Conversations' *Sync from Gmail* pulls replies; Outreach's *Sync replies* does that **and** updates outreach states. Run the Outreach one.
- **Campaign stats miss Scout sends**: emails sent from Scout/Outreach don't count toward a campaign, even when written in its voice.
- **Compose leaves orphans**: single-contact "Generate fresh" saves all three variants; the two unsent sit in Draft Emails, where *Approve All* would send them.
- **Preferences live in two places**: Evidence → Preferences (weights) and Jobs → Mission (the constraints and weights that gate and rank). Edit the Mission page.
- **A merged experience looks gone**: it is hidden, not deleted — its facts now sit under the surviving row, and every apply is preceded by a snapshot.
