-- 018 — the hiring argument, the role themes, and what actually changed.
--
-- Résumé Tailoring V2. The tailor now decides WHAT CASE the résumé should make
-- before it edits any text, and reports the employer's role themes with three
-- judgements each. None of that had anywhere to live: `resume_patches` carried
-- a `summary` sentence and an `edit_distance`, and edit distance is precisely
-- the wrong measure — the baseline had 32 changes at a healthy edit distance of
-- which 15 were bolding a number already in the bullet.
--
-- Additive and idempotent, like every migration here. Nothing is dropped, no
-- existing column changes type, and every V1/V2 screen keeps working: the new
-- columns are all nullable, and a patch written before this migration simply
-- has no argument recorded.

-- ─── The argument, and the themes it answers ─────────────────────────────────

alter table resume_patches
  add column if not exists hiring_argument text;

comment on column resume_patches.hiring_argument is
  'One sentence: the case this résumé makes to this employer. Decided before any text was written.';

-- [{theme, supported_by_evidence, strong_in_master, strong_after}]
alter table resume_patches
  add column if not exists role_themes jsonb not null default '[]'::jsonb;

comment on column resume_patches.role_themes is
  'What the employer is hiring for, judged three ways per theme. Coverage is computed over supported themes ONLY — counting unsupported ones would reward claiming things the evidence cannot carry.';

alter table resume_patches
  add column if not exists low_value_bullet_ids jsonb not null default '[]'::jsonb;

comment on column resume_patches.low_value_bullet_ids is
  'Bullets the tailor judged low value for this job, whether or not it changed them.';

-- ─── What changed, counted the way a reader would count it ───────────────────
--
-- Stored rather than derived because the classification depends on the bullet
-- text AT THE TIME of the patch, and bullets are editable. A patch re-counted
-- next year against today's bullets would report a different history.

alter table resume_patches
  add column if not exists meaningful_changes integer not null default 0;

comment on column resume_patches.meaningful_changes is
  'Changes that alter what the résumé argues: reorder, rewrite, swap, new, remove. Emphasis-only rewords are excluded — see cosmetic_changes.';

alter table resume_patches
  add column if not exists cosmetic_changes integer not null default 0;

comment on column resume_patches.cosmetic_changes is
  'Rewords that only moved ** emphasis markers. Allowed and cheap, but a patch made only of these has tailored nothing.';

-- Coverage over supported themes, 0–1. Null on patches written before 018.
alter table resume_patches
  add column if not exists coverage_before numeric;

alter table resume_patches
  add column if not exists coverage_after numeric;

comment on column resume_patches.coverage_before is
  'Share of evidence-supported role themes the MASTER already made well.';

comment on column resume_patches.coverage_after is
  'The same share after this patch. Tailoring should raise it wherever truthful evidence allows.';

-- ─── Did the change reach the document? ──────────────────────────────────────
--
-- The end-to-end guarantee: if the tailor reports "4 changes applied" and the
-- PDF carries master text, the package must FAIL rather than be marked ready.
-- This records the verdict per patch so the failure is auditable after the fact
-- and not only visible in the run that produced it.

alter table resume_patches
  add column if not exists applied_verified_at timestamptz;

alter table resume_patches
  add column if not exists application_failures jsonb not null default '[]'::jsonb;

comment on column resume_patches.application_failures is
  'Approved changes that did NOT appear in the rendered DOCX/PDF text. A non-empty array fails the package.';

-- Finding "which patches tailored nothing" is a question this table is now
-- asked on every acceptance report.
create index if not exists resume_patches_meaningful_idx
  on resume_patches (user_id, meaningful_changes);
