-- Fit-based ranking: richer sender profile + per-contact fit explanation
-- Run this in the Supabase SQL Editor.

-- What the user is seeking + any extra materials, used to rank contacts by
-- fit to the sender (not by the contact's fame).
alter table profiles
  add column if not exists target_roles            text,
  add column if not exists supplementary_materials text;

-- Short "why this contact fits you" explanation generated alongside the score.
alter table contact_research
  add column if not exists fit_reason text;
