# Credential Exposure — Apollo API Key

> Status: **live exposure, awaiting founder action** · Recorded 2026-08-11

This is a factual record so nobody has to re-derive it later. **No secret value
appears in this document.**

---

## What happened

A file named `Apollo API.txt`, containing a bare 22-character Apollo API key,
was committed to this repository on 2026-05-30 in commit `e5029ca`
("feat: email template system with [placeholder] AI fill").

It was untracked and gitignored during Phase 3 (commit `47d6149`). **Untracking
removes a file from the working tree going forward; it does not remove it from
history.**

## Why it matters more than first assessed

During Phase 3 this was flagged with the caveat "if this repo has ever been
pushed anywhere". It has been. Verified on 2026-08-11:

| Check | Result |
|---|---|
| Remote configured | `https://github.com/geeeethubb/Founders-Outreach-App.git` |
| `e5029ca` is an ancestor of `origin/main` | **Yes** — the key is in pushed history |
| Repository visibility (anonymous GitHub API, HTTP 200) | **PUBLIC** |

So the key is publicly readable by anyone who clones the repository or browses
its history. Automated secret scanners crawl public GitHub continuously; assume
it has been harvested.

Consistent with that: Apollo lead credits were exhausted during Phase 3 far
faster than the eval alone should have consumed them. That is **not proof** of
abuse — five full eval runs at ~700 credits each is a sufficient explanation —
but it is a reason not to assume the key is unused.

---

## Required action — only the founder can do this

### 1. Rotate the key (urgent, and the only real fix)

Apollo dashboard → Settings → API → revoke the existing key, issue a new one,
update `APOLLO_API_KEY` in `.env.local` and in any deployment environment.

**Rotation is what ends the exposure.** Everything below is cleanup.

### 2. Decide about history rewriting

Removing the blob from history requires rewriting every commit after
`e5029ca` and force-pushing to a public repository.

**This was deliberately not done automatically**, for three reasons:

1. **Force-pushing a shared public repo is destructive and outward-facing.**
   Anyone who has cloned or forked it keeps working from the old history, and
   open PRs and branches break.
2. **It does not actually remove the secret.** GitHub retains unreachable
   objects; the blob typically stays fetchable by direct SHA until GitHub
   Support purges it on request. A rewrite that feels like remediation but
   isn't is worse than no rewrite, because it invites relaxing on rotation.
3. **Rotation makes it moot.** Once the key is dead, the exposed string is inert.

If you still want the history cleaned — reasonable for repo hygiene, and worth
doing before this becomes a portfolio piece:

```bash
# Requires: pipx install git-filter-repo
git filter-repo --path "Apollo API.txt" --invert-paths --force
git remote add origin https://github.com/geeeethubb/Founders-Outreach-App.git
git push --force --all
git push --force --tags
```

Then email GitHub Support to purge the cached unreachable objects, citing the
repository and the removed path.

### 3. Consider repository visibility

The repo is public and contains a personal résumé's worth of context in
`evals/phase3/user-profile.ts` (extracted résumé items) plus the Phase 3 and 6
eval reports, which name real prospects and their companies. None of that is
secret, but it is a public record of who you are planning to contact and why.

`my_resume.pdf` itself was untracked on 2026-08-11 and is now gitignored — but
it is present in history from commit `47d6149` onward, with a phone number.
The same rewrite decision applies.

---

## Current state of credential handling

Verified 2026-08-11 — all credentials load from the environment only:

| Source | Status |
|---|---|
| `lib/providers/apollo/client.ts` | `process.env.APOLLO_API_KEY`, throws if unset |
| `lib/providers/registry.ts` | env check only |
| `app/api/enrich/route.ts` | env only (V1 route) |
| `lib/providers/web/openai-search.ts` | `process.env.OPENAI_API_KEY` |
| Hardcoded key-shaped literals in source | **none found** |
| `.gitignore` coverage | `.env*`, `Apollo API.txt`, `*.key`, `*credentials*.json`, `*resume*.pdf` |

No secret is logged. The Apollo client sends the key only in the `X-Api-Key`
request header.
